/**
 * Checks whether an account's stored Spotify credentials actually work.
 *
 * A bring-your-own-app account has three separate things that can be wrong, and
 * a failure in any of them looks identical from the app — sign-in simply never
 * completes. They have to be told apart before anything can be fixed:
 *
 *   1. The client ID and secret. Wrong, mismatched, or from two different apps.
 *   2. The redirect URI. Spotify refuses the authorise step outright when this
 *      deployment's callback is not registered on the app, so the person never
 *      reaches consent and no callback ever arrives at the server. Nothing is
 *      logged here, because nothing reached us.
 *   3. The user allowlist. A Spotify app in development mode only admits the
 *      accounts listed under User Management, and everyone else gets a 403 on
 *      /v1/me *after* consenting.
 *
 * Only the first two can be tested without the person present; the third needs
 * their consent to reach a token, so it is reported as unknown rather than
 * guessed at.
 *
 * Run it on the server, where the database and the credentials already are:
 *
 *     docker compose exec app node ./build/check-user-creds.js <id or name>
 *
 * Read-only against the database unless --reset-app is passed, which forgets
 * the Spotify app saved against the account and nothing else. Makes at most
 * three requests to Spotify.
 */

import { DataStore, UserDocType } from "./db";
import {
    SPOTIFY_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET,
    SPOTIFY_REDIRECT_URI,
} from "./env";

/**
 * Enough of the secret to compare two copies by eye, and not enough to use.
 *
 * The whole point of running this is often to check whether the secret on the
 * account is the one someone pasted, which needs the ends visible.
 */
function maskSecret(secret: string, show: boolean): string {
    if (show)
        return secret;

    if (secret.length <= 8)
        return "(too short to be a real secret: " + secret.length + " chars)";

    return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

function heading(text: string) {
    console.log("\n" + text);
    console.log("-".repeat(text.length));
}

function row(label: string, value: string) {
    console.log("  " + label.padEnd(16), value);
}

/**
 * Does this pair of credentials belong to a real, working Spotify app?
 *
 * client_credentials needs no user, so it isolates the app from everything
 * about the person — if this fails, nothing else can succeed.
 */
async function checkCredentials(clientId: string, clientSecret: string) {
    let res: Response;

    try {
        res = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
        });
    } catch (ex) {
        console.log("  UNREACHABLE — could not reach Spotify:", ex);

        return false;
    }

    if (res.ok) {
        console.log("  PASS — Spotify issued a token, so this app and secret are valid.");

        return true;
    }

    const body = await res.text();

    console.log("  FAIL — Spotify returned", res.status);
    console.log("        ", body.trim());

    if (body.includes("invalid_client"))
        console.log(`
         This is the same error the sign-in exchange reports. Either the secret
         does not belong to this client ID, or the app has been deleted. Both
         are fixed by generating a fresh secret in the Spotify dashboard and
         re-entering the pair.`);

    return false;
}

/**
 * Reports the redirect URI that has to be registered, and checks what little
 * can be checked from here.
 *
 * This deliberately does not claim to verify it. Spotify answers an authorise
 * request with a redirect to its login page *before* looking at the client ID or
 * the redirect URI at all — a made-up client ID gets the same 303 as a real one,
 * so treating that redirect as proof would report a thoroughly broken app as
 * healthy. Validation happens after the person logs in, which needs the person.
 *
 * So: a definite rejection is worth reporting if one comes back, and anything
 * else is reported as unknown rather than passed.
 */
async function checkRedirectUri(clientId: string): Promise<"rejected" | "unknown"> {
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: SPOTIFY_REDIRECT_URI,
        state: "credential-check",
    });

    let body = "";

    try {
        const res = await fetch(`https://accounts.spotify.com/authorize?${params.toString()}`, {
            redirect: "manual",
        });

        body = await res.text();
    } catch {
        // Nothing to report either way; the credential check above already says
        // whether Spotify is reachable
    }

    if (body.includes("Invalid redirect URI") || body.includes("Invalid client")) {
        console.log("  FAIL — Spotify rejected the authorise request outright.");
        console.log("        ", body.slice(0, 200).replace(/\s+/g, " ").trim());

        return "rejected";
    }

    console.log(`  CANNOT BE CHECKED FROM HERE — Spotify only validates this once the
  person has logged in, so it has to be confirmed by eye.

  App ${clientId} must have exactly this redirect URI saved:

      ${SPOTIFY_REDIRECT_URI}

  Open the app in the Spotify dashboard, check Settings, and add it if it is
  missing. It must match character for character, trailing slash included.

  This is worth ruling out whenever sign-in appears to stall: Spotify shows an
  error page in place of the consent screen, so no callback ever reaches Tempo
  and the failure leaves no trace in the server logs. In the logs it looks
  identical to someone closing the tab.`);

    return "unknown";
}

/**
 * Does the stored refresh token still work?
 *
 * Off by default because it spends the token: Spotify may return a replacement
 * and this script has no business writing one back, so an account that is
 * working fine is left alone unless asked for.
 */
