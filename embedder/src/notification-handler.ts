import { SKIP_BOOTSTRAP } from "./const";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import webPush from "web-push";
import { DATA_DIR } from "./env";

export interface PushSubscriptionJSON {
    endpoint?: string;
    expirationTime?: EpochTimeStamp | null;
    keys?: Record<string, string>;
}

/**
 * Subscription ids become filenames, so they are constrained to characters that
 * cannot escape the notify directory. The id is always `<userId>-<deviceId>`,
 * and both halves are server-derived or server-validated before reaching here.
 */
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9]+-[A-Za-z0-9]{4,64}$/;

export function isValidSubscriptionId(id: string): boolean {
    return SUBSCRIPTION_ID_PATTERN.test(id);
}

export class NotificationHandler {
    private vapid: {
        private: string;
        public: string;
    };
    private subscriptions: {[key: string]: PushSubscriptionJSON};

    constructor() {
        // Load the VAPID keypair
        const vapidPath = `${DATA_DIR}/.vapid`;

        // Generate on first boot rather than crashing, mirroring how the JWT and
        // database keypairs bootstrap themselves
        if (!existsSync(vapidPath)) {
            const generated = webPush.generateVAPIDKeys();

            writeFileSync(vapidPath, `${generated.publicKey}.${generated.privateKey}`);

            console.log("Generated a new VAPID keypair at", vapidPath);
            console.log("Existing push subscriptions will not work with a new keypair and must be re-created.");
        }

        const vapidKeysRaw = readFileSync(vapidPath).toString().replace("\n", "").split(".");
        
        this.vapid = {
            private: vapidKeysRaw[1],
            public: vapidKeysRaw[0],
        };
        this.subscriptions = {};

        webPush.setVapidDetails(
            "https://tempo-music.co/contact",
            this.vapid.public,
            this.vapid.private,
        );

        if (SKIP_BOOTSTRAP) {
            console.log("Skipped notification handler bootstrap due to SKIP_BOOTSTRAP flag (VAPID available, existing subscriptions unavailable)");
            return;
        }

        console.log("Loading existing notification subscriptions");

        this.loadSubscriptions();
    }

    private loadSubscriptions() {
        if (!existsSync(`${DATA_DIR}/notify/`))
            mkdirSync(`${DATA_DIR}/notify/`);

        const files = readdirSync(`${DATA_DIR}/notify/`);

        const valid = files.filter(v => v.endsWith("_notifysub.json"));

        for (const f of valid) {
            try {
                const data = JSON.parse(readFileSync(`${DATA_DIR}/notify/${f}`).toString()) as PushSubscriptionJSON;
                const id = f.split("_notifysub.json")[0];

                this.subscriptions[id] = data;

                console.log("Loaded notification subscription:", id);
            } catch (ex) {
                console.warn(`Failed to load notification handler sub from "${DATA_DIR}/notify/${f}"`);
            }
        }
    }

    async notifyUser(userId: string, data: {
        title: string;
        message: string;
    }) {
        // The id is `<userId>-<deviceId>`, so the separator is what stops a user
        // whose id is a prefix of another's from receiving their notifications
        return this._send(Object.keys(this.subscriptions).filter(v => v.startsWith(userId + "-")), data);
    }

    async broadcast(data: {
        title: string;
        message: string;
    }) {
        return this._send(Object.keys(this.subscriptions), data);
    }

    /**
     * Sends to many subscriptions at once, retiring the ones the push service
     * says are gone.
     *
     * Push endpoints expire whenever a browser is reinstalled, a PWA is removed
     * or a subscription is revoked, and the service then answers 404/410
     * permanently. Left in place those dead entries are retried on every single
     * notification forever, so a broadcast slowly turns into a pile of failing
     * requests against endpoints that will never come back.
     */
    private async _send(subIds: string[], data: {
        title: string;
        message: string;
    }) {
        if (subIds.length === 0)
            return;

        console.log("Sending notification to subscriptions:", subIds);

        const results = await Promise.allSettled(subIds.map(sub => this.sendNotification(sub, data)));

        results.forEach((result, i) => {
            if (result.status === "fulfilled")
                return;

            const sub = subIds[i];
            const status = (result.reason as { statusCode?: number })?.statusCode;

            if (status === 404 || status === 410) {
                console.log("Dropping expired push subscription:", sub, `(${status})`);
                this.removeSubscription(sub);

                return;
            }

            // Anything else (network blip, 5xx) may recover, so it is kept
            console.warn("Failed to push notification to subscription:", sub, "error:", result.reason);
        });
    }

    /** Forgets a subscription, in memory and on disk. */
    removeSubscription(id: string) {
        delete this.subscriptions[id];

        if (!isValidSubscriptionId(id))
            return;

        try {
            rmSync(`${DATA_DIR}/notify/${id}_notifysub.json`, { force: true });
        } catch (ex) {
            console.warn("Failed to delete stored subscription:", id, "error:", ex);
        }
    }

    addSubscription(sub: PushSubscriptionJSON, id: string) {
        // Defence in depth: the id is interpolated into a path, so reject
        // anything that is not a plain `<userId>-<deviceId>` pair even though
        // the route already derives the user half from the auth token
        if (!isValidSubscriptionId(id))
            throw new Error("Refusing to store a subscription under an unsafe id: " + id);

        if (!existsSync(`${DATA_DIR}/notify/`))
            mkdirSync(`${DATA_DIR}/notify/`);

        writeFileSync(`${DATA_DIR}/notify/${id}_notifysub.json`, JSON.stringify(sub));

        this.subscriptions[id] = sub;
    }

    async sendNotification(subId: string, data: {
        title: string;
        message: string;
    }) {
        const sub = this.subscriptions[subId];

        if (!sub)
            throw new Error("Subscription not found with id: " + subId);

        if (!sub.endpoint) {
            throw new Error("Subscription endpoint is missing");
        }

        const res = await webPush.sendNotification(sub as webPush.PushSubscription, JSON.stringify(data));

        console.log("webPush status:", res.statusCode);

        return true;
    }
}