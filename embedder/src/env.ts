/**
 * Central configuration.
 *
 * Values come from the environment. In development a `.env` file at the service
 * root is loaded automatically; in Docker the values arrive via `env_file` in
 * compose.yaml, so no `.env` is present in the image and the load is skipped.
 *
 * Nothing in here has a secret default. If a required value is missing the
 * process exits at startup with a message naming it, rather than failing later
 * with a confusing 400 from Spotify.
 */

import { mkdirSync } from "fs";
import { join } from "path";

// Node >= 21.7 can read a .env file without a dependency. Absent file is fine.
try {
    process.loadEnvFile();
} catch {
    // No .env on disk — expected in Docker, where compose supplies the values.
}

const missing: string[] = [];

function required(name: string): string {
    const value = process.env[name];

    if (!value) {
        missing.push(name);

        return "";
    }

    return value;
}

function optional(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

function boolean(name: string, fallback: boolean): boolean {
    const value = process.env[name];

    if (value === undefined || value === "")
        return fallback;

    return (value === "1" || value.toLowerCase() === "true");
}

export const NODE_ENV = optional("NODE_ENV", "development");
export const IS_PRODUCTION = (NODE_ENV === "production");

/** Public origin of this API, used to build redirect URIs. No trailing slash. */
export const BASE_URL = required("BASE_URL").replace(/\/+$/, "");

/** Public origin of the web app, used for post-auth redirects. No trailing slash. */
export const WEB_APP_URL = required("WEB_APP_URL").replace(/\/+$/, "");

export const SPOTIFY_CLIENT_ID = required("SPOTIFY_CLIENT_ID");
export const SPOTIFY_CLIENT_SECRET = required("SPOTIFY_CLIENT_SECRET");
export const SPOTIFY_REDIRECT_URI = BASE_URL + "/spotify/callback";

/**
 * Domain the auth cookie is scoped to, e.g. ".vihangaw.xyz" — the parent the
 * API and the web app share, since a cookie scoped to either host alone is not
 * readable by the other.
 *
 * Optional. Leave it unset for local development: RFC 6265 forbids an IP
 * address in the Domain attribute, so a cookie scoped to "127.0.0.1" is simply
 * dropped by the browser. Unset means a host-only cookie, which is what you
 * want on a loopback address.
 */
export const COOKIE_DOMAIN = process.env["COOKIE_DOMAIN"] || undefined;

/** Comma-separated list of origins permitted by CORS. */
export const ALLOWED_ORIGINS = required("ALLOWED_ORIGINS")
    .split(",")
    .map(v => v.trim())
    .filter(v => v !== "");

/**
 * YouTube Data API key, used only to find music videos to play behind friends'
 * listening activity.
 *
 * Optional. Without it MUSIC_VIDEO_ENABLED is false, /audio/musicvideo answers
 * 404 for everything, and the client falls back to no background video — a path
 * it already handles.
 */
export const YOUTUBE_API_KEY = process.env["YOUTUBE_API_KEY"] || undefined;

/**
 * Explicit off switch, so the feature can be disabled while a key is still
 * configured. The feature is on only when both the key exists and this is unset
 * or true.
 */
export const MUSIC_VIDEO_ENABLED = (YOUTUBE_API_KEY !== undefined) && boolean("MUSIC_VIDEO_ENABLED", true);

// Cloudflare R2 — album art and profile pictures. Create an R2 API token with
// Object Read & Write on the bucket.

/**
 * Full S3 API endpoint for the bucket, taken verbatim rather than derived from
 * the account id, because the host differs per jurisdiction:
 *
 *   default  https://<account>.r2.cloudflarestorage.com
 *   EU       https://<account>.eu.r2.cloudflarestorage.com
 */
export const R2_ENDPOINT = required("R2_ENDPOINT").replace(/\/+$/, "");
export const R2_ACCESS_KEY_ID = required("R2_ACCESS_KEY_ID");
export const R2_SECRET_ACCESS_KEY = required("R2_SECRET_ACCESS_KEY");
export const R2_BUCKET = required("R2_BUCKET");

/**
 * Public origin the bucket is served from, e.g. https://img.vihangaw.xyz or
 * an r2.dev subdomain. Optional: while it is unset the API streams image bytes
 * from R2 itself. Setting it switches to a redirect, so R2 serves the bytes and
 * the API drops out of the path entirely — do that once public access is on.
 *
 * This must be a public bucket URL, never the S3 API endpoint, which requires
 * signed requests and would 401 for browsers.
 */
export const R2_PUBLIC_URL = (process.env["R2_PUBLIC_URL"] || "").replace(/\/+$/, "") || undefined;

if (R2_PUBLIC_URL && R2_PUBLIC_URL.includes("r2.cloudflarestorage.com")) {
    console.warn("R2_PUBLIC_URL looks like the S3 API endpoint, which browsers cannot read. Leave it unset until a public bucket URL or custom domain is available.");
}

/**
 * The `sub` claim on every VAPID JWT: who a push service should contact about
 * these notifications. Must be a mailto: or an http(s) URL.
 *
 * Defaults to the web app's own origin, so it follows the deployment instead of
 * naming a hardcoded domain the service may no longer be hosted on.
 */
export const VAPID_SUBJECT = optional("VAPID_SUBJECT", WEB_APP_URL);

export const MONGODB_URI = required("MONGODB_URI");
export const MONGODB_DB = optional("MONGODB_DB", "tempo");

export const PORT = parseInt(optional("PORT", "2246"), 10);

/**
 * Root for everything kept on disk: taste profiles, song metadata, recaps,
 * notification subscriptions and streak backups. The VAPID keypair used to live
 * here too and is now in the database, so a rebuilt volume cannot rotate it.
 *
 * Defaults to /tempodb, which is where the Docker volume mounts, so containers
 * are unaffected. Override it to run the server natively — macOS has a
 * read-only root filesystem, so /tempodb cannot be created there.
 */
export const DATA_DIR = optional("TEMPO_DATA_DIR", "/tempodb").replace(/\/+$/, "");

/**
 * Song and album embeddings, used for recommendations.
 *
 * Off by default. Discovery is hidden in the client, so nothing reads them, and
 * loading them at boot walks the whole index and warns once per file it cannot
 * find — pages of it on a deployment that has no embeddings volume populated.
 * Turn it back on when discovery returns.
 */
export const EMBEDDINGS_ENABLED = boolean("EMBEDDINGS_ENABLED", false);

// System states
export const VERBOSE_MODE = boolean("VERBOSE_MODE", false);
export const SKIP_BOOTSTRAP = boolean("SKIP_BOOTSTRAP", false);

/**
 * Development-only auth bypass. Forced off in production regardless of what the
 * environment says, so a stray value in a deployed env file cannot disable
 * authentication.
 */
/**
 * Seeds a synthetic friend who is permanently "listening", so the friends list
 * and live playback UI can be exercised without a second real Spotify account.
 * Forced off in production.
 */
export const DEV_FAKE_FRIEND = (!IS_PRODUCTION && boolean("DEV_FAKE_FRIEND", false));

export const BYPASS_AUTH = (!IS_PRODUCTION && boolean("BYPASS_AUTH", false));

/**
 * Subdirectories the server writes into. Several call sites assume these exist
 * (saveTasteProfile writes straight into data/tastes, for instance), which was
 * fine when the Docker volume was pre-populated and is not on a fresh machine.
 */
const DATA_SUBDIRS = [
    "data/tastes",
    "streaks",
    "song-data-cache",
    "recaps",
    "notify",
    "album-embeddings",
    "music-video-cache",
];

function ensureDataDirs() {
    for (const dir of DATA_SUBDIRS)
        mkdirSync(join(DATA_DIR, dir), { recursive: true });
}

// Runs at module load, not from an entrypoint: several modules touch the data
// directory in their own module bodies, which execute before any entrypoint
// code. env.ts is imported (directly or via const.ts) by all of them, so this is
// the earliest point that reliably runs first.
ensureDataDirs();

if (missing.length > 0) {
    console.error("\n------ Missing configuration ------");
    console.error("The following environment variables are required but were not set:\n");

    missing.forEach(v => console.error("  - " + v));

    console.error("\nCopy .env.example to .env and fill it in, or supply these via compose.");
    console.error("-----------------------------------\n");

    process.exit(1);
}

if (!MUSIC_VIDEO_ENABLED)
    console.log("Music video backgrounds are disabled" + (YOUTUBE_API_KEY === undefined ? " (no YOUTUBE_API_KEY set)" : " (MUSIC_VIDEO_ENABLED=false)"));

if (BYPASS_AUTH)
    console.warn("\n!!! BYPASS_AUTH is enabled — every request is treated as an authenticated fake user. Development only. !!!\n");
