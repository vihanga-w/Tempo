import { SKIP_BOOTSTRAP } from "./const";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import webPush from "web-push";
import { DATA_DIR, VAPID_SUBJECT } from "./env";
import { ApnsSender } from "./apns";

// Type-only: db.ts pulls in recap-scheduler, which imports this module. Importing
// the class as a value would close that cycle at runtime.
import type { DataStore } from "./db";

export interface PushSubscriptionJSON {
    endpoint?: string;
    expirationTime?: EpochTimeStamp | null;
    keys?: Record<string, string>;
}

interface VapidKeypair {
    private: string;
    public: string;
}

/** Collection and document the keypair lives in. */
/** What a phone's registration is filed under, beside the web ones. */
const DEVICE_SUFFIX = "_apnsdevice.json";

const VAPID_COLLECTION = "config";
const VAPID_DOCUMENT = "vapid";

/** Pre-Mongo location, still read once so an existing deployment keeps its key. */
const LEGACY_VAPID_PATH = `${DATA_DIR}/.vapid`;

/**
 * Subscription ids become filenames, so they are constrained to characters that
 * cannot escape the notify directory. The id is always `<userId>-<deviceId>`,
 * and both halves are server-derived or server-validated before reaching here.
 */
const SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9]+-[A-Za-z0-9]{4,64}$/;

export function isValidSubscriptionId(id: string): boolean {
    return SUBSCRIPTION_ID_PATTERN.test(id);
}

/**
 * True when the push service is saying this subscription was created against a
 * different VAPID key than the one we are signing with.
 *
 * A subscription is bound to the application server key the browser passed at
 * subscribe time, so once the two diverge that endpoint can never be pushed to
 * again — no amount of retrying helps, and the client has to re-subscribe.
 * Apple answers 400 with a VapidPkHashMismatch reason; Chrome/FCM and Mozilla
 * answer 403 UnauthorizedRegistration.
 */
function isVapidKeyMismatch(reason: unknown): boolean {
    const err = reason as { statusCode?: number; body?: string } | undefined;

    if (!err)
        return false;

    const body = (typeof err.body === "string" ? err.body : "");

    if (err.statusCode === 400)
        return body.includes("VapidPkHashMismatch");

    if (err.statusCode === 403)
        return (body.includes("UnauthorizedRegistration") || body.includes("VAPID") || body === "");

    return false;
}

export class NotificationHandler {
    private db: DataStore;
    private vapid: VapidKeypair | null = null;
    private subscriptions: {[key: string]: PushSubscriptionJSON};
    /**
     * Phones, which are reached a different way.
     *
     * The installed app has no push subscription to give - Apple does not offer
     * the Push API inside the webview it runs in - so it hands over a device
     * token and Apple delivers on our behalf. Kept beside the web subscriptions
     * and keyed the same way, so notifying somebody means all of their devices
     * without every caller having to know there are two kinds.
     */
    private devices: {[key: string]: string} = {};
    private apns?: ApnsSender;

    /** Resolves once the keypair is loaded and web-push is configured. */
    private ready: Promise<void>;

    constructor(db: DataStore) {
        this.db = db;
        this.subscriptions = {};

        // The keypair now lives in the database, so loading it is asynchronous.
        // Construction stays synchronous — every send awaits this first.
        this.ready = this.loadVapidKeys()
            .catch(ex => {
                console.error("Failed to load the VAPID keypair — push notifications are disabled for this run:", ex);
            });

        if (SKIP_BOOTSTRAP) {
            console.log("Skipped notification handler bootstrap due to SKIP_BOOTSTRAP flag (VAPID available, existing subscriptions unavailable)");
            return;
        }

        console.log("Loading existing notification subscriptions");

        this.loadSubscriptions();
        this.loadDevices();
    }

