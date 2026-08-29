/**
 * Says whether push notifications are actually set up for somebody, and if not,
 * why not.
 *
 * Being asked to turn notifications on at every start means the app cannot find
 * a subscription it believes in. There are several ways that happens and they
 * look identical from the outside:
 *
 *   1. Nothing was ever stored - the browser refused, or filing it failed.
 *   2. Something is stored, but for a different device than the one asking.
 *   3. Something is stored and reachable, and the prompt is the client's own
 *      doing rather than the server's.
 *   4. Something is stored but was created against a different VAPID key, so
 *      the push service refuses it forever and it can never be delivered to.
 *
 * The last is the cruel one: it looks exactly like working until a notification
 * is actually sent, and no amount of accepting the prompt fixes it. Only a real
 * send tells the difference, which is what --test is for.
 *
 * Run it on the server, where the subscriptions and the keys are:
 *
 *     docker compose exec app node ./build/check-user-notifications.js <id or name>
 *
 * Reads only, unless --test is passed, which sends one real notification.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { DataStore, UserDocType } from "./db";
import { DATA_DIR } from "./env";
import { apnsConfigFromEnv } from "./apns";

const SUBSCRIPTION_SUFFIX = "_notifysub.json";
const DEVICE_SUFFIX = "_apnsdevice.json";

interface StoredSubscription {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
}

function heading(text: string) {
    console.log("\n" + text);
    console.log("-".repeat(text.length));
}

function row(label: string, value: string) {
    console.log("  " + label.padEnd(18), value);
}

/** Which push service an endpoint belongs to, which decides how it behaves. */
function serviceFor(endpoint: string): string {
    if (endpoint.includes("push.apple.com"))
        return "Apple (Safari / iOS)";

    if (endpoint.includes("fcm.googleapis.com") || endpoint.includes("android.googleapis.com"))
        return "Google (Chrome / Android)";

    if (endpoint.includes("mozilla.com") || endpoint.includes("mozaws.net"))
        return "Mozilla (Firefox)";

    return "unknown";
}

