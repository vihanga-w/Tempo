import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import webPush from "web-push";

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
        const vapidKeysRaw = readFileSync(".vapid").toString().split(".");
        
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
    }

    private loadSubscriptions() {
        if (!existsSync("./notify/"))
            mkdirSync("./notify/");

        const files = readdirSync("./notify/");

        const valid = files.filter(v => v.endsWith("_notifysub.json"));

        for (const f of valid) {
            try {
                const data = JSON.parse(readFileSync(`./notify/${f}`).toString()) as PushSubscriptionJSON;

                this.subscriptions[f.split("_notifysub.json")[1]] = data;
            } catch (ex) {
                console.warn("Failed to load notification handler sub from \"./notify/" + f + "\"");
            }
        }
    }

    notifyUser(userId: string, data: {
        title: string;
        message: string;
    }) {
        const userSubs = Object.keys(this.subscriptions).filter(v => v.startsWith(userId + "-"));

        for (const sub of userSubs) {
            try { this.sendNotification(sub, data); } catch (ex) {
                console.warn("Failed to push notification to subscription:", sub, "error:", ex);
            }
        }
    }

    addSubscription(sub: PushSubscriptionJSON, id: string) {
        if (!existsSync("./notify/"))
            mkdirSync("./notify/");

        writeFileSync(`./notify/${id}_notifysub.json`, JSON.stringify(sub));

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