async function checkRefreshToken(clientId: string, clientSecret: string, refreshToken: string) {
    let res: Response;

    try {
        res = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
            }),
        });
    } catch (ex) {
        console.log("  UNREACHABLE — could not reach Spotify:", ex);

        return false;
    }

    if (!res.ok) {
        console.log("  FAIL — Spotify returned", res.status, (await res.text()).trim());

        return false;
    }

    const body = await res.json() as { access_token?: string };

    if (!body.access_token) {
        console.log("  FAIL — Spotify returned no access token.");

        return false;
    }

    // Proves the token is accepted by the API and not merely well-formed
    const me = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: "Bearer " + body.access_token },
    });

    if (me.status === 403) {
        console.log("  FAIL — the token works but Spotify returned 403 for /v1/me.");
        console.log(`
         The app is in development mode and this person is not on its allowlist.
         Add them under User Management in the Spotify dashboard, using the email
         on their Spotify account.`);

        return false;
    }

    if (!me.ok) {
        console.log("  FAIL — /v1/me returned", me.status, (await me.text()).trim());

        return false;
    }

    const who = await me.json() as { id?: string; display_name?: string };

    console.log("  PASS — refreshed and read", who.display_name || who.id, `(${who.id}).`);

    return true;
}

async function main() {
    const args = process.argv.slice(2);
    const showSecret = args.includes("--show-secret");
    const testRefresh = args.includes("--test-refresh");
    const resetApp = args.includes("--reset-app");
    const identifier = args.find(v => !v.startsWith("--"));

    if (!identifier) {
        console.error(`Usage: node build/check-user-creds.js <spotify id or display name> [--test-refresh] [--show-secret] [--reset-app]

  --test-refresh   also spend the stored refresh token to prove it still works
  --show-secret    print the client secret in full rather than masked
  --reset-app      forget the Spotify app saved against this account, so it
                   falls back to Tempo's own. For an account left naming an app
                   that has been deleted. Writes nothing else - history, taste
                   profiles, streaks and friends are untouched.`);
        process.exit(1);
    }

    const db = new DataStore();

    await new Promise<void>(resolve => db.once("ready", resolve));

    // Try the ID first: it is what the logs print, and a display name is not
    // unique, so an ID that also happens to match somebody's name must win
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

    const clientId = user.serverCreds?.clientId || SPOTIFY_CLIENT_ID;
    const clientSecret = user.serverCreds?.clientSecret || SPOTIFY_CLIENT_SECRET;
    // What matters is which app will be used, not whether a copy happens to be
    // stored on the account - accounts enrolled before bring-your-own-app
    // existed have Tempo's own credentials written into that field
    const byo = (clientId !== SPOTIFY_CLIENT_ID);

    heading("Account");
    row("id", user.me?.id ?? "(none)");
    row("display name", user.me?.displayName ?? "(none)");
    row("state", user.meta?.state ?? "(none)");
    row("access token", user.data?.accessToken ? "stored" : "none stored");
    row("refresh token", user.data?.refreshToken ? "stored" : "none stored");

    if (user.meta?.state === "unauth")
        console.log(`
  This account was created by enrolment and never finished signing in. The
  checks below say whether it can: enrolment stores the credentials, and the
  sign-in that should immediately follow is what did not complete.`);

    heading("Credentials");
    row("source", byo
        ? "the account's own Spotify app"
        : (user.serverCreds?.clientId ? "Tempo's shared app (stored on the account)" : "Tempo's shared app (nothing stored)"));
    row("client id", clientId);
    row("secret", maskSecret(clientSecret, showSecret));

    if (!byo)
        console.log(`
  Tempo's own app is in development mode, so it only admits the handful of
  accounts listed under User Management. Anyone beyond that has to enrol with an
  app of their own - which is what /connect-spotify sets up.`);

    heading("1. Do the credentials work?");
    const credsOk = await checkCredentials(clientId, clientSecret);

    heading("2. The redirect URI");
    const redirect = await checkRedirectUri(clientId);

    let refreshOk: boolean | undefined;

    if (testRefresh && user.data?.refreshToken) {
        heading("3. Does the stored refresh token still work?");
        refreshOk = await checkRefreshToken(clientId, clientSecret, user.data.refreshToken);
    }

    heading("Verdict");

    if (!credsOk) {
        console.log("  The credentials themselves are rejected. Nothing can work until they are replaced.");
    } else if (redirect === "rejected") {
        console.log(`  The credentials are fine, but sign-in cannot start - Spotify refuses the
  authorise request. Fix the redirect URI above.`);
    } else if (refreshOk === false) {
        console.log("  The app is fine; the stored token is not. This account needs to sign in again.");
    } else {
        console.log(`  The credentials work${refreshOk ? " and so does the stored token" : ""}.

  Two things remain that cannot be tested without the person, and either one
  produces a sign-in that never completes:

    - the redirect URI above, which Spotify checks only after they log in
    - User Management, if the app is in development mode. It admits only the
      Spotify accounts listed there and refuses everyone else after consent.`);
    }

    if (resetApp) {
        heading("Forgetting the saved app");

        if (!user.serverCreds?.clientId) {
            console.log("  Nothing to do - this account already uses Tempo's own app.");
        } else {
            // Written as empty rather than removed, and by path rather than by
            // replacing the document: everything else on the record - history,
            // taste, streaks, friends, tokens - has to survive this untouched.
            await db.set<UserDocType["serverCreds"]>("users", `${user.meta.serviceId}/serverCreds`, {
                clientId: "",
                clientSecret: "",
            });

            console.log("  Forgot", user.serverCreds.clientId + ".", "This account now uses Tempo's own app.");
            console.log(`
  If the stored refresh token was issued by Tempo's app - which is the case
  when somebody deleted their own app and signed in again afterwards - it
  starts working again as soon as the server rebuilds its session, so restart
  the app container. If it was issued by the deleted app it cannot be
  refreshed by anything, and they will be asked to sign in once.`);
        }
    }

    console.log("");

    await db.shutdown();

    // The store keeps a cache-sweep interval alive, which would otherwise hold
    // the process open long after the check has printed everything it has
    process.exit(0);
}

main().catch(async ex => {
    console.error("Check failed:", ex);
    process.exit(1);
});
