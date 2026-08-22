import { SKIP_BOOTSTRAP } from "./const";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import webPush from "web-push";
import { DATA_DIR } from "./env";

export interface PushSubscriptionJSON {
    endpoint?: string;
    expirationTime?: EpochTimeStamp | null;
    keys?: Record<string, string>;
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
        const userSubs = Object.keys(this.subscriptions).filter(v => v.startsWith(userId + "-"));

        console.log("Sending notification to subscriptions:", userSubs);

        // TODO: Batch and use Promise.all
        for (const sub of userSubs) {
            try { await this.sendNotification(sub, data); } catch (ex) {
                console.warn("Failed to push notification to subscription:", sub, "error:", ex);
            }
        }
    }

    async broadcast(data: {
        title: string;
        message: string;
    }) {
        const userSubs = Object.keys(this.subscriptions);

        console.log("Sending notification to subscriptions:", userSubs);

        // TODO: Batch and use Promise.all
        userSubs.forEach(async (sub) => {
            try { await this.sendNotification(sub, data); } catch (ex) {
                console.warn("Failed to push notification to subscription:", sub, "error:", ex);
            }
        });
    }

    addSubscription(sub: PushSubscriptionJSON, id: string) {
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