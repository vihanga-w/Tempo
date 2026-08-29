import { connect, constants, ClientHttp2Session } from "node:http2";
import { existsSync, readFileSync } from "node:fs";

import jwt from "jsonwebtoken";
import { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_PATH } from "./env";

/**
 * Sending notifications to the app on somebody's phone.
 *
 * The web push everything else here uses cannot reach it. Apple only offers the
 * Push API to Safari and to web apps added to the home screen; inside the
 * WKWebView an installed app runs in, it does not exist - so the app has no
 * subscription to give, and its notifications have to come from Apple directly.
 *
 * Nothing new is needed to talk to APNs: it is an HTTP/2 request signed with a
 * key from the developer account, and Node can do both. The alternative was a
 * dependency to write one header.
 */

/** Apple rejects a token minted more often than once every 20 minutes. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

const PRODUCTION_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";

export interface ApnsConfig {
    keyId: string;
    teamId: string;
    /** The app's bundle id, which APNs calls the topic. */
    bundleId: string;
    /** The .p8 downloaded from the developer account. */
    keyPath: string;
}

export type ApnsResult =
    | { ok: true }
    | { ok: false; retired: true; reason: string }
    | { ok: false; retired: false; reason: string };

/**
 * A build signed for development gets a token only the sandbox knows, and a
 * build from TestFlight or the App Store gets one only production knows -
 * indistinguishable by looking at them.
 *
 * So rather than configure which, both are tried: whichever answered for a
 * token is remembered, and the other is only reached for again if that stops
 * being true. Getting it wrong costs one wasted request and a retry, and
 * guessing wrong permanently costs every notification that device should
 * have had.
 */
const environmentForToken: { [deviceToken: string]: "production" | "sandbox" } = {};

export class ApnsSender {
    private config: ApnsConfig;
    private key: string;
    private token?: { value: string; mintedAt: number };
    private sessions: { [host: string]: ClientHttp2Session } = {};

    constructor(config: ApnsConfig) {
        this.config = config;

        if (!existsSync(config.keyPath))
            throw new Error(`APNs key not found at ${config.keyPath}`);

        this.key = readFileSync(config.keyPath, "utf8");
    }

    /**
     * The bearer token APNs wants, reused until it is old.
     *
     * Minting one per notification is the documented way to be rate limited by
     * Apple, which answers 429 and stops accepting them for a while.
     */
    private bearer(): string {
        const now = Date.now();

        if (this.token && now - this.token.mintedAt < TOKEN_LIFETIME_MS)
            return this.token.value;

        const value = jwt.sign({ iss: this.config.teamId, iat: Math.floor(now / 1000) }, this.key, {
            algorithm: "ES256",
            header: { alg: "ES256", kid: this.config.keyId },
        });

        this.token = { value, mintedAt: now };

        return value;
    }

    /** One connection per host, reopened when Apple closes an idle one. */
    private session(host: string): ClientHttp2Session {
        const existing = this.sessions[host];

        if (existing && !existing.closed && !existing.destroyed)
            return existing;

        const session = connect(host);

        session.on("error", () => { delete this.sessions[host]; });
        session.on("close", () => { delete this.sessions[host]; });

        this.sessions[host] = session;

        return session;
    }

    private post(host: string, deviceToken: string, payload: string): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            let request;

            try {
                request = this.session(host).request({
                    [constants.HTTP2_HEADER_METHOD]: "POST",
                    [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
                    authorization: `bearer ${this.bearer()}`,
                    "apns-topic": this.config.bundleId,
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                    "content-type": "application/json",
                });
            } catch (ex) {
                reject(ex);

                return;
            }

            let status = 0;
            let body = "";

            request.setEncoding("utf8");
            request.on("response", (headers) => { status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0); });
            request.on("data", (chunk) => { body += chunk; });
            request.on("error", reject);
            request.on("end", () => resolve({ status, body }));

            request.end(payload);
        });
    }

    /**
     * @returns whether it arrived, and when it did not, whether this device is
     *          gone for good. A token Apple has stopped recognising is retired
     *          rather than retried: it will never work again, and left in place
     *          it is one more failing request on every notification forever.
     */
    async send(deviceToken: string, data: { title: string; message: string }): Promise<ApnsResult> {
        const payload = JSON.stringify({
            aps: {
                alert: { title: data.title, body: data.message },
                sound: "default",
            },
        });

        const known = environmentForToken[deviceToken];
        const order: ("production" | "sandbox")[] = known
            ? [known, known === "production" ? "sandbox" : "production"]
            : ["production", "sandbox"];

        let last = "";

        for (const environment of order) {
            const host = environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST;

            let answer: { status: number; body: string };

            try {
                answer = await this.post(host, deviceToken, payload);
            } catch (ex) {
                last = String(ex);

                continue;
            }

            if (answer.status === 200) {
                environmentForToken[deviceToken] = environment;

                return { ok: true };
            }

            const reason = (() => {
                try {
                    return (JSON.parse(answer.body) as { reason?: string }).reason ?? answer.body;
                } catch {
                    return answer.body;
                }
            })();

            last = `${answer.status} ${reason}`;

            // Apple saying this token belongs to the other environment is the
            // one failure worth immediately trying again for
            if (reason === "BadEnvironmentKeyInToken" || reason === "BadDeviceToken")
                continue;

            // Gone for good: the app was removed, or the token replaced
            if (answer.status === 410 || reason === "Unregistered")
                return { ok: false, retired: true, reason: last };

            return { ok: false, retired: false, reason: last };
        }

        // Refused by both, so the token is not for this app at all
        delete environmentForToken[deviceToken];

        return { ok: false, retired: true, reason: last };
    }
}

/**
 * Reads the configuration, or explains what is missing.
 *
 * Returns nothing when push to the app has simply not been set up, which is a
 * perfectly ordinary state and not a fault - everything else carries on.
 */
export function apnsConfigFromEnv(env: {
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    APNS_BUNDLE_ID?: string;
    APNS_KEY_PATH?: string;
} = {
    APNS_KEY_ID,
    APNS_TEAM_ID,
    APNS_BUNDLE_ID,
    APNS_KEY_PATH,
}): ApnsConfig | undefined {
    const keyId = env.APNS_KEY_ID?.trim();
    const teamId = env.APNS_TEAM_ID?.trim();
    const bundleId = env.APNS_BUNDLE_ID?.trim();

    if (!keyId || !teamId || !bundleId)
        return undefined;

    return {
        keyId,
        teamId,
        bundleId,
        keyPath: env.APNS_KEY_PATH?.trim() || `./keys/AuthKey_${keyId}.p8`,
    };
}