    /**
     * Fetches the keypair from the database, creating it on first run.
     *
     * It used to be a file under DATA_DIR. That made the key an artefact of one
     * machine's disk: containerising the API moved DATA_DIR onto a fresh volume,
     * the file was absent, a new pair was generated, and every subscription
     * created against the old key started failing with VapidPkHashMismatch.
     * Keeping it beside the rest of the state it has to agree with — the
     * subscriptions, the users — means a rebuilt host cannot silently rotate it.
     */
    private async loadVapidKeys() {
        const stored = await this.db.get<{ publicKey?: string; privateKey?: string }>(
            VAPID_COLLECTION,
            VAPID_DOCUMENT,
        );

        if (stored?.publicKey && stored?.privateKey) {
            this.applyVapidKeys({ public: stored.publicKey, private: stored.privateKey });

            return;
        }

        const migrated = this.readLegacyVapidFile();

        if (migrated) {
            console.log("Migrating the VAPID keypair from", LEGACY_VAPID_PATH, "into the database");
        } else {
            console.log("No VAPID keypair found, generating one.");
            console.log("Existing push subscriptions will not work with a new keypair and must be re-created.");
        }

        const keys = migrated ?? (() => {
            const generated = webPush.generateVAPIDKeys();

            return { public: generated.publicKey, private: generated.privateKey };
        })();

        await this.db.set(VAPID_COLLECTION, VAPID_DOCUMENT, {
            publicKey: keys.public,
            privateKey: keys.private,
            createdAt: Date.now(),
            migratedFromDisk: (migrated !== null),
        });

        // Read back rather than trusting the write: if a second instance booted
        // against the same database at the same moment, both generated a pair and
        // only one of them survived. Whoever loses here adopts the winner's key
        // instead of signing with a pair the database does not hold.
        const confirmed = await this.db.get<{ publicKey?: string; privateKey?: string }>(
            VAPID_COLLECTION,
            VAPID_DOCUMENT,
        );

        if (confirmed?.publicKey && confirmed?.privateKey)
            this.applyVapidKeys({ public: confirmed.publicKey, private: confirmed.privateKey });
        else
            this.applyVapidKeys(keys);
    }

    /** Reads the pre-Mongo `<public>.<private>` file, or null if it is absent or malformed. */
    private readLegacyVapidFile(): VapidKeypair | null {
        if (!existsSync(LEGACY_VAPID_PATH))
            return null;

        try {
            const parts = readFileSync(LEGACY_VAPID_PATH).toString().trim().split(".");

            if (parts.length !== 2 || !parts[0] || !parts[1])
                return null;

            return { public: parts[0], private: parts[1] };
        } catch (ex) {
            console.warn("Failed to read the legacy VAPID file at", LEGACY_VAPID_PATH, "error:", ex);

            return null;
        }
    }

    private applyVapidKeys(keys: VapidKeypair) {
        // Configure web-push first: it validates the pair, and a malformed one
        // should leave the handler with no key at all rather than a key it is
        // not actually signing with.
        webPush.setVapidDetails(
            VAPID_SUBJECT,
            keys.public,
            keys.private,
        );

        this.vapid = keys;
    }

    /**
     * The application server key clients must subscribe with.
     *
     * Served to the client rather than hardcoded there: a hardcoded copy is the
     * other half of the same failure the database move fixes, since it silently
     * stops matching the moment the server key changes.
     */
    async getPublicKey(): Promise<string | null> {
        await this.ready;

        return this.vapid?.public ?? null;
    }

    /** Turns on delivery to phones, if the account has been set up for it. */
    useApns(sender: ApnsSender) {
        this.apns = sender;
    }

    /** @returns the ids this person has a phone registered under. */
    deviceIdsFor(userId: string): string[] {
        return Object.keys(this.devices).filter(v => v.startsWith(userId + "-"));
    }

    registerDevice(id: string, deviceToken: string) {
        if (!isValidSubscriptionId(id))
            throw new Error("Invalid device id");

        // One phone, one record. The device half of the id is minted fresh on
        // every registration, so the same token would otherwise pile up a
        // record per launch and be notified once per copy.
        for (const existing of Object.keys(this.devices)) {
            if (existing !== id && this.devices[existing] === deviceToken)
                this.removeDevice(existing);
        }

        if (!existsSync(`${DATA_DIR}/notify/`))
            mkdirSync(`${DATA_DIR}/notify/`);

        writeFileSync(`${DATA_DIR}/notify/${id}${DEVICE_SUFFIX}`, JSON.stringify({ deviceToken }));

        this.devices[id] = deviceToken;
    }