async function main() {
    const args = process.argv.slice(2);
    const test = args.includes("--test");
    const identifier = args.find(v => !v.startsWith("--"));

    if (!identifier) {
        console.error(`Usage: node build/check-user-notifications.js <spotify id or display name> [--test]

  --test   send one real notification to every device on file and report what
           the push service says, which is the only way to tell a subscription
           that works from one bound to a stale key`);
        process.exit(1);
    }

    const db = new DataStore();

    await new Promise<void>(resolve => db.once("ready", resolve));

    // Id first: it is what the logs print, and a display name is not unique
    let user = await db.get<UserDocType>("users", identifier, false, true);

    if (!user) {
        const all = await db.all<UserDocType>("users");
        const matches = all.filter(v => (v.me?.displayName ?? "").toLowerCase() === identifier.toLowerCase());

        if (matches.length > 1) {
            console.error(`"${identifier}" matches ${matches.length} accounts. Use one of these IDs:`);
            matches.forEach(v => console.error("   ", v.me?.id, "-", v.me?.displayName));

            await db.shutdown();
            process.exit(1);
        }

        user = matches[0] ?? null;
    }

    if (!user) {
        console.error("No account found for:", identifier);

        await db.shutdown();
        process.exit(1);
    }

    const userId = user.meta.serviceId;

    heading("Account");
    row("id", userId);
    row("display name", user.me?.displayName ?? "(none)");

    /*
     * Whether notifications are wanted at all.
     *
     * Worth reading before anything else: a setting turned off explains both
     * symptoms at once and is the one cause that is not a fault.
     */
    const settings = await db.get<UserDocType["settings"]>("users", userId + "/settings", false, true);

    row("settings", settings ? JSON.stringify(settings) : "(none stored)");

    heading("Push keys");

    const vapid = await db.get<{ publicKey?: string; privateKey?: string }>("config", "vapid", false, true);

    if (!vapid?.publicKey) {
        console.log("  NONE - the server has no VAPID keypair, so nobody can be subscribed at all.");

        await db.shutdown();
        process.exit(1);
    }

    row("public key", vapid.publicKey);
    row("private key", vapid.privateKey ? "present" : "MISSING - nothing can be signed");

    const directory = `${DATA_DIR}/notify`;

    if (!existsSync(directory)) {
        console.log(`\n  NONE - ${directory} does not exist, so nothing has ever been filed.`);

        await db.shutdown();
        process.exit(0);
    }

    heading("The app on their phone");

    const apnsConfig = apnsConfigFromEnv();

    if (!apnsConfig) {
        console.log(`  NOT CONFIGURED - APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID are not
  all set, so the server cannot notify anybody's phone whatever is on file
  below. Browsers are unaffected.\n`);
    } else {
        row("topic", apnsConfig.bundleId);
        row("key", `${apnsConfig.keyId} (team ${apnsConfig.teamId})`);
        row("key file", existsSync(apnsConfig.keyPath) ? apnsConfig.keyPath : `MISSING at ${apnsConfig.keyPath}`);
        console.log("");
    }

    const devices = readdirSync(directory)
        .filter(f => f.endsWith(DEVICE_SUFFIX) && f.startsWith(userId + "-"))
        .map(f => {
            const id = f.slice(0, -DEVICE_SUFFIX.length);

            try {
                const { deviceToken } = JSON.parse(readFileSync(`${directory}/${f}`).toString()) as { deviceToken?: string };

                return (deviceToken ? { id, deviceToken } : null);
            } catch {
                return null;
            }
        })
        .filter((v): v is { id: string; deviceToken: string } => v !== null);

    if (devices.length === 0) {
        console.log(`  No phone registered. Expected if they only use Tempo in a browser -
  the app files a device token of its own on the launch after they agree.`);
    } else {
        console.log(`  ${devices.length} device(s):\n`);

        for (const { id, deviceToken } of devices) {
            console.log("   ", id);
            console.log("     token", deviceToken.slice(0, 16) + "…" + deviceToken.slice(-8));
            console.log("");
        }
    }

    heading("Subscriptions in a browser");

    // The id is "<userId>-<deviceId>", so the separator is what keeps one
    // person's devices from matching another's id
    const mine = readdirSync(directory)
        .filter(f => f.endsWith(SUBSCRIPTION_SUFFIX) && f.startsWith(userId + "-"));

    if (mine.length === 0) {
        console.log(`  NONE for this account.

  Nothing has been filed, so the app is right to keep asking - whatever the
  browser prompt says, the subscription never reached the server. Look at
  whether the app called /notifications/subscribe at all, and what it answered.`);

        console.log(`\n  (${readdirSync(directory).filter(f => f.endsWith(SUBSCRIPTION_SUFFIX)).length} subscription(s) on file in total, for all accounts.)`);

        if (!test || devices.length === 0) {
            await db.shutdown();
            process.exit(0);
        }
    }

    console.log(`  ${mine.length} device(s):\n`);

    const subscriptions: { id: string; sub: StoredSubscription }[] = [];

    for (const file of mine) {
        const id = file.slice(0, -SUBSCRIPTION_SUFFIX.length);

        try {
            const sub = JSON.parse(readFileSync(`${directory}/${file}`).toString()) as StoredSubscription;

            subscriptions.push({ id, sub });

            console.log("   ", id);
            console.log("     service ", sub.endpoint ? serviceFor(sub.endpoint) : "(no endpoint - unusable)");
            console.log("     endpoint", (sub.endpoint ?? "(none)").slice(0, 72) + (sub.endpoint && sub.endpoint.length > 72 ? "…" : ""));
            console.log("     keys    ", sub.keys?.p256dh && sub.keys?.auth ? "present" : "MISSING - unusable");
            console.log("");
        } catch (ex) {
            console.log("   ", id, "- could not be read:", ex);
        }
    }

    if (!test) {
        console.log(`  Stored and readable. That is as far as this can tell without sending
  one: a subscription created against an older VAPID key looks exactly like
  this and is refused only at delivery. Re-run with --test to find out.`);

        await db.shutdown();
        process.exit(0);
    }

    heading("Test send");

    // The phones first: a device that has been reinstalled is the commonest
    // reason for a notification that was accepted and never seen, and unlike a
    // browser subscription nothing but a send reveals it.
    if (devices.length > 0 && apnsConfig) {
        const { ApnsSender } = await import("./apns");
        const sender = new ApnsSender(apnsConfig);

        for (const { id, deviceToken } of devices) {
            const result = await sender.send(deviceToken, { title: "Tempo", message: "Checking notifications work." });

            if (result.ok) {
                console.log("  DELIVERED to", id, "(app)");

                continue;
            }

            console.log("  FAILED    ", id, "(app) -", result.reason);

            if (result.retired)
                console.log(`
         Apple no longer recognises this token: the app was deleted, or it was
         issued to a build signed for the other environment. It is dropped on
         the next real send and remade when they next open the app.`);
        }
    }

    if (mine.length === 0) {
        console.log("");

        await db.shutdown();
        process.exit(0);
    }

    // Imported here so a read-only run never loads it
    const webpush = await import("web-push");

    webpush.default.setVapidDetails("mailto:tempo@vihangaw.xyz", vapid.publicKey, vapid.privateKey ?? "");

    for (const { id, sub } of subscriptions) {
        try {
            await webpush.default.sendNotification(
                sub as unknown as import("web-push").PushSubscription,
                JSON.stringify({ title: "Tempo", message: "Checking notifications work." }));

            console.log("  DELIVERED to", id);
        } catch (ex) {
            const err = ex as { statusCode?: number; body?: string };
            const body = typeof err.body === "string" ? err.body.trim() : "";

            console.log("  FAILED    ", id, "-", err.statusCode ?? "no status", body.slice(0, 120));

            if (err.statusCode === 410 || err.statusCode === 404)
                console.log(`
         The push service has forgotten this subscription - the browser was
         reinstalled, or its permission reset. It should be deleted and made
         again by the client.`);

            if (err.statusCode === 400 && body.includes("VapidPkHashMismatch"))
                console.log(`
         Made against a different VAPID key than the server now signs with.
         This can never be delivered to and the client must subscribe again -
         which is also why accepting the prompt each time changes nothing.`);

            if (err.statusCode === 403)
                console.log(`
         Refused. Usually the same story as above: the key this was created
         against is not the key being signed with now.`);
        }
    }

    console.log("");

    await db.shutdown();
    process.exit(0);
}

main().catch(async ex => {
    console.error("Check failed:", ex);
    process.exit(1);
});