    removeDevice(id: string) {
        try {
            if (existsSync(`${DATA_DIR}/notify/${id}${DEVICE_SUFFIX}`))
                rmSync(`${DATA_DIR}/notify/${id}${DEVICE_SUFFIX}`);
        } catch (ex) {
            console.warn("Failed to remove device registration:", id, "error:", ex);
        }

        delete this.devices[id];
    }

    private loadDevices() {
        if (!existsSync(`${DATA_DIR}/notify/`))
            return;

        for (const f of readdirSync(`${DATA_DIR}/notify/`).filter(v => v.endsWith(DEVICE_SUFFIX))) {
            try {
                const data = JSON.parse(readFileSync(`${DATA_DIR}/notify/${f}`).toString()) as { deviceToken?: string };
                const id = f.split(DEVICE_SUFFIX)[0];

                if (!data.deviceToken)
                    continue;

                this.devices[id] = data.deviceToken;

                console.log("Loaded device registration:", id);
            } catch {
                console.warn(`Failed to load device registration from "${DATA_DIR}/notify/${f}"`);
            }
        }
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
        await this.sendToDevices(this.deviceIdsFor(userId), data);

        return this._send(Object.keys(this.subscriptions).filter(v => v.startsWith(userId + "-")), data);
    }

    async broadcast(data: {
        title: string;
        message: string;
    }) {
        await this.sendToDevices(Object.keys(this.devices), data);

        return this._send(Object.keys(this.subscriptions), data);
    }

    /**
     * Delivers to phones, and retires the ones Apple says are gone.
     *
     * Same reasoning as the web subscriptions below: a token for an app that
     * has been deleted is refused forever, and kept it becomes one more failing
     * request on every notification from here on.
     */
    private async sendToDevices(ids: string[], data: { title: string; message: string }) {
        if (ids.length === 0)
            return;

        if (!this.apns) {
            console.warn("Dropping notification for", ids.length, "device(s): push to the app is not set up");

            return;
        }

        console.log("Sending notification to devices:", ids);

        await Promise.all(ids.map(async (id) => {
            const result = await this.apns!.send(this.devices[id], data);

            if (result.ok)
                return;

            if (result.retired) {
                console.log("Dropping device Apple no longer recognises:", id, `(${result.reason})`);

                this.removeDevice(id);

                return;
            }

            console.warn("Failed to notify device:", id, "reason:", result.reason);
        }));
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

        await this.ready;

        if (!this.vapid) {
            console.warn("Dropping notification for", subIds.length, "subscription(s): no VAPID keypair is loaded");

            return;
        }

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

            // Bound to a key we no longer hold, so it is as dead as a 410. Kept
            // it would fail on every notification forever; dropped, the client
            // re-subscribes with the current key next time it opens.
            if (isVapidKeyMismatch(result.reason)) {
                console.log("Dropping push subscription created against a different VAPID key:", sub, `(${status})`);
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

        // One device, one record. The device half of the id is minted fresh each
        // time a client registers, so the same endpoint otherwise accumulates a
        // record per registration and every notification is delivered once per
        // copy — the same push, several times over, to one device.
        if (sub.endpoint) {
            for (const existingId of Object.keys(this.subscriptions)) {
                if (existingId === id || this.subscriptions[existingId]?.endpoint !== sub.endpoint)
                    continue;

                console.log("Replacing an earlier subscription for the same endpoint:", existingId, "->", id);

                this.removeSubscription(existingId);
            }
        }

        if (!existsSync(`${DATA_DIR}/notify/`))
            mkdirSync(`${DATA_DIR}/notify/`);

        writeFileSync(`${DATA_DIR}/notify/${id}_notifysub.json`, JSON.stringify(sub));

        this.subscriptions[id] = sub;
    }

    async sendNotification(subId: string, data: {
        title: string;
        message: string;
    }) {
        await this.ready;

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
