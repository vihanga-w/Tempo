import "./copyright-message";
import {
    SKIP_BOOTSTRAP,
    VERBOSE_MODE
} from "./const";

function syncWait(ms: number) {
    if (VERBOSE_MODE)
        console.warn("Using syncWait for", ms, "ms (it is not recommended to use syncWait in production code as it blocks the event loop!");

    const start = Date.now();

    while (Date.now() - start < ms) {
        // Busy wait
    }

    if (VERBOSE_MODE)
        console.warn("syncWait completed after", Date.now() - start, "ms");
}

if (SKIP_BOOTSTRAP) {
    syncWait(250);

    console.warn("\n------ Skip Bootstrap Mode Enabled ------");
    console.warn("SKIP_BOOTSTRAP is set, skipping bootstrap process\n");
    console.warn("=> Existing user authentication sessions will not be scanned");
    console.warn("=> Song embeddings will not be processed");
    console.warn("=> Album embeddings will not be processed");
    console.warn("=> Notification subscriptions will not be processed");
    console.warn("=> The API and database will still be available");
    console.warn("\nThis mode is intended for development purposes only and may lead to unexpected behavior in production!");
    console.warn("\nServer will continue startup in 1 seconds");
    console.warn("-----------------------------------------\n");

    syncWait(1e3);
}

declare global {
    interface Console {
        verbose: (level: "log" | "warn" | "error" | "perf", ...data: any[]) => {
            timed: (...data: any) => void;
        };
    }
}

console.verbose = (level: "log" | "warn" | "error" | "perf", ...data: any) => {
    let timeStart = -1;

    if (VERBOSE_MODE) {
        // data == "<perfId>", "<...data>" (so min 2 elements)
        if (level === "perf" && (data.length < 2 || typeof data[0] !== "string")) {
            console.warn("[VERBOSE] Attempted to start a performance measurement without a valid ID or insufficient data length. Expected at least 2 elements with the first being a string ID.");
        } else {
            if (level === "log" || level === "perf")
                console.log(`[VERBOSE]${level === "perf" ? " [PerfId:" + (data[0] as string) + ":START]" : ""}`, ...data.slice(level === "perf" ? 1 : 0));
            else if (level === "warn")
                console.warn("[VERBOSE]", ...data);
            else if (level === "error")
                console.error("[VERBOSE]", ...data);
            else
                console.error("[VERBOSE]", "Invalid log level:", level, "data:", data);

            if (level == "perf") {
                timeStart = Date.now();
            }
        }
    }

    return {
        timed: (...timedData: any) => {
            if (level !== "perf" || !VERBOSE_MODE || timeStart === -1)
                return;

            const timeEnd = Date.now();
            const elapsed = timeEnd - timeStart;

            console.log(`[VERBOSE] [PerfId:${(timedData[0] as string)}:END] [${elapsed}ms]`, ...timedData);
        }
    };
};

const irmVerb = console.verbose("perf", "irm", "Importing required modules...");

import { otherSideOf, rankFriendSuggestions } from "./friend-suggestions";
import SpotifyWebApi from "spotify-web-api-node";
import { existsSync, mkdirSync, readdirSync, readFileSync, stat, unlinkSync, writeFileSync } from "fs";
import express, { Response, Request } from "express";
import expressWs from "express-ws";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { slowDown } from 'express-slow-down';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID } from "crypto";
import EventEmitter from "events";
import { Mutex } from "async-mutex";
import { clearInterval } from "timers";
import { distance } from 'fastest-levenshtein';
import objectHash from "object-hash";

// Local imports
import {
    BASE_URL,
    WEB_APP_URL,
    COOKIE_DOMAIN,
    ALLOWED_ORIGINS,
    PORT,
    SPOTIFY_CLIENT_ID as SPOT_CLIENT_ID,
    SPOTIFY_CLIENT_SECRET as SPOT_CLIENT_SECRET,
    SPOTIFY_REDIRECT_URI as SPOT_REDIRECT_URI,
    SIMULATE_UNLISTED_IDS,
    BYPASS_AUTH,
    IS_PRODUCTION,
    DEV_FAKE_FRIEND,
    DATA_DIR,
} from "./env";
import {
    FAKE_FRIEND_ID,
    buildFakeFriendDocument,
    buildFakePlaybackState,
    seedFakeFriendData,
    acceptPendingFakeFriendRequests,
    removeFakeFriendData,
} from "./dev-fake-friend";
import { DailyListenership, Taste, UserListenership, UserTaste, setTasteStore } from "./user-taste";
import { getMyCurrentPlayingTrack, refreshSpotifyToken } from "./spotify-methods";
import { ApnsSender, apnsConfigFromEnv } from "./apns";
import { NotificationHandler } from "./notification-handler";
import { evaluateStreakLoss } from "./streak-loss";
import { classifyPlaybackTransition } from "./playback-transition";
import { isRestorable, migrateStreaksFromDisk, MongoStreakStore, StreakFile } from "./streak-store";
import { deriveStreak, playedTracksFromHistory } from "./streak-derivation";
import { migrateTasteProfiles, MongoTasteStore, TasteFile, TASTE_SIZE_WARN_BYTES } from "./taste-store";
import { newReconciliationState, ReconciliationState, recordReconciliation, recordSongEvent, shouldReconcile } from "./history-reconciliation";
import { buildLeaderboard, LeaderboardCandidate } from "./leaderboard";
import { buildDigest, Standing } from "./leaderboard-digest";
import { DataStore, TasteDocType, UserDocType } from "./db";
import { WebSocket } from "ws";
import { SongData, SongDataCache } from "./song-data-cache";
import { TempoTokenType, Token } from "./jwtauth";
import { alphaMergedSimilarity, combinedSimilarity, euclideanDistance } from "./similarity";
import { Recap, UserListenershipRecapScheduler } from "./recap-scheduler";
import { FeedItem, getUserFeed } from "./feed";
// import { sampleRandomEmbedding } from "./user-taste";
import { getPreviewWithISRC } from "./deezer-helper";
import { findMusicVideo } from "./find-music-video";
import { describeSizeLimits, ensureVariant, isValidImageId, parseSize, publicUrlFor, readVariant } from "./image-store";
import { computeColourBlob, isValidColourBlob } from "./profile-blob";

irmVerb.timed("Imported required modules");

interface StreakSave {
    honorId: string;
    userId: string;
    playSessionStart: number;
}

/**
 * Scopes requested during Spotify authorisation.
 *
 * Shared by both authorize URLs below. They had drifted: the enrollment callback
 * path sent an empty scope, so a newly enrolled user came back with a token that
 * could not read playback at all — which is the entire point of the app.
 */
export const SPOTIFY_SCOPES = [
    "user-read-playback-state",
    "user-read-currently-playing",
    "user-read-private",
    "user-read-email",
    // Play history, which is the only way to see listening that happened while
    // Tempo was not watching — offline, or on a device it never polled. A token
    // carries the scopes it was granted at authorisation and refreshing does not
    // add any, so accounts authorised before this was requested will not have it
    // until they authorise again. Nothing may assume it is present.
    "user-read-recently-played",
].join(" ");

/** Whether an account's token was granted a scope, from what Spotify returned. */
export function tokenHasScope(scope: string, granted?: string): boolean {
    return (granted ?? "").split(" ").includes(scope);
}

/**
 * @param clientId a user's own Spotify app, when they are enrolling with their
 *                 own credentials. Defaults to Tempo's app.
 */
function buildSpotifyAuthorizeUrl(state: string, clientId?: string) {
    const params = new URLSearchParams({
        client_id: clientId || SPOT_CLIENT_ID,
        response_type: "code",
        redirect_uri: SPOT_REDIRECT_URI,
        scope: SPOTIFY_SCOPES,
        state,
    });

    return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

const STREAK_BAK_META_PATH = `${DATA_DIR}/streaks/`;
const EXPECTED_ALERT_VERSION: UserDocType["meta"]["priorityFYPAlerts"][0]["metaAlertVersion"] = "r";
// Bumping this broadcasts a push notification to every subscriber at startup and
// shows the notice below once per user
const APP_UI_VERSION = 22;
const APP_UI_NOTICE: {
    title: string,
    text: string[],
    primaryButtonText?: string;
    secondaryButtonText?: string;
    secondaryButtonPage?: string;
    /**
     * Send the reader back through sign-in once they have read this.
     *
     * Set when a release needs something only a fresh authorisation can give — a
     * widened Spotify scope, which an existing token can never gain by being
     * refreshed. Served per account rather than as written: anyone who has
     * already granted it has nothing to do, and a consent screen for no reason is
     * worse than not asking.
     */
    reauth?: boolean;
    /** Appended to the text above, for the accounts the ask still applies to. */
    reauthText?: string[];
    /** What to push when this version first goes out. */
    broadcast?: { title: string; message: string };
} = {
    title: "Your profile, rebuilt",
    text: [
        "Your profile is now built around what you are playing. There is a record on it, and it turns at the speed a real one would — 33⅓ rpm, in time with the track, so it is wherever the song has got to.",
        "",
        "The page takes its colours from the sleeve you are listening to, and no two records look alike: the grooves are laid out from the track itself.",
        "",
        "Your week now comes with something to measure it against, too — whether that is the shortest war in history or every episode of Stranger Things.",
    ],
    primaryButtonText: "Have a look",
    // No secondary action, to match the shape of the notice before it: one way
    // out of a modal is enough, and the profile is a tap away regardless.
    //
    // No reauth either — nothing here needs a permission Spotify has not already
    // given, so nobody is sent back through sign-in for a change to a page.
    reauth: false,
    broadcast: {
        title: "🎧 Your profile has a record player",
        message: "It spins in time with whatever you are playing.",
    },
};

console.log("APP_UI_VERSION:", APP_UI_VERSION);
console.log("(APP_UI_VERSION is indicative of application ecosystem version)");

const initVerb = console.verbose("perf", "initGlob", "Initializing global classes");

const db = new DataStore();
const songMetaCache = new SongDataCache();
const tempoToken = new Token(db);
const notify = new NotificationHandler(db);

// Web push cannot reach an installed iOS app, so the same notifications go out
// over Apple's service as well. Unconfigured is a normal state: the server then
// notifies browsers only, and says so once rather than on every send.
const apns = apnsConfigFromEnv();

if (apns) {
    notify.useApns(new ApnsSender(apns));

    console.log("Push to the app is enabled for", apns.bundleId);
} else {
    console.log("Push to the app is not configured (set APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID)");
}
const streakStore = new MongoStreakStore(db);
const tasteStore = new MongoTasteStore(db);

setTasteStore(tasteStore);
const recapScheduler = new UserListenershipRecapScheduler(db, songMetaCache, notify);

initVerb.timed("Initialized global classes");

const updateChkVerb = console.verbose("perf", "updtChk", "Processing application version actions");

if (!existsSync(`${DATA_DIR}/.lastknownappversion`))
    writeFileSync(`${DATA_DIR}/.lastknownappversion`, "0");

const lastKnownAppVersion = parseInt(readFileSync(`${DATA_DIR}/.lastknownappversion`).toString());

if (lastKnownAppVersion < APP_UI_VERSION) {
    console.log("Updating app version to", APP_UI_VERSION);

    writeFileSync(`${DATA_DIR}/.lastknownappversion`, APP_UI_VERSION.toString());

    notify.broadcast(APP_UI_NOTICE.broadcast ?? {
        title: "✨ Tempo. Update",
        message: "Tempo has been updated, open the app to see what's new!",
    });
}

updateChkVerb.timed("Processed application version actions");

interface AuthSession {
    me?: any;
    /**
     * The tokens Spotify just granted.
     *
     * Kept because an account that is already signed in still needs them: it is
     * the only way a re-authorisation can take effect, and a scope added after
     * they first enrolled can reach them no other way.
     */
    grantedAuth?: {
        accessToken: string;
        refreshToken: string;
        expires: number;
        scope: string;
        tokenType: string;
    };
    successRedirect?: string;
    errorRedirect?: string;
    cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean, cb?: (state: string) => void) => Promise<void>;
    enroll?: boolean;
    useServerCreds?: boolean;
    /**
     * The Spotify app this particular sign-in belongs to.
     *
     * Held on the session because the session is the one thing that lives for
     * exactly as long as the flow does. The authorise redirect and the code
     * exchange have to name the same app or Spotify answers invalid_client, and
     * they used to read that from two different places with two different
     * lifetimes - a ten-minute memo for the redirect, a closure for the
     * exchange. Anything that outlived the memo but not the session (a restart
     * mid-sign-in, a link opened later) silently downgraded the redirect to
     * Tempo's app while the exchange still presented the user's.
     */
    byoCreds?: { clientId: string; clientSecret: string };
    username?: string;
    rTimeout: NodeJS.Timeout;
    remove: () => void;
};

interface SongStatistic {
    totalListenCount: number;
    completeListenCount: number;
    averageSessionDuration: number;
    totalSessionDuration: number;
    skipCount: number;
    replayCount: number;
}

interface PlaybackState {
    userId: string;
    songId: string;
    albumId: string;
    progressNormal: number;
    isPlaying: boolean;
    timeRemaining: number;
    duration: number;
    /** Random value regenerated per song, so server and client agree on which
     *  display variant (e.g. which fact) to show for this playback. */
    displaySeed: number;
    playSessionStart: number;
    imageUrl: string;
    pfpUrl: string;
    /** See profile-blob.ts — drawn until pfpUrl loads, so there is no gap. */
    pfpColourBlob?: string;
    username: string;
    explicit: boolean;
    replayCount: number;
    name: string;
    artists: {
        name: string;
        url: string;
    }[];
    updatedAt: number;
    lastEventSentAt: number;
    todayStats: SongStatistic;
    mediaType: "track" | "episode" | "ad" | "unknown";
};
interface Monitor {
    u: User;
    nosies: {
        requesterdId: string;
        id: string;
        cb: ((data: {
            state?: PlaybackState;
            action: string;
        }) => void);
    }[];
    lastPlaySessionStart: number;
    socketCloseOverride?: () => Promise<void>;
};

let authSessions: {[key: string]: AuthSession} = {};
let userSessions: Monitor[] = [];
let appRateLimit: number = 0;
let appRateLimitExpiry: number = 0;
let appPerfText: string = "";
let appRateLimitUnlockTimeout: NodeJS.Timeout | undefined;
let appRateLimitPriority: "warn" | "block" = "warn";
let flagServerShutdown = false;
let globalSpotifyAPIRequestCount = 0;
let globalSpotifyAPIRequestCounter = 0;
let globalSpotifyAPIRequestHistory: { timestamp: number; count: number }[] = [];
let sessionListenerStateHooks: {[key: string]: {
    currentTargets: string[];
    hook: () => void;
}} = {};

/**
 * Streaks carried over from the last run, consumed by the User constructor as
 * each session is built and emptied as they are claimed.
 */
let previousStreaks: {[key: string]: number} = {};

if (!existsSync(STREAK_BAK_META_PATH))
    mkdirSync(STREAK_BAK_META_PATH);

/**
 * Reads whatever streak files are still on disk.
 *
 * Only ever finds anything on the first boot after the move to the database, or
 * on a later one if something previously failed to migrate.
 */
function readStreakFiles(): StreakFile[] {
    try {
        return readdirSync(STREAK_BAK_META_PATH).map(name => {
            const path = STREAK_BAK_META_PATH + name;

            try {
                const data = JSON.parse(readFileSync(path).toString()) as StreakSave;

                return { userId: data.userId, playSessionStart: data.playSessionStart, path };
            } catch (ex) {
                console.warn("Skipping unreadable streak file", path, "error:", ex);

                return null;
            }
        }).filter(v => v !== null) as StreakFile[];
    } catch (ex) {
        console.warn("Failed to list streak files in", STREAK_BAK_META_PATH, "error:", ex);

        return [];
    }
}

const TASTE_DIR = `${DATA_DIR}/data/tastes/`;

/**
 * Reads whatever taste profiles are still on disk.
 *
 * Only finds anything on the first boot after the move to the database, or a
 * later one if something previously failed to migrate.
 */
function readTasteFiles(): TasteFile[] {
    if (!existsSync(TASTE_DIR))
        return [];

    try {
        return readdirSync(TASTE_DIR).filter(v => v.endsWith(".json")).map(name => {
            const path = TASTE_DIR + name;

            try {
                const raw = readFileSync(path).toString();

                return {
                    userId: name.slice(0, -".json".length),
                    taste: JSON.parse(raw) as UserTaste,
                    path,
                    bytes: Buffer.byteLength(raw),
                };
            } catch (ex) {
                console.warn("Skipping unreadable taste profile", path, "error:", ex);

                return null;
            }
        }).filter(v => v !== null) as TasteFile[];
    } catch (ex) {
        console.warn("Failed to list taste profiles in", TASTE_DIR, "error:", ex);

        return [];
    }
}

/**
 * Moves taste profiles into the database, once.
 *
 * A profile is months of listening with no second copy anywhere, so each one is
 * written, read back and compared before its file is removed. Anything that
 * cannot be verified keeps its file and is reported, and running again picks it
 * back up.
 */
async function migrateTasteProfilesFromDisk() {
    const files = readTasteFiles();

    if (files.length === 0)
        return;

    console.log("Migrating", files.length, "taste profile(s) into the database");

    const report = await migrateTasteProfiles({
        files,
        store: tasteStore,
        removeFile: path => { try { unlinkSync(path); } catch { } },
    });

    for (const result of report.results) {
        if (result.oversized)
            console.warn("Taste profile for", result.userId, "is over", Math.round(TASTE_SIZE_WARN_BYTES / 1024 / 1024) + "MB - history will need splitting out before it reaches the 16MB document limit");

        if (result.outcome === "imported" || result.outcome === "already-present")
            continue;

        console.warn("Taste migration kept the file for", result.userId, "-", result.outcome);
    }

    console.log("Taste migration: imported", report.imported + ",", "removed", report.removed + " file(s),", report.failed, "left in place");
}

/**
 * Brings streaks in from the database, migrating any left on disk first.
 *
 * Has to finish before scanAuthorisedUsers, since the User constructor reads
 * previousStreaks as each session is built.
 */
async function loadPreviousStreaks() {
    const loadStrkVerb = console.verbose("perf", "ldStrk", "Loading previous streaks");

    const files = readStreakFiles();

    if (files.length > 0) {
        console.log("Migrating", files.length, "streak file(s) into the database");

        const report = await migrateStreaksFromDisk({
            files,
            store: streakStore,
            // Removed only once the record has been written and read back, so a
            // write that silently failed cannot take the only copy with it
            removeFile: path => { try { unlinkSync(path); } catch { } },
            now: Date.now(),
        });

        for (const result of report.results) {
            if (result.outcome === "imported" || result.outcome === "already-present")
                continue;

            console.warn("Streak migration kept the file for", result.userId, "-", result.outcome);
        }

        console.log("Streak migration: imported", report.imported + ",", "removed", report.removed + " file(s),", report.failed, "left in place");
    }

    try {
        const stored = await streakStore.all();
        const now = Date.now();

        for (const record of stored) {
            if (!isRestorable(record, now)) {
                // Nothing has touched it in long enough that the run is over by
                // the ten minute rule regardless
                await streakStore.remove(record.userId);

                continue;
            }

            previousStreaks[record.userId] = record.playSessionStart;

            console.log("Loaded previous streak for user", record.userId, "playSessionStart:", record.playSessionStart);
        }
    } catch (ex) {
        console.warn("Failed to load previous streaks from the database:", ex);
    }

    loadStrkVerb.timed("Loaded previous streaks");
}


const loadStatVerb = console.verbose("perf", "ldSAPIStat", "Loading Spotify API request statistics from disk");

const HISTORY_FILE_PATH = "globalSpotifyAPIRequestHistory.json";

// Load history from disk on startup
if (existsSync(HISTORY_FILE_PATH)) {
    try {
        const savedHistory = JSON.parse(readFileSync(HISTORY_FILE_PATH, "utf-8"));
        globalSpotifyAPIRequestHistory = Array.isArray(savedHistory) ? savedHistory : [];
    } catch (error) {
        console.error("Failed to load globalSpotifyAPIRequestHistory from disk:", error);
    }
}

loadStatVerb.timed("Loaded Spotify API request statistics from disk");

const rlMutex = new Mutex();

setInterval(() => {
    const timestamp = Date.now();

    globalSpotifyAPIRequestHistory.push({ timestamp, count: globalSpotifyAPIRequestCount });

    // Keep only the last 24 hours of data
    const twentyFourHoursAgo = timestamp - 24 * 3600 * 1000;
    globalSpotifyAPIRequestHistory = globalSpotifyAPIRequestHistory.filter(entry => entry.timestamp >= twentyFourHoursAgo);

    try {
        writeFileSync(HISTORY_FILE_PATH, JSON.stringify(globalSpotifyAPIRequestHistory, null, 2));
    } catch (error) {
        console.error("Failed to save globalSpotifyAPIRequestHistory to disk:", error);
    }

}, 10e3);

function incrementRequestCount() {
    globalSpotifyAPIRequestCounter++;
}

async function updateRateLimit(limit: number) {
    await rlMutex.runExclusive(() => {
        console.verbose("log", "Updating rate limit to", limit, "seconds");

        if (appRateLimit == 0 && limit == 0) {
            console.verbose("log", "Rate limit is already cleared, no action needed.");
            return;
        }

        // Make sure we wait full duration of rate limit
        if (limit !== 0 && limit < appRateLimit) {
            console.verbose("log", "New rate limit is lower than current, ignoring update to", limit, "seconds");
            return;
        }

        appRateLimit = limit;

        const expectedResolution = new Date(Date.now() + (limit * 1e3) + 5e3);

        appRateLimitExpiry = expectedResolution.getTime();

        console.verbose("log", "New rate limit set to", limit, "seconds");
        console.verbose("log", "Expected rate limit resolution by:", expectedResolution.toString());

        // We have been issued a long running rate limit, mark app as degraded performance
        if (limit > 90) {
            console.warn("Detected a long Spotify rate limit, limit:", limit, "expected resolution by:", expectedResolution.toString());

            let warningText = "Tempo is experiencing degraded performance";
            appRateLimitPriority = "warn";

            if (limit >= (60 * 10)) {
                warningText = "Tempo is experiencing issues, we will be back soon!";
                appRateLimitPriority = "block";
            }

            appPerfText = warningText;
        } else if (limit > 0) {
            console.warn("Detected a short Spotify rate limit, limit:", limit, "expected resolution by:", expectedResolution.toString());
        } else {
            console.verbose("log", "Rate limit cleared");
            appPerfText = "";
        }

        if (appRateLimitUnlockTimeout)
            clearInterval(appRateLimitUnlockTimeout);

        appRateLimitUnlockTimeout = setInterval(() => {
            if (appRateLimitExpiry - new Date().getTime() <= 0) {
                appRateLimitExpiry = 0;
                appRateLimit = 0;
                appPerfText = "";
                clearInterval(appRateLimitUnlockTimeout);

                console.log("Rate limit status has been cleared!");
            } else if (Math.round(appRateLimitExpiry - new Date().getTime()) % 60 === 0) {
                console.verbose("log", "Rate limit will expire in", Math.round((appRateLimitExpiry - new Date().getTime()) / 1000), "seconds");
            }
        }, 1e3);
    });
}

async function isAuthorised(token: string | undefined): Promise<TempoTokenType | false> {
    console.verbose("log", "Checking if user is authorised with token:", token);

    if (BYPASS_AUTH) {
        console.verbose("log", "Bypassing authentication, returning fake user data as BYPASS_AUTH is set");

        return {
            id: "fakeuser",
            username: "Fake User",
            tokenVersion: "fakeuser",
        };
    }

    if (!token)
        return false;

    const tokVerifyVerb = console.verbose("perf", "tokVerify", "Verifying token:", token);

    const tok = await tempoToken.verifySignedToken(token);

    tokVerifyVerb.timed("Token verification completed");

    console.verbose("log", "Token verification result:", tok);

    if (!tok)
        return false;

    return tok;
}

function createAuthToken(userId: string) {
    const token = randomBytes(12).toString("hex");

    return token;
}

const allowedOrigins = ALLOWED_ORIGINS;

const limiterKeyGen = (req: Request) => {
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    const ipString = Array.isArray(ip) ? ip.join(",") : ip ?? "";

    const hash = createHash("sha256").update(ipString).digest("hex");

    return hash;
}

const speedLimiter = slowDown({
	windowMs: 1800e3,
	delayAfter: 3120,
	delayMs: (hits) => hits * 25,
    maxDelayMs: 2e3,
    skipFailedRequests: true,
    keyGenerator: limiterKeyGen,
});

const rateLimiter = rateLimit({
	windowMs: 1800e3,
	limit: 5600,
	standardHeaders: 'draft-8',
	legacyHeaders: false,
    message: {
        error: true,
        message: "You have been rate limited"
    },
    statusCode: 429,
    keyGenerator: limiterKeyGen,
});

const app = expressWs(express()).app;

app.use(rateLimiter);
app.use(speedLimiter);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Responses differ by origin, so any cache must key on it
    res.header('Vary', 'Origin');

    if (allowedOrigins.includes(origin ?? "")) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    } else {
        console.warn("Request from unauthorised origin:", origin, "path:", req.path);
    }

    res.setHeader("Access-Control-Allow-Headers", "Access-Control-Allow-Headers, Origin,Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers, x-api-token");

    console.log(`[${req.method.toUpperCase()}@${(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])}] ${req.path}`)

    next();
});

app.get("/perf", (_, res) => {
    res.json({
        active: (appPerfText !== ""),
        message: appPerfText,
        priority: appRateLimitPriority,
    });
});

app.get("/.stats", (_, res) => {
    res.json({
        error: false,
        spotifyAPI: {
            curr: globalSpotifyAPIRequestCounter,
            lastPeriod: (globalSpotifyAPIRequestHistory.length > 0 ? globalSpotifyAPIRequestHistory[globalSpotifyAPIRequestHistory.length - 1].timestamp : 0),
            count10: globalSpotifyAPIRequestCount,
            count60: globalSpotifyAPIRequestCount * 6,
            speed1: parseFloat((globalSpotifyAPIRequestCount / 10).toFixed(2)),
            history: globalSpotifyAPIRequestHistory, // Include the history in the response
        }
    });
});

app.get("/stats", (_, res) => {
    res.sendFile(process.cwd() + "/static/req-speed-tracker.html");
});

app.get("/debug/userInternalMeta/:userId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    // Only Vonga allowed to use this endpoint
    if (!token || token.id !== "yh1q376ly901c0qk03n9kaphh") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const targetUserId = req.params.userId;

    const session = userSessions.find(v => v.u.user?.meta.serviceId == targetUserId);

    if (!session || !session.u.user) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    const meta: Partial<typeof session.u.user.meta> = {
        ...session.u.user.meta
    };

    delete meta.token;
    delete meta.tokenVersion;

    res.status(200).json({
        error: false,
        data: meta,
    });
});

// app.get("/test", async (req, res) => {
//     if (flagServerShutdown) {
//         res.status(502).send("Sorry, Tempo is currently unable to service your request!");
//         return;
//     }
    
//     const token = await getAuthorisedUser(req);

//     // Only Vonga allowed to use this endpoint
//     if (!token || token.id !== "yh1q376ly901c0qk03n9kaphh") {
//         res.status(403).json({
//             error: true,
//             message: "You are not authorised to access this endpoint"
//         });

//         return;
//     }
    
//     const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

//     if (!session) {
//         res.status(404).json({
//             error: true,
//             message: "Unable to find session"
//         });

//         return;
//     }

//     if (session.u.user?.meta.state == "reauth") {
//         res.status(403).json({
//             error: true,
//             message: "You are not authorised to access this endpoint",
//         });

//         return
//     }

//     await session.u.addPriorityFYPAlert<string>("ListenerTypeChange", "Audio Addict", "After-View");

//     res.send("OK")
// });

app.get("/repair-friendships", async (req, res) => {
    return;

    // if (flagServerShutdown) {
    //     res.status(502).send("Sorry, Tempo is currently unable to service your request!");
    //     return;
    // }
    
    // const token = await getAuthorisedUser(req);

    // // Only Vonga allowed to use this endpoint
    // if (!token || token.id !== "yh1q376ly901c0qk03n9kaphh") {
    //     res.status(403).json({
    //         error: true,
    //         message: "You are not authorised to access this endpoint"
    //     });

    //     return;
    // }

    // let friends = await db.all<UserFriendship>("friends");
    // let users = await db.all<UserDocType>("users");

    // let userFriendsList: {[key: string]: string[]} = {};

    // for (let i = 0; i < friends.length; i++) {
    //     const v = friends[i];

    //     // const usr1 = await db.get<UserDocType>("users", v.u1Id);
    //     // const usr2 = await db.get<UserDocType>("users", v.u2Id);

    //     if (!userFriendsList[v.u1Id])
    //         userFriendsList[v.u1Id] = [v.id];
    //     else
    //         userFriendsList[v.u1Id].push(v.id);

    //     if (!userFriendsList[v.u2Id])
    //         userFriendsList[v.u2Id] = [v.id];
    //     else
    //         userFriendsList[v.u2Id].push(v.id);
    // }

    // for (let i = 0; i < Object.keys(userFriendsList).length; i++) {
    //     const key = Object.keys(userFriendsList)[i];

    //     const friends = userFriendsList[key]

    //     await db.set<UserDocType["friends"]>("users", key + "/friends", friends);
    // }
    
    // res.send("OK");
});

app.get("/.version", (_, res) => {
    res.send(APP_UI_VERSION.toString());
});

app.get("/.version-notice", async (req, res) => {
    const { reauthText, broadcast, ...notice } = APP_UI_NOTICE;

    if (!notice.reauth) {
        res.json(notice);

        return;
    }

    // Only accounts that still lack the scope are sent back through sign-in.
    // Without a token there is nobody to check, so the ask stands — being asked
    // once more is a smaller cost than the scope never being granted at all.
    const token = await getAuthorisedUser(req);
    const account = (token ? await db.get<UserDocType>("users", token.id, false, true) : null);

    if (account && tokenHasScope("user-read-recently-played", account.data?.scope)) {
        res.json({ ...notice, reauth: false });

        return;
    }

    res.json({
        ...notice,
        text: [...notice.text, ...(reauthText ?? [])],
    });
});

app.post("/logout", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    await removeAuthCookie(token.id, res);

    res.json({
        error: false,
        message: "OK"
    });
});

app.get("/spotify/callback", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const code = req.query.code as string;
    const state = req.query.state as string;

    const session = authSessions[state];

    if (!session) {
        res.redirect("/auth");

        return;
    }

    if (session.useServerCreds) {
        await session.cb(code, SPOT_CLIENT_ID, SPOT_CLIENT_SECRET, res, false);
        
        return;
    }

    if (!session.enroll) {
        try {
            await session.cb(code);

            if (session.successRedirect)
                return res.redirect(session.successRedirect);

            res.redirect(WEB_APP_URL + "/success");

            return;
        } catch (ex) {
            console.error("User account setup failed, error:", ex);

            /*
             * Spotify would not authenticate the app the code was issued for.
             *
             * The sign-in itself worked — there is a code in hand — so the only
             * thing left that can fail this way is the app's own credentials,
             * and by this point they are known to have worked at least once.
             * They go stale when somebody regenerates the client secret or
             * replaces the app, which /auth/start now catches before anybody
             * leaves for Spotify; this is the case it cannot catch, where the
             * app changed while a sign-in was already on its way.
             *
             * A generic failure page here says the wrong thing entirely: it
             * reads as Tempo being broken, when the fix is thirty seconds on a
             * page the user owns.
             */
            if (isInvalidClient(ex)) {
                res.redirect(WEB_APP_URL + "/connect-spotify?issue=app-credentials");

                return;
            }

            if (session.errorRedirect)
                return res.redirect(session.errorRedirect);

            res.status(500).send(`
                <!DOCTYPE html>
                <html lang="en">
                    <head>
                        <meta charset="UTF-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                        <title>Tempo Configuration Error</title>
                        <!-- Google Fonts -->
                        <link rel="preconnect" href="https://fonts.googleapis.com" />
                        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
                        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet" />
                        <style>
                            body {
                                font-family: 'Roboto', sans-serif;
                                background: linear-gradient(135deg, #72edf2 0%, #5151e5 100%);
                                margin: 0;
                                padding: 0;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                min-height: 100vh;
                            }
                            .card {
                                background: #fff;
                                border-radius: 12px;
                                padding: 40px;
                                box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
                                text-align: center;
                                max-width: 500px;
                                width: 90%;
                            }
                            .card h1 {
                                font-size: 2.5rem;
                                margin: 0 0 20px;
                                color: #d32f2f;
                            }
                            .card p {
                                font-size: 1.1rem;
                                color: #555;
                                margin-bottom: 20px;
                                line-height: 1.6;
                            }
                            .icon {
                                width: 60px;
                                height: 60px;
                                margin: 0 auto 20px;
                            }
                            .icon svg {
                                width: 100%;
                                height: 100%;
                                fill: #d32f2f;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="card">
                            <div class="icon">
                                <svg viewBox="0 0 52 52">
                                    <path d="M26,0C11.664,0,0,11.664,0,26s11.664,26,26,26s26-11.664,26-26S40.336,0,26,0z M28.4,38h-4.8V33.2h4.8V38z M28.4,28.8h-4.8V14h4.8V28.8z"/>
                                </svg>
                            </div>
                            <h1>Something Went Wrong</h1>
                            <p>Hi there, ${session.username || "User"}!</p>
                            <p>We encountered an error while setting up your Tempo account. Please try again.</p>
                        </div>
                        <script>
                            try {
                                history.replaceState({}, null, "/spotify/callback");
                            } catch { }
                        </script>
                    </body>
                </html>
            `);
        }

        return;
    }

    await authSessions[state].cb(code, undefined, undefined, undefined, true);

    const preAuthUser: { id: string } = (authSessions[state].me && authSessions[state].me.body) ? authSessions[state].me.body : undefined;

    // We already have a session configured for this user, use it
    if (await db.exists("users", preAuthUser.id, true)) {
        await authSessions[state].cb(code, SPOT_CLIENT_ID, SPOT_CLIENT_SECRET, res);

        return;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
            <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Configure Tempo</title>
            <!-- Google Fonts -->
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
            <link
                href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap"
                rel="stylesheet"
            />
            <style>
                * {
                    box-sizing: border-box;
                }
                body {
                    font-family: 'Roboto', sans-serif;
                    background: linear-gradient(135deg, #72edf2 10%, #5151e5 100%);
                    margin: 0;
                    padding: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                }
                .container {
                    background-color: #ffffff;
                    padding: 40px;
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                    width: 900px;
                    max-width: 95%;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 20px;
                }

                /* Instructions Section */
                .instructions {
                    flex: 1;
                    min-width: 300px;
                    max-width: 400px;
                    background-color: #f9f9f9;
                    padding: 20px;
                    border: 1px solid #eee;
                    border-radius: 8px;
                    font-size: 14px;
                    color: #555;
                }
                .instructions h2 {
                    font-size: 18px;
                    margin-bottom: 10px;
                    color: #333;
                }
                .instructions ol {
                    padding-left: 20px;
                }
                .instructions li {
                    margin-bottom: 8px;
                    line-height: 1.5;
                }
                .instructions a {
                    color: #5151e5;
                    text-decoration: none;
                }
                .instructions a:hover {
                    text-decoration: underline;
                }

                /* Form Section */
                .form-section {
                    flex: 1;
                    min-width: 300px;
                }
                h1 {
                    font-size: 22px;
                    margin-bottom: 15px;
                    color: #333;
                }
                label {
                    display: block;
                    margin-bottom: 5px;
                    color: #555;
                    font-weight: 500;
                }
                input[type="text"] {
                    width: 100%;
                    padding: 12px 15px;
                    margin-bottom: 15px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    font-size: 14px;
                    transition: border-color 0.3s ease;
                }
                input[type="text"]:focus {
                    border-color: #5151e5;
                    outline: none;
                }
                input[type="submit"] {
                    width: 100%;
                    padding: 12px;
                    background-color: #5151e5;
                    border: none;
                    border-radius: 6px;
                    color: #fff;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: background-color 0.3s ease;
                }
                input[type="submit"]:hover {
                    background-color: #3e3ecf;
                }

                /* Responsive: Adjust layout on smaller screens */
                @media (max-width: 768px) {
                    .container {
                        flex-direction: column;
                        align-items: center;
                        padding: 20px;
                    }
                    .instructions {
                        max-width: 100%;
                        text-align: left;
                    }
                    .form-section {
                        width: 100%;
                    }
                }
            </style>
            </head>
            <body>
            <div class="container">
                <!-- Header with Title and Instructions -->
                <div class="header">
                <h1>Configure Tempo</h1>
                <div class="guide-section">
                    <h2>Creating Your Spotify Developer App</h2>
                    <ol>
                    <li>
                        Visit the <a href="https://developer.spotify.com/dashboard/create" target="_blank">Spotify Developer Create App</a> page.
                    </li>
                    <li>Log in with your Spotify account or sign up if you haven’t already.</li>
                    <li>Enter any name and description, only you will see this.</li>
                    <li>
                        Add the following Redirect URI:
                        <code>${BASE_URL}/spotify/callback</code>
                    </li>
                    <li>
                        Once your app is created, click the <strong>Settings</strong> button of your app.
                    </li>
                    <li>Copy the <strong>Client ID</strong>, click <strong>View client secret</strong> and copy the <strong>Client Secret</strong>.</li>
                    <li>Enter the <strong>Client ID</strong> and <strong>Client Secret</strong> in the form beside.</li>
                    </ol>
                </div>
                </div>
                <!-- Form Section -->
                <div class="form-section">
                <form action="/spotify/enroll" method="POST">
                    <label for="clientId">Client ID</label>
                    <input
                    type="text"
                    id="clientId"
                    name="clientId"
                    required
                    />
                    <label for="clientSecret">Client Secret</label>
                    <input
                    type="text"
                    id="clientSecret"
                    name="clientSecret"
                    required
                    />
                    <input type="hidden" id="state" name="state" value="${state}" />
                    <input type="hidden" id="code" name="code" value="${code}" />
                    <input type="submit" value="Submit" />
                </form>
                </div>
                <script>
                    try {
                        history.replaceState({}, null, "/spotify/callback");
                    } catch { }
                </script>
            </div>
            </body>
        </html>
    `);
});

app.get("/spotify/auth/:userId/:state", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const state = req.params.state;

    const creds = authorizeCredsFor(state);

    /*
     * A sign-in link that no longer has a session behind it.
     *
     * Sending this on to Spotify anyway is worse than stopping: the person
     * signs in, grants consent, and the callback then finds no session and
     * quietly bounces them back to the start with nothing to show for it. Say
     * so here instead, where starting again is the obvious next step.
     */
    if (creds.error) {
        console.warn("Sign-in link for state", state, "has no session behind it - it expired or the server restarted");

        res.redirect(WEB_APP_URL + "/connect-spotify?issue=link-expired");

        return;
    }

    if (req.params.userId == "cb") {
        res.redirect(buildSpotifyAuthorizeUrl(state, creds.clientId));

        return;
    }

    if (!await db.exists("users", req.params.userId, true)) {
        res.status(400).send("User not configured");

        return;
    }

    res.redirect(buildSpotifyAuthorizeUrl(state, creds.clientId));
});

app.post("/spotify/enroll", (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const clientId = req.body.clientId as string;
    const clientSecret = req.body.clientSecret as string;
    const state = req.body.state as string;
    const code = req.body.code as string

    if (!authSessions[state]) {
        res.status(400).send("Sorry something went wrong, please try again later!");

        return;
    }

    authSessions[state].cb(code, clientId, clientSecret, res);
});

/**
 * What a user needs to put into their own Spotify app for it to work with this
 * deployment. Served rather than hardcoded in the client so the two can never
 * disagree about the redirect URI, which is the single most common thing to get
 * wrong when setting one up.
 */
app.get("/spotify/byo/info", (_, res) => {
    res.status(200).json({
        error: false,
        redirectUri: SPOT_REDIRECT_URI,
        scopes: SPOTIFY_SCOPES.split(" "),
        dashboardUrl: "https://developer.spotify.com/dashboard",
        /*
         * Straight to the form, rather than to the dashboard it lives behind.
         *
         * The dashboard only offers "Create app" to somebody who already has
         * one — on a phone, an account with no apps yet lands on a page with
         * nothing on it to press, which is exactly the account being sent here.
         *
         * Served alongside the dashboard link rather than replacing it, because
         * builds already installed read that field and would otherwise be sent
         * somewhere they do not expect by a server they did not change with them.
         */
        createAppUrl: "https://developer.spotify.com/dashboard/create",
    });
});

/**
 * Starts an enrolment against the user's own Spotify app.
 *
 * Tempo's own app is limited by Spotify's development mode to a handful of
 * listed accounts, so past that point the only way to sign someone in is to let
 * them authorise against an app they own.
 */
app.post("/spotify/byo/start", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const clientId = (req.body.clientId as string | undefined)?.trim();
    const clientSecret = (req.body.clientSecret as string | undefined)?.trim();
    const swapToken = req.body.swapToken as unknown;

    /*
     * The sign-in session this enrolment belongs to, when there is one.
     *
     * Without it the flow finishes on the web success page, which is no use to
     * the app: it is waiting on a swap token and would wait forever. Mirrors
     * /auth/start, which has taken one all along.
     */
    if (swapToken !== undefined && (typeof swapToken !== "string" || !tokSwapStore[swapToken])) {
        res.status(400).json({
            error: true,
            message: "Unknown sign-in session",
        });

        return;
    }

    // Spotify ids and secrets are 32-character hex strings; catching the shape
    // here turns a confusing failure after the redirect into an inline one
    if (!clientId || !clientSecret || !/^[a-f0-9]{32}$/i.test(clientId) || !/^[a-f0-9]{32}$/i.test(clientSecret)) {
        res.status(400).json({
            error: true,
            message: "That does not look like a Spotify client ID and secret. Both are 32-character codes from your app's dashboard.",
        });

        return;
    }

    // Prove the pair actually works before sending the user to Spotify, so a
    // typo surfaces on the form they just filled in rather than as a failed
    // redirect they cannot interpret
    const entered = await spotifyCredentialsState(clientId, clientSecret);

    if (entered === "rejected") {
        res.status(400).json({
            error: true,
            message: "Spotify rejected those credentials. Check you copied the client ID and secret from the same app.",
        });

        return;
    }

    if (entered === "unreachable") {
        res.status(502).json({
            error: true,
            message: "Could not reach Spotify to check those credentials. Please try again.",
        });

        return;
    }

    try {
        const redirUrl = await enrollNewUser(swapToken === undefined, swapToken as string | undefined, { clientId, clientSecret });

        res.status(200).json({
            error: false,
            authUrl: redirUrl,
        });
    } catch (ex) {
        console.error("Failed to start bring-your-own-app enrolment, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, we could not start sign-in. Please try again.",
        });
    }
});

app.get("/me/settings", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    // TODO: Use a settings cache

    let settings: UserDocType["settings"] | null = null;

    try {
        settings = await db.get<UserDocType["settings"]>("users", token.id + "/settings", true);
    } catch (ex) {
        console.error("Failed to load settings for user with id:", token.id, "error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, something went wrong while loading settings",
        });

        return;
    }

    if (!settings) {
        res.status(404).json({
            error: true,
            message: "Unable to load settings",
        });

        return;
    }

    res.status(200).json({
        error: false,
        data: settings,
    });
});

app.post("/me/settings", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const user = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!user || !user.u.user) {
        res.status(404).json({
            error: true,
            message: "User not found"
        });

        return;
    }

    const payload = req.body as {
        key: string;
        value: any;
    };

    if (!payload.key || payload.value == undefined) {
        res.status(400).json({
            error: true,
            message: "Invalid request",
        });

        return;
    }

    const validKeys = [
        "shareListeningActivity",
    ];

    if (!validKeys.includes(payload.key)) {
        res.status(400).json({
            error: true,
            message: "Invalid request",
        });

        return;
    }

    let ok = true;
    
    if (payload.key == "shareListeningActivity" && typeof payload.value == "boolean") {
        user.u.user.settings.shareListeningActivity = payload.value as boolean;
        await db.set<UserDocType["settings"]["shareListeningActivity"]>("users", `${token.id}/settings/${payload.key}`, payload.value as boolean);
    } else {
        ok = false;
    }

    if (!ok) {
        res.status(500).json({
            error: true,
            message: "Sorry, something went wrong"
        });

        return;
    }

    res.status(200).json({
        error: false,
        message: "OK",
    });
});

app.get("/me/recap", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    let dailyRecap: Recap | null = null;
    let weeklyRecap: Recap | null = null;

    try {
        dailyRecap = await db.getRecap(token.id, "daily", req.query["seen"] == "true");
        weeklyRecap = await db.getRecap(token.id, "weekly", req.query["seen"] == "true");
    } catch (ex) {
        console.error("Failed to fetch daily/weekly recap, error:", ex);
    }
    
    const recapData: {
        daily: Recap | null;
        weekly: Recap | null;
    } = {
        daily: dailyRecap,
        weekly: weeklyRecap,
    };

    if (!recapData.daily && !recapData.weekly) {
        res.status(404).json({
            error: true,
            message: "No recaps are available"
        });

        return;
    }

    res.status(200).json({
        error: false,
        data: recapData,
    });
});

app.post("/me/recap/:type/seen", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const type = req.params.type;

    if (!["daily", "weekly"].includes(type)) {
        res.status(400).json({
            error: true,
            message: `Invalid recap type: "${type}"`
        });

        return;
    }

    await db.markRecapSeen(token.id, type as "daily" | "weekly");

    res.status(200).json({
        error: false,
        message: "OK"
    });
});

/**
 * A validator for a user's friends list, so the client can tell whether its
 * cached copy is still current without refetching the whole list (and the
 * profile lookup each entry triggers).
 *
 * Covers state as well as id: accepting a request keeps the same friendship id,
 * so hashing ids alone would not notice a "request" -> "friends" transition —
 * exactly the change a client most needs to pick up. Computed over every
 * friendship regardless of the caller's filter, so one value invalidates all
 * cached filter variants.
 */
async function friendsListHash(userId: string) {
    const friendships = await listFriends(userId);

    const fingerprint = friendships
        .map(v => `${v.id}:${v.state}`)
        .sort()
        .join("|");

    return createHash("sha256").update(fingerprint).digest("hex");
}

app.get("/me/friends/hash", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    try {
        res.status(200).json({
            error: false,
            hash: await friendsListHash(token.id),
        });
    } catch (ex) {
        console.error("Failed to compute friends list hash, error:", ex);

        res.status(500).json({
            error: true,
            message: "Unable to compute friends list hash",
        });
    }
});

app.get("/me/friends", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const stateFilterRaw = req.query.state as string | undefined;
    const stateFilter = (stateFilterRaw ?? "").split(",").map(v => v.trim()).filter(v => v !== "");

    try {
        const friendships = (await listFriends(token.id)).map(v => {
            if (v.state == "request" && v.u2Id == token.id) return {
                ...v,
                state: "incoming",
            };

            return v;
        }).filter(v => {
            if (stateFilter.length == 0)
                return true;

            if (stateFilter.includes(v.state))
                return true;

            if (stateFilter.includes("request") && v.state == "incoming")
                return true;

            return false;
        });

        res.status(200).json({
            error: false,
            data: friendships,
            hash: await friendsListHash(token.id),
        });
    } catch (ex) {
        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to load your friends list"
        });
    }
});

app.get("/me/friends/requests", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    try {
        const requests = await listFriendRequests(token.id);

        res.status(200).json({
            error: false,
            data: requests,
        });
    } catch (ex) {
        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to load your friend requests"
        });
    }
});

app.post("/me/friends/request", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const targetUserId = req.body.targetUserId as string | undefined;

    if (!targetUserId) {
        res.status(409).json({
            error: true,
            message: "No target user was specified"
        });

        return;
    }

    const state = await createFriendRequest(token.id, targetUserId);

    if (state == "EXISTS") {
        res.status(400).json({
            error: true,
            message: "You are already friends with or have sent a friend request to that user",
        });

        return;
    }

    if (state !== "VALIDATED") {
        res.status(500).json({
            error: true,
            message: "Sorry, there was an issue processing the friend request"
        });

        return;
    }

    let newCurrentUsername: string | undefined;

    const u = await db.get<UserDocType>("users", token.id, true);

    if (u)
        newCurrentUsername = u.me.displayName;

    try {
        notify.notifyUser(targetUserId, {
            title: "New friend request",
            message: `${newCurrentUsername ?? token.username} wants to be your friend!`,
        });
    } catch { }

    res.status(200).json({
        error: false,
        message: "Friend request sent!"
    });
});

app.get("/me/friends/accept/:friendshipId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const friendshipId = req.params.friendshipId as string;

    try {
        const success = await acceptFriendRequest(token.id, friendshipId);

        if (!success) {
            res.status(500).json({
                error: true,
                message: "Sorry, we were unable to accept the friend request"
            });

            return;
        }

        try {
            const friendship = await db.get<UserFriendship>("friends", friendshipId, true);

            if (friendship?.u1Id) {
                let newCurrentUsername: string | undefined;

                const u = await db.get<UserDocType>("users", token.id, true);

                if (u)
                    newCurrentUsername = u.me.displayName;
                
                notify.notifyUser(friendship?.u1Id, {
                    title: "Friend request accepted",
                    message: `${newCurrentUsername ?? token.username} accepted your friend request!`,
                });
            }
        } catch { }

        res.status(200).json({
            error: false,
            message: "Friend request accepted!",
        });
    } catch (ex) {
        console.error("Failed to accept friend request, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to accept the friend request"
        });
    }
});

app.get("/me/friends/block/:friendshipId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const friendshipId = req.params.friendshipId as string;

    try {
        const success = blockFriend(friendshipId, token.id);

        if (!success) {
            res.status(500).json({
                error: true,
                message: "Sorry, we were unable to block the friend request"
            });

            return;
        }

        res.status(200).json({
            error: false,
            message: "Friend request blocked!",
        });
    } catch (ex) {
        console.error("Failed to block friend request, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to block the friend request"
        });
    }
});

app.get("/me/friends/unblock/:friendshipId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    // TODO: Make relevant methods
});

app.get("/me/friends/remove/:friendshipId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const friendshipId = req.params.friendshipId as string;

    if (!(await db.exists("friends", friendshipId, true))) {
        res.status(404).json({
            error: true,
            message: "Sorry, that friendship could not be found"
        });

        return;
    }

    try {
        const success = removeFriendship(friendshipId);

        if (!success) {
            res.status(500).json({
                error: true,
                message: "Sorry, we were unable to remove the friend request"
            });

            return;
        }

        res.status(200).json({
            error: false,
            message: "Friend removed!",
        });
    } catch (ex) {
        console.error("Failed to remove friend request, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to remove the friend request"
        });
    }
});

async function forceFetchSpotifyTrack(id: string, session: Monitor, returnCacheObj?: boolean): Promise<SpotifyApi.TrackObjectFull | SongData | null> {
    const track = await session.u.spotifyApi.getTrack(id);

    if (!track || !track.body) {
        return null;
    }

    const item = track.body;

    let imageUrl = "";
    let explicit = false;
    let name = "";
    let artists: {
        name: string;
        url: string;
    }[] = [];
    let albumId: string = "";

    if (!('album' in item))
        return null;

    let image = item.album.images.find(v => v.height == 300);

    // An album with no artwork (a local file, for one) has an empty images
    // array, so the fallback cannot index into it blindly. "" is already the
    // no-image value here.
    imageUrl = (image?.url ?? item.album.images?.[0]?.url ?? "");
    explicit = item.explicit;
    name = item.name;
    artists = item.artists.map(v => {
        return {
            name: v.name,
            url: v.href
        };
    });
    albumId = item.album.id;

    const cachedItem = {
        id: item.id,
        name,
        artists: item.artists.map(v => {
            return {
                id: v.id,
                name: v.name,
                url: v.href,
                uri: v.uri,
            };
        }),
        duration: item.duration_ms,
        explicit,
        album: {
            id: albumId,
            name: item.album.name,
            releaseDate: new Date(item.album.release_date).getTime(),
            artUrl: imageUrl,
        },
        isrc: item.external_ids?.isrc,
        type: item.type,
        meta: {
            updatedAt: new Date().getTime(),
        }
    };

    songMetaCache.setItemIfNotExist(cachedItem);

    return (returnCacheObj ? cachedItem : item);
}

app.get("/audio/musicvideo/:id", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    const session = userSessions.find(v => v.u.user?.meta.serviceId == (token && token.id ? token.id : undefined));

    // if (!token || !session || !session.u.user) {
    //     res.status(403).json({
    //         error: true,
    //         message: "You are not authorised to access this endpoint"
    //     });

    //     return;
    // }

    try {
        const musicVideoId = await findMusicVideo(req.params.id, async (id) => {
            const track = await forceFetchSpotifyTrack(req.params.id, session!, true) as SongData | null;

            if (!track)
                return null;
            
            return track;
        });

        if (!musicVideoId) {
            res.status(404).json({
                error: true,
                message: "Music video not found"
            });

            return;
        }

        res.status(200).json({
            error: false,
            videoId: musicVideoId,
        });
    } catch (ex) {
        console.error("Failed to get music video, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, we were unable to get the music video",
        });
    }
});

/**
 * Album art and profile pictures.
 *
 * Ensures the requested variant exists in R2, then redirects to it. The bytes
 * are served by R2 rather than by us, so this only does work the first time a
 * given image and size is asked for. Replaces the standalone image-cdn service.
 */
app.get("/img/:imageId", async (req, res) => {
    const imageId = req.params.imageId;

    if (!isValidImageId(imageId)) {
        res.status(400).json({
            error: true,
            message: "Invalid image id",
        });

        return;
    }

    const sizeRaw = req.query["s"] as string | undefined;
    const size = parseSize(sizeRaw);

    if (sizeRaw && !size) {
        res.status(400).json({
            error: true,
            message: `Unsupported size "${sizeRaw}" — ${describeSizeLimits()}`,
        });

        return;
    }

    // Images are public and never credentialed, so allow any origin.
    //
    // A per-origin ACAO would be wrong here: these responses are cached for a
    // year, and without a Vary: Origin the first cached copy is reused for every
    // caller. Fetching the URL directly (no Origin, so no ACAO) poisons the
    // cache for every subsequent cross-origin request. A wildcard is correct for
    // public assets and stays valid whoever asks.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    try {
        await ensureVariant(imageId, size);

        // Immutable content, so let Cloudflare and the browser hold onto it
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

        const publicUrl = publicUrlFor(imageId, size);

        if (publicUrl) {
            // Bucket is publicly reachable — hand the client straight to R2
            res.redirect(302, publicUrl);

            return;
        }

        // No public bucket URL yet, so serve the bytes ourselves
        const body = await readVariant(imageId, size);

        if (!body)
            throw new Error("Variant was reported present but could not be read");

        res.setHeader("Content-Type", "image/webp");
        res.send(body);
    } catch (ex) {
        console.warn("Failed to prepare image", imageId, "size:", size, "error:", ex);

        // Proxy the original rather than redirecting to i.scdn.co. Spotify sends
        // no CORS headers, so a redirect breaks any crossOrigin <img> — which the
        // profile page needs in order to sample the artwork for its gradient.
        try {
            const upstream = await fetch("https://i.scdn.co/image/" + imageId);

            if (!upstream.ok)
                throw new Error("Spotify CDN returned " + upstream.status);

            // Deliberately not cached: this is the degraded path
            res.setHeader("Cache-Control", "public, max-age=300");
            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
            res.send(Buffer.from(await upstream.arrayBuffer()));
        } catch (fallbackEx) {
            console.warn("Fallback image fetch also failed for", imageId, "error:", fallbackEx);

            res.status(502).json({ error: true, message: "Image unavailable" });
        }
    }
});

app.get("/audio/preview/:id", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    const session = userSessions.find(v => v.u.user?.meta.serviceId == (token && token.id ? token.id : undefined));

    if (!token || !session || !session.u.user) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }
    
    try {
        const track = await forceFetchSpotifyTrack(req.params.id, session, false) as SpotifyApi.TrackObjectFull | null;

        if (!track) {
            res.status(404).send("Track not found");
            return;
        }

        if (!track.external_ids?.isrc) {
            res.status(404).send("Track does not have a valid ISRC code");
            
            return;
        }

        const previewUrl = await getPreviewWithISRC(track.external_ids!.isrc);

        if (!previewUrl) {
            res.status(404).send("Track does not have a preview available");
            return;
        }
        
        res.status(200).send(previewUrl);
    } catch (ex) {
        console.error("Failed to get track preview, error:", ex);

        res.status(500).send("Sorry, we were unable to get the track preview");
        return;
    }
});

app.post("/users/query", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const data = req.body as {
        query: string;
        limit: number;
    };

    if (!data.query) {
        res.status(400).json({
            error: true,
            message: "No query provided",
        });

        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const query = data.query.toLowerCase();

    // TODO: Need a better searching algo
    const results = userSessions.map(v => v.u.user).filter(v => v !== undefined).filter(v => {
        if (v.me.displayName?.toLowerCase().includes(query) || v.meta.serviceId.toLowerCase().includes(query))
            return true;

        if ((v.me as {
            email?: string;
        })?.email?.toLowerCase().includes(query))
            return true;

        // Allow displayNames with a high levenstein distance
        if (v.me.displayName) {
            const d = distance(query, v.me.displayName.toLowerCase());

            if (d <= 3)
                return true;
        }

        return false;
    }).map(v => v.me);

    /*
     * One row per person.
     *
     * These come from the session list rather than from the accounts, and a
     * session is not a person — anyone holding more than one puts themselves
     * into the results once for each. Both places that add a session guard
     * against that today, but the guard matches on a different id from the one
     * the rest of this file looks sessions up by, and the client had already
     * resorted to mixing an array index into its React keys to survive it.
     */
    const seen = new Set<string>();

    const unique = results.filter(account => {
        if (seen.has(account.id))
            return false;

        seen.add(account.id);

        return true;
    });

    const resultsWithMutuals = await Promise.all(unique.map(async user => {
        const mutualFriends = await getMutualFriends(token.id, user.id);
        return { user, mutualFriends };
    }));

    const nameOf = (v: (typeof resultsWithMutuals)[number]) => (v.user.displayName?.toLowerCase() ?? "");

    /*
     * Ranked before it is cut, which is the way round it has to be.
     *
     * This used to take the top N by mutual friends and only then promote the
     * name matches among them — so searching somebody's name exactly could fail
     * to find them, because the cut happened while they were still ranked on how
     * many friends they had in common, and they never survived to be promoted.
     * What somebody typed exactly is the strongest signal there is that they
     * have found who they were looking for.
     */
    const sortedResults = resultsWithMutuals.sort((a, b) => {
        const exact = Number(nameOf(b) === query) - Number(nameOf(a) === query);

        if (exact !== 0)
            return exact;

        const starts = Number(nameOf(b).startsWith(query)) - Number(nameOf(a).startsWith(query));

        if (starts !== 0)
            return starts;

        // Then whoever you already have the most people in common with, which is
        // the best guess at who somebody is looking for
        return (b.mutualFriends.length - a.mutualFriends.length);
    }).slice(0, data.limit || 10);


    const friends = await listFriends(token.id);
    const requests = friends.filter(v => v.state == "request");

    // Merge friends list and friend requests together
    requests.forEach(v => {
        if (!friends.find(f => {
            const otherId = f.u1Id == token.id ? f.u2Id : f.u1Id;
            const otherReqId = v.u1Id == token.id ? v.u2Id : v.u1Id;

            return (otherId == otherReqId);
        }))
            friends.push(v);
    });
    
    // Get friendship status
    const final = sortedResults.map(v => {
        const friendship = friends.find(f => {
            return (f.u1Id == token.id && f.u2Id == v.user.id) || (f.u2Id == token.id && f.u1Id == v.user.id);
        });

        return {
            user: v.user,
            mutualFriends: v.mutualFriends,
            // UserFriendship["state"] | "incoming" | "none"
            friendState: (friendship?.state == "request" && friendship?.u1Id == token.id) ? "request" : friendship?.state == "request" ? "incoming" : (friendship?.state ?? "none"),
            friendshipId: friendship?.id,
        };
    });
    
    res.json({
        error: false,
        data: final,
    });
});

/**
 * People worth suggesting, without anybody having to search.
 *
 * Friends of your friends who are not yet friends of yours — which is the one
 * thing this app can say about a stranger that a stranger cannot say about
 * themselves, and the only list on the add-friends page that is useful before a
 * single character is typed.
 *
 * Ordered by how many people you already have in common, most first, because
 * that is the whole signal.
 *
 * Everyone you already have any relationship with is excluded — friends,
 * requests you have sent, requests waiting on you, and anyone blocked either
 * way. Suggesting somebody you have already asked reads as the app not knowing
 * what you have done.
 *
 * The walk is proportional to the size of your corner of the graph: one read per
 * friend, and one per friendship they hold. That is fine at the scale this runs
 * at and is the first thing to cache if it stops being.
 */
app.get("/users/suggestions", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const limit = Math.min(parseInt(String(req.query.limit ?? "20")) || 20, 50);

    const mine = await listFriends(token.id);

    /*
     * One read per friend, to find out who they know.
     *
     * Proportional to the size of your corner of the graph, which is fine at the
     * scale this runs at and is the first thing to cache if it stops being.
     */
    const friendsOf = new Map<string, UserFriendship[]>();

    for (const friendship of mine.filter(v => v.state === "friends")) {
        const friendId = otherSideOf(friendship, token.id);

        friendsOf.set(friendId, await listFriends(friendId));
    }

    // The ranking and, more to the point, the exclusions live apart from here
    // and are tested on their own — see friend-suggestions.ts
    const ranked = rankFriendSuggestions(token.id, mine, friendsOf, limit);

    const suggestions = await Promise.all(ranked.map(async ({ userId, mutualFriends }) => {
        const account = await db.get<UserDocType>("users", userId, false, true);

        // An id in somebody's friends list with no account behind it any more is
        // not worth failing the whole list over
        if (!account?.me)
            return null;

        return {
            user: account.me,
            mutualFriends,
            friendState: "none" as const,
        };
    }));

    res.json({
        error: false,
        data: suggestions.filter(v => v !== null),
    });
});


/**
 * The VAPID application server key, so a client can subscribe with the key this
 * server actually signs with.
 *
 * Unauthenticated on purpose: it is the public half of the pair, and the client
 * needs it before it has anything to subscribe with. Hardcoding it in the client
 * is what makes push break silently whenever the server key changes.
 */
app.get("/notify/pubkey", async (_req, res) => {
    const publicKey = await notify.getPublicKey();

    if (!publicKey) {
        res.status(503).json({
            error: true,
            message: "Push notifications are unavailable",
        });

        return;
    }

    res.status(200).json({
        error: false,
        data: { publicKey },
    });
});

app.post("/notify/subscribe", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    // Subscriptions decide who receives a user's notifications, so this has to
    // be authenticated: unauthenticated, anyone could register an endpoint under
    // someone else's id and quietly receive their friend requests and recaps.
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const rawId = req.body.id as string | undefined;
    const sub = req.body.subscription as PushSubscriptionJSON | undefined;

    if (!rawId || !sub) {
        res.status(400).json({
            error: true,
            message: "Invalid subscription",
        });

        return;
    }

    // The client sends `<userId>-<deviceId>`, but only the device half is
    // trusted — the owning user always comes from the token, so a subscription
    // can never be filed against an account other than the caller's
    const deviceId = rawId.split("-").pop() ?? "";

    if (!/^[A-Za-z0-9]{4,64}$/.test(deviceId)) {
        res.status(400).json({
            error: true,
            message: "Invalid subscription id",
        });

        return;
    }

    // web-push will happily POST to any endpoint it is given
    if (typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
        res.status(400).json({
            error: true,
            message: "Invalid subscription endpoint",
        });

        return;
    }

    const subId = `${token.id}-${deviceId}`;

    try {
        notify.addSubscription(sub, subId);

        res.status(200).json({
            error: false,
            message: "Registered subscription",
        });
    } catch (ex) {
        console.error("Failed to register new notification subscription, data:", sub, "id:", subId, "error:", ex);

        res.status(500).json({
            error: true,
            message: "Failed to register subscription",
        });
    }
});

/**
 * Where the installed app hands over the token Apple gave it.
 *
 * The web equivalent above takes a push subscription; this takes a device
 * token, and is otherwise the same deal - the owning user comes from the token,
 * never from the body, so nobody can file a device against another account and
 * quietly receive their notifications.
 */
app.post("/notify/register-device", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const rawId = req.body.id as string | undefined;
    const deviceToken = req.body.deviceToken as string | undefined;

    // Apple's tokens are hex. Checking the shape here keeps a mistyped or
    // truncated one out of the store, where it would fail on every send
    // instead of being refused once at the point it arrived.
    if (!rawId || typeof deviceToken !== "string" || !/^[0-9a-fA-F]{64,200}$/.test(deviceToken)) {
        res.status(400).json({
            error: true,
            message: "Invalid device registration",
        });

        return;
    }

    const deviceId = rawId.split("-").pop() ?? "";

    if (!/^[A-Za-z0-9]{4,64}$/.test(deviceId)) {
        res.status(400).json({
            error: true,
            message: "Invalid device id",
        });

        return;
    }

    const id = `${token.id}-${deviceId}`;

    try {
        notify.registerDevice(id, deviceToken.toLowerCase());

        console.log("Registered device for notifications:", id);

        res.status(200).json({
            error: false,
            message: "Registered device",
        });
    } catch (ex) {
        console.error("Failed to register device for notifications, id:", id, "error:", ex);

        res.status(500).json({
            error: true,
            message: "Failed to register device",
        });
    }
});

/**
 * Collects every credential the request might be carrying.
 *
 * A browser can hold more than one cookie of the same name at once — a
 * host-only one and a domain-scoped one, say — and sends them all. Standard
 * cookie parsing keeps only the first, so a stale duplicate left over from an
 * earlier cookie configuration silently shadows the current one and can never
 * be overwritten by issuing a new cookie. Reading the raw header lets us try
 * each candidate instead of trusting whichever happened to be parsed.
 */
function collectAuthTokens(req: Request): string[] {
    const tokens: string[] = [];

    const header = req.headers["x-api-token"];

    if (typeof header === "string" && header !== "")
        tokens.push(header);

    const rawCookies = req.headers.cookie;

    if (typeof rawCookies === "string") {
        for (const part of rawCookies.split(";")) {
            const trimmed = part.trim();

            if (!trimmed.startsWith("tempo.a="))
                continue;

            const value = trimmed.slice("tempo.a=".length);

            if (value !== "" && !tokens.includes(value))
                tokens.push(decodeURIComponent(value));
        }
    }

    return tokens;
}

const getAuthorisedUser = async (req: Request) => {
    const candidates = collectAuthTokens(req);

    if (candidates.length === 0)
        return isAuthorised(undefined);

    let result: TempoTokenType | false = false;

    for (const candidate of candidates) {
        result = await isAuthorised(candidate);

        if (result)
            return result;
    }

    if (candidates.length > 1)
        console.warn("Request carried", candidates.length, "credentials, none valid — likely a stale duplicate cookie");

    return result;
}

/**
 * Decides whether `viewerId` may read `target`'s listening data.
 *
 * Your own profile is always visible. Otherwise the target must have listening
 * activity sharing switched on, and the two of you must be accepted friends.
 *
 * Returns null when access is allowed, or the response to send when it is not.
 * Every route that serves one user's listening data to another must go through
 * here — keeping the rule in one place is what stopped topSongs and
 * pastWeekStats from drifting away from the history route.
 */
async function denyProfileAccess(viewerId: string, target: Monitor): Promise<{ status: number; message: string } | null> {
    const targetId = target.u.user?.meta.serviceId ?? "";

    if (targetId === "")
        return { status: 404, message: "User not found" };

    // Always allow a user to read their own data
    if (targetId === viewerId || target.u.user?.me.id === viewerId)
        return null;

    if (!target.u.user?.settings.shareListeningActivity)
        return {
            status: 401,
            message: (target.u.user?.me.displayName ?? "This user") + " is not sharing their listening activity",
        };

    const availableUsers = await listFriendsIds(viewerId, true);

    if (!availableUsers.includes(targetId))
        return { status: 403, message: "You are not authorised to access this endpoint" };

    return null;
}

app.get("/taste-compare/:u1/:u2", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    const session1 = userSessions.find(v => v.u.user?.meta.serviceId == req.params.u1);
    const session2 = userSessions.find(v => v.u.user?.meta.serviceId == req.params.u2);

    if (!session1 || !session2) {
        res.status(404).json({
            error: true,
            message: "Unable to find sessions"
        });

        return;
    }

    // Both sides of the comparison must be visible to the caller
    for (const target of [session1, session2]) {
        const denied = await denyProfileAccess(token.id, target);

        if (denied) {
            res.status(denied.status).json({ error: true, message: denied.message });

            return;
        }
    }

    const u1Embedding = await session1.u.tasteHandler?.getUserEmbedding(session1.u.taste);
    const u2Embedding = await session2.u.tasteHandler?.getUserEmbedding(session2.u.taste);

    if (!u1Embedding || !u2Embedding) {
        res.status(500).json({
            error: true,
            message: "Failed to compare tastes"
        });

        return;
    }

    res.status(200).json({
        error: false,
        similarity: alphaMergedSimilarity(u1Embedding, u2Embedding),
    });
});

// app.get("/debug-emb", async (req, res) => {
//     // Test average cosine similarity across random pairs
//     let similarities = [];

//     for (let i = 0; i < 4000; i++) {
//         const a = sampleRandomEmbedding();
//         const b = sampleRandomEmbedding();
//         if (!a || !b) continue;
//         similarities.push(combinedSimilarity(a, b));
//     }

//     const meanSim = similarities.reduce((a, b) => a + b, 0) / similarities.length;
//     console.log("Average random similarity:", meanSim);

// });

app.get("/taste/:u", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == req.params.u);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    const denied = await denyProfileAccess(token.id, session);

    if (denied) {
        res.status(denied.status).json({ error: true, message: denied.message });

        return;
    }

    const tasteProfile = await session.u.tasteHandler?.generateTasteProfile({
        includeListenedMusic: false,
        taste: session.u.taste,
        // TODO: Add the time period (need to find ideal period)
        // timePeriod: {

        // }
    });

    const songsIndex = JSON.parse(readFileSync("./songs.json").toString()) as {[key: string] : {
        title: string;
        artists: string[];
        album: string;
    }};

    let processedProfile: {
        id: string;
        title: string;
        artists: string[];
        album: string;
        likeness: number;
    }[] = [];

    for (const item of (tasteProfile ?? [])) {
        processedProfile.push({
            id: item.songId,
            title: (songsIndex[item.songId] ? songsIndex[item.songId].title : ""),
            artists: (songsIndex[item.songId] ? songsIndex[item.songId].artists : []),
            album: (songsIndex[item.songId] ? songsIndex[item.songId].album : ""),
            likeness: item.similarity,
        })
    }

    res.status(200).json({
        error: false,
        data: processedProfile,
    });
});

app.get("/profile/:userId", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    let session = userSessions.find(v => v.u.user?.meta.serviceId == req.params.userId);

    let u: UserDocType | null = null;

    if (!session)
        u = await db.get<UserDocType>("users", req.params.userId, true);

    if (!session && !u) {
        res.status(404).json({
            error: true,
            message: `User with id "${req.params.userId}" not found`,
        });

        return;
    } else if (session?.u.user) {
        u = session.u.user;
    }

    const obj: Partial<UserDocType> = {
        me: u?.me,
    }

    res.json({
        error: false,
        data: obj,
    });
});

/** How far back the leaderboard looks. Matches the weekly stats and recap. */
const LEADERBOARD_PERIOD_MS = 3600e3 * 24 * 7;

/**
 * One user's board: their accepted friends and themselves, ranked.
 *
 * Shared by the endpoint and the morning digest so the two cannot disagree about
 * where somebody stands — a notification saying you moved up, followed by a
 * board that says otherwise, is worse than no notification.
 *
 * Reads profiles from the store rather than the session list: a friend who is
 * not currently being polled has listened just as much as one who is, and
 * reading sessions would make the board depend on who happens to be online.
 */
async function buildLeaderboardFor(viewerId: string) {
    const friendIds = await listFriendsIds(viewerId, true);

    const candidates: LeaderboardCandidate[] = [];

    for (const userId of friendIds) {
        const account = await db.get<UserDocType>("users", userId, false, true);

        if (!account)
            continue;

        const isViewer = (userId === viewerId);

        // Someone who has switched activity sharing off is left out before their
        // profile is even read: a weekly total is exactly the kind of thing that
        // setting withholds. Their own board still shows them.
        if (!isViewer && !account.settings?.shareListeningActivity)
            continue;

        const taste = await tasteStore.get(userId);

        candidates.push({
            userId,
            displayName: account.me?.displayName || "A friend",
            imageUrl: account.me?.images?.[0]?.url,
            history: taste?.history ?? [],
            sharing: (account.settings?.shareListeningActivity === true),
            isViewer,
        });
    }

    const now = Date.now();

    return buildLeaderboard(
        candidates,
        songId => songMetaCache.getItem(songId)?.duration,
        { start: now - LEADERBOARD_PERIOD_MS, end: now },
    );
}


/**
 * Friends ranked by how much they have listened over the past seven days.
 *
 * The measure is the one /profile/:userId/pastWeekStats already reports, so a
 * listener's position here and their own weekly figure there cannot disagree.
 *
 * Reads profiles from the store rather than from the session list: a friend who
 * is not currently being polled has listened just as much as one who is, and
 * leaving them out would make the board depend on who happens to be online.
 */
app.get("/me/leaderboard", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    try {
        const board = await buildLeaderboardFor(token.id);
        const now = Date.now();

        res.status(200).json({
            error: false,
            data: {
                periodStart: now - LEADERBOARD_PERIOD_MS,
                periodEnd: now,
                entries: board,
            },
        });
    } catch (ex) {
        console.error("Failed to build the leaderboard for", token.id, "error:", ex);

        res.status(500).json({
            error: true,
            message: "Unable to build the leaderboard",
        });
    }
});

app.get("/profile/:userId/pastWeekStats", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == req.params.userId);

    if (!session) {
        res.status(404).json({
            error: true,
            message: `User with id "${req.params.userId}" not found`,
        });

        return;
    }

    const denied = await denyProfileAccess(token.id, session);

    if (denied) {
        res.status(denied.status).json({ error: true, message: denied.message });

        return;
    }

    const startTimestamp = Date.now() - (3600e3 * 24 * 7);

    // Read from the store rather than the session's own copy, so this and the
    // leaderboard cannot report different weeks for the same person. The stored
    // profile is written on every poll; a session's copy is whatever that
    // process happens to be holding.
    const storedTaste = await tasteStore.get(req.params.userId);
    const taste = storedTaste ?? session.u.taste;

    const filteredStreaks = taste.streakHistory.filter(v => v.timestamp >= startTimestamp);

    const longestStreak = filteredStreaks.reduce((max, v) => Math.max(max, v.duration), 0);

    const filteredSessions = taste.history.map(v => {
        const songData = songMetaCache.getItem(v.songId);

        return {
            ...v,
            songData,
        };
    }).filter(v => {
        if (v.timestamp < startTimestamp)
            return;

        if (!v.songData)
            return false;

        return true;
    });

    let playCountTotals: {[key: string]: {
        c: number;
        d: number;
        i: SongData;
    }} = {};

    // Aggregate the sessions
    filteredSessions.forEach((v) => {
        if (v.skipped)
            return;

        if (!v.songData)
            return;

        if (!playCountTotals[v.songId]) {
            playCountTotals[v.songId] = {
                c: 1,
                d: v.sessionDuration * v.songData.duration,
                i: v.songData,
            };
        } else {
            playCountTotals[v.songId].c += 1;
            playCountTotals[v.songId].d += (v.sessionDuration * v.songData.duration);
        }
    });

    let totalListeningDuration = 0;

    const values = Object.values(playCountTotals);

    values.forEach(v => {
        totalListeningDuration += v.d;
    });

    const uniqueSongsPlayedCount = new Set(Object.keys(playCountTotals)).size;

    res.status(200).json({
        error: false,
        data: {
            totalListeningDuration,
            uniqueSongsPlayedCount,
            longestStreak,
        },
    });
});

app.get("/profile/:userId/topSongs/:period", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const period: "day" | "week" | "month" | "year" | "all" = req.params.period as any;

    // Include all by default
    let startTimestamp = 0;

    switch (period) {
        case "day":
            startTimestamp = Date.now() - (3600e3 * 24);
            break;
        case "week":
            startTimestamp = Date.now() - (3600e3 * 24 * 7);
            break;
        case "month":
            startTimestamp = Date.now() - (3600e3 * 24 * 30);
            break
        case "year":
            startTimestamp = Date.now() - (3600e3 * 24 * 365);
            break;
    }
    
    const session = userSessions.find(v => v.u.user?.meta.serviceId == req.params.userId);

    if (!session) {
        res.status(404).json({
            error: true,
            message: `User with id "${req.params.userId}" not found`,
        });

        return;
    }

    const denied = await denyProfileAccess(token.id, session);

    if (denied) {
        res.status(denied.status).json({ error: true, message: denied.message });

        return;
    }

    // Same store the past week stat and the leaderboard read, so the three
    // cannot describe different listening for the same person
    const storedTaste = await tasteStore.get(req.params.userId);

    const filteredSessions = (storedTaste ?? session.u.taste).history.filter(v => {
        if (v.timestamp < startTimestamp)
            return false;

        if (v.sessionDuration < 0.5)
            return false;

        const item = songMetaCache.getItem(v.songId);

        if (!item)
            return false;

        if (item.type !== "track")
            return false;

        return true;
    });

    let playCountTotals: {[key: string]: {
        c: number;
        d: number;
    }} = {};

    // Aggregate the sessions
    filteredSessions.forEach((v) => {
        if (v.skipped)
            return;

        const item = songMetaCache.getItem(v.songId);

        if (!item)
            return;

        if (!playCountTotals[v.songId]) {
            playCountTotals[v.songId] = {
                c: 1,
                d: v.sessionDuration * item.duration,
            };
        } else {
            playCountTotals[v.songId].c += 1;
            playCountTotals[v.songId].d += (v.sessionDuration * item.duration);
        }
    });

    // Sort playCountTotals by highest value
    const sortedPlayCounts = Object.entries(playCountTotals)
        // Sort by duration
        .sort(([, countA], [, countB]) => countB.d - countA.d)
        // Then by play count
        // This ensures ties have the longest session duration above
        .sort(([, countA], [, countB]) => countB.c - countA.c)
        .map(([songId, count], i) => {
            const item = songMetaCache.getItem(songId);

            if (!item)
                return null;

            return {
                id: item.id,
                title: item.name,
                artists: item.artists.map(v => v.name),
                index: i,
                explicit: item.explicit,
                playCount: count.c,
                imageUrl: item.album.artUrl,
            };
        });

    res.status(200).json({
        error: false,
        // Return items which arent nullish
        data: sortedPlayCounts.filter(v => v !== null),
    });
});

app.post("/me/taste/affinity", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    if (session.u.user?.meta.state == "reauth") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return
    }

    const songId = req.body.songId as string | undefined;
    const affinity = Math.max(Math.min(req.body.affinity as number | undefined ?? 0, 5), -5);

    if (!songId) {
        res.status(400).json({
            error: true,
            message: "No songId provided",
        });

        return;
    }

    if (isNaN(affinity)) {
        res.status(400).json({
            error: true,
            message: "Affinity must be a number",
        });

        return;
    }

    if (affinity == 0) {
        res.status(400).json({
            error: true,
            message: "Affinity cannot be 0",
        });

        return;
    }

    const song = songMetaCache.getItem(songId);

    if (!song) {
        res.status(404).json({
            error: true,
            message: "Song not found",
        });

        return;
    }

    session.u.addAffinityItem(songId, affinity);

    res.status(200).json({
        error: false,
        message: "OK",
    });
});

app.get("/me/taste", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    if (session.u.user?.meta.state == "reauth") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return
    }

    const tasteProfile = await session.u.tasteHandler?.generateTasteProfile({
        includeListenedMusic: false,
        taste: session.u.taste,
    });

    let processedProfile: {
        id: string;
        title: string;
        artists: string[];
        album: string;
        imageUrl: string;
        likeness: number;
    }[] = [];

    for (const item of (tasteProfile ?? [])) {
        const song = songMetaCache.getItem(item.songId);

        if (!song)
            continue;

        processedProfile.push({
            id: item.songId,
            title: song.name,
            artists: song.artists.map(v => v.name),
            album: song.album.name,
            imageUrl: song.album.artUrl,
            likeness: item.similarity,
        })
    }

    res.status(200).json({
        error: false,
        data: processedProfile.sort((a, b) => b.likeness - a.likeness).slice(0, 50),
    });
});

app.get("/me/notify/test", async (req, res) => {
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }
    
    notify.notifyUser(token.id, {
        title: "Hey there",
        message: "This is a test notification, all good?"
    });

    res.json({
        error: false,
        message: "Test notification sent!"
    });
});

app.get("/auth", async (_, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const redirUrl = await enrollNewUser();

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);
});

app.get("/auth/ui", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const redirUrl = await enrollNewUser(true);

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);
});

app.get("/auth/app/:swapToken", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const swapToken = req.params.swapToken;

    if (!tokSwapStore[swapToken]) {
        res.redirect(WEB_APP_URL + "/static-error");

        return;
    }

    const redirUrl = await enrollNewUser(false, swapToken);

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);
});

/**
 * Sign-in attempts are cheap to make and this one names an account, so it gets a
 * tighter budget than the global limiter: the authorize URL it hands back
 * carries the account's client_id, which would otherwise let someone probe which
 * accounts exist and which use an app of their own.
 */
const authStartLimiter = rateLimit({
    windowMs: 15 * 60e3,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        error: true,
        message: "Too many sign-in attempts, try again shortly",
    },
    statusCode: 429,
    keyGenerator: limiterKeyGen,
});

/**
 * Pulls a Spotify user id out of whatever the user pasted.
 *
 * A profile link is far easier to lay hands on than the username itself, and
 * both forms carry the id verbatim.
 */
function normaliseSpotifyIdentifier(raw: string): string {
    const trimmed = raw.trim();
    const linked = trimmed.match(/(?:open\.spotify\.com\/user\/|spotify:user:)([A-Za-z0-9._-]+)/);

    return (linked ? linked[1] : trimmed.split(/[?#]/)[0]);
}

/**
 * The Spotify app a returning account already authorised against, if it is not
 * Tempo's own.
 *
 * Reinstalling leaves nothing on the device to say which app an account used, so
 * without this a bring-your-own-app user is sent at Tempo's app, refused by
 * Spotify for not being on its development allowlist, and walked through
 * creating an app all over again — re-entering a client secret the server has
 * had all along. Only the client id is needed to start the flow; the stored
 * secret completes it.
 */
/**
 * Whether a client ID and secret still work.
 *
 * A client-credentials grant asks Spotify to authenticate the pair and nothing
 * else — no user, no scopes, no consent screen — which is exactly the question
 * being asked here.
 *
 * Three answers, not two: working, rejected, and unreachable. Treating an
 * outage as a rejection would tell somebody their app is broken because
 * Spotify was down, and send them off to remake credentials that are fine.
 */
async function spotifyCredentialsState(
    clientId: string,
    clientSecret: string,
): Promise<"ok" | "rejected" | "unreachable"> {
    try {
        const check = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: clientSecret,
            }),
        });

        return (check.ok ? "ok" : "rejected");
    } catch (ex) {
        console.error("Could not reach Spotify to check credentials, error:", ex);

        return "unreachable";
    }
}

/**
 * The account somebody means, by id or by the name they see.
 *
 * The field asks for a "Spotify username or profile link", and the username
 * most people know is their display name — the one shown on their profile —
 * not the id it resolves to. Only ids were ever looked up, so anybody typing
 * what the field asked for was told no app was saved for them and walked
 * through setting one up they already had.
 *
 * A name match has to be unique to count. Display names are not unique, and the
 * credentials this leads to start a sign-in against somebody's own Spotify app
 * — not something to hand over on a coin flip between two people with the same
 * name. Ambiguous is treated as not found.
 */
async function accountForIdentifier(identifier: string): Promise<UserDocType | undefined> {
    /*
     * The id first, as a document read.
     *
     * The identifier becomes a document path, and DataStore reads "/" as a field
     * separator, so anything that is not a plain Spotify id is kept away from
     * this lookup rather than allowed to address part of a document. The name
     * match below never touches a path, so it does not need the same guard.
     */
    if (/^[A-Za-z0-9._-]{1,128}$/.test(identifier)) {
        const byId = await db.get<UserDocType>("users", identifier, false, true);

        if (byId)
            return byId;
    }

    const wanted = identifier.trim().toLowerCase();

    if (wanted === "")
        return undefined;

    // A scan, because the store has no query. It is one read of a small
    // collection on a rate limited route that a person reaches by hand, and it
    // only runs when the id lookup has already missed — but it is the first
    // thing to replace if this collection ever stops being small.
    const matches = (await db.all<UserDocType>("users"))
        .filter(account => (account?.me?.displayName ?? "").trim().toLowerCase() === wanted);

    return (matches.length === 1 ? matches[0] : undefined);
}

async function byoCredsForIdentifier(identifier: string | undefined) {
    if (!identifier)
        return undefined;

    const account = await accountForIdentifier(identifier);

    if (!account)
        return undefined;

    const [clientId, clientSecret] = credsForAccount(account);

    // Tempo's own app is what the ordinary flow already reaches for
    if (clientId === SPOT_CLIENT_ID)
        return undefined;

    return { clientId, clientSecret };
}

/**
 * Starts a sign-in, routed to whichever Spotify app the named account belongs to.
 *
 * The client id has to be chosen before the redirect, but Spotify only tells us
 * who signed in after it — so an account that authorised against its own app can
 * only be routed there if it identifies itself first. Unknown or absent
 * identifiers fall through to Tempo's app, which is exactly what /auth/ui does,
 * so an unrecognised name still gets a working sign-in rather than an error.
 *
 * POST rather than GET: the identifier names a person and has no business in a
 * URL, where proxies and access logs would keep it.
 */
app.post("/auth/start", authStartLimiter, async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).json({
            error: true,
            message: "Sorry, Tempo is currently unable to service your request!",
        });

        return;
    }

    const rawIdentifier = req.body.identifier as unknown;
    const swapToken = req.body.swapToken as unknown;

    if (swapToken !== undefined && (typeof swapToken !== "string" || !tokSwapStore[swapToken])) {
        res.status(400).json({
            error: true,
            message: "Unknown sign-in session",
        });

        return;
    }

    const identifier = (typeof rawIdentifier === "string" && rawIdentifier.trim() !== ""
        ? normaliseSpotifyIdentifier(rawIdentifier)
        : undefined);

    try {
        const byoCreds = await byoCredsForIdentifier(identifier);

        if (byoCreds)
            console.log("Routing sign-in for", identifier, "to its own Spotify app", byoCreds.clientId);

        /*
         * Check the stored pair still works before leaning on it.
         *
         * These were proved when they were first entered and then trusted
         * forever after, and they do not stay true: regenerating the client
         * secret on the Spotify dashboard, or deleting the app and making
         * another, leaves what is on file unable to authenticate. Nothing here
         * noticed, so sign-in went all the way out to Spotify, came back with a
         * code, and failed at the exchange with "invalid_client" — which was
         * logged as a failed account setup and shown as a generic error, with
         * nothing to tell the user their saved app is the part that is stale.
         *
         * Spotify being unreachable is deliberately not treated as a rejection:
         * an outage must not send somebody off to remake credentials that are
         * perfectly good.
         */
        if (byoCreds) {
            const stored = await spotifyCredentialsState(byoCreds.clientId, byoCreds.clientSecret);

            if (stored === "rejected") {
                console.warn("Stored Spotify app credentials for", identifier, "are no longer accepted");

                res.json({
                    error: true,
                    // Machine-readable so a caller can route to the setup page
                    // rather than parse the sentence below
                    reason: "app-credentials",
                    message: "Spotify no longer accepts the app saved for that account — its client secret was most likely regenerated. Set it up again below with the current client ID and secret.",
                });

                return;
            }
        }

        // Mirrors /auth/ui and /auth/app/:swapToken: a swap token means the
        // native flow, which finishes on a static page rather than in the app
        const redirUrl = await enrollNewUser(swapToken === undefined, swapToken as string | undefined, byoCreds);

        // Whether an app of their own was found, so the caller can say so
        // rather than sending them at Tempo's app to be refused all over again
        // and bounced back here with nothing explained. It does tell a caller
        // that a given Spotify account uses its own app, which is why this route
        // is rate limited more tightly than the rest — the alternative is a loop
        // the user cannot see the way out of.
        res.json({
            error: false,
            url: redirUrl,
            matched: (byoCreds !== undefined),
        });
    } catch (ex) {
        console.error("Failed to start a sign-in, identifier:", identifier, "error:", ex);

        res.status(500).json({
            error: true,
            message: "Unable to start sign-in",
        });
    }
});

app.get("/createTokenSwapSession", (_, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const tok = randomBytes(6).toString("hex");

    tokSwapStore[tok] = {
        token: "INIT",
    };

    res.json({
        error: false,
        token: tok,
    });
});

app.ws("/awaitTokenSwapSession/:swapToken", (ws, req) => {
    if (flagServerShutdown) {
        ws.send(JSON.stringify({
            error: true,
            message: "Sorry, Tempo is currently unable to service your request!",
        }));

        ws.close();

        return;
    }
    
    // express-ws types req.params values as string | string[]; a route parameter
    // is always a single value, and without narrowing it tsc rejects using it as
    // an index — which failed the Docker build, where a non-zero tsc exit stops
    // the layer rather than emitting anyway as it does locally
    const swapTokenRaw = req.params["swapToken"];
    const swapToken = Array.isArray(swapTokenRaw) ? swapTokenRaw[0] : swapTokenRaw;

    if (!tokSwapStore[swapToken]) {
        ws.send(JSON.stringify({
            error: true,
            message: "Invalid swap token",
        }));

        ws.close();

        return;
    }

    let running = false;

    ws.onmessage = m => {
        if (m.data.toString() !== "READY" || running)
            return;

        running = true;

        tokSwapStore[swapToken].completeCb = () => {
            if (ws.readyState !== WS_OPEN)
                return;
    
            tokSwapStore[swapToken].completeCb = undefined;
    
            ws.send(JSON.stringify({
                error: false,
                flag: "CALLED",
            }));

            console.log("ATSS CALLED SENT", swapToken);
    
            ws.close();
        }
    
        ws.send(JSON.stringify({
            error: false,
            flag: "READY",
        }));
    }
});

app.get("/swapToken/:swapToken", (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const swapToken = req.params.swapToken;

    if (!tokSwapStore[swapToken]) {
        res.status(400).json({
            error: true,
            message: "Invalid swap token",
        });

        return;
    }

    res.json({
        error: false,
        swap: tokSwapStore[swapToken].token,
    });
    
    if (tokSwapStore[swapToken].token !== "INIT" && tokSwapStore[swapToken].token !== "INIT")
        delete tokSwapStore[swapToken];
});

app.get("/chkauth", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).send("");

        return;
    }

    if (BYPASS_AUTH) {
        res.status(200).send("");

        return;
    }
    
    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    /*
     * No monitor for this account, which is not the same as nothing being wrong.
     *
     * A monitor is only ever created once an account has tokens: init waits on
     * doAuth, and for an account that has none doAuth raises the sign-in and
     * leaves its promise pending until that sign-in completes. So an account
     * whose first sign-in failed has no session and never will until it signs in
     * again - the exact case this needs to catch.
     *
     * Answering 200 here told the app it was signed in. It then asked /me, got a
     * 404 because there was likewise no session, and sat on the loading screen
     * with no account, no error and nowhere to go. Fall back to what the
     * database says instead of assuming the best.
     */
    if (!session) {
        const account = await db.get<UserDocType>("users", token.id, false, true);

        if (accountNeedsSignIn(account as unknown as SpotifyUser | undefined)) {
            console.log("Account", token.id, "has no monitor and no usable token - asking it to sign in again");

            res.status(403).send("");

            return;
        }

        res.status(200).send("");

        return;
    }

    if (accountNeedsSignIn(session.u.user)) {
        if (session.u.user?.meta.state == "unauth")
            console.log("Account", session.u.user?.meta.serviceId, "never finished signing in - prompting for it rather than reporting it as signed in");

        res.status(403).send("");

        return
    }

    res.status(200).send("");
});

app.get("/me", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint"
        });

        return;
    }

    if (BYPASS_AUTH) {
        res.status(200).json({
            error: false,
            data: {
                id: "fakeuser",
                displayName: "Fake User",
                email: "fakeuser@email.com"
            },
        });

        return;
    }
    
    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    if (session.u.user?.meta.state == "reauth") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return
    }

    /*
     * Catches a changed profile picture without waiting for a restart.
     *
     * Not awaited, and almost always free: it compares the recorded source URL
     * against the live one and returns immediately unless somebody has actually
     * changed their picture, in which case the next read of this endpoint carries
     * the new blob. Putting it here rather than in the auth paths keeps an image
     * fetch off the critical path of signing in.
     */
    ensureProfileColourBlob(token.id, session.u.user?.me)
    .catch(ex => {
        console.warn("Failed to refresh profile colour blob for", token.id, "error:", ex);
    });

    res.json({
        error: false,
        data: session.u.user?.me
    });
});

app.post("/me/feed/alert/viewed/:id", async (req, res) => {
    const alertId = req.params.id;

    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            type: "error",
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    if (session.u.user?.meta.state == "reauth") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return
    }

    try {
        await session.u.markPriorityFYPAlertViewed(alertId)
    } catch (ex) {
        console.error("Failed to mark alert with id", alertId, "viewed, error:", ex);

        res.status(500).json({
            error: true,
            message: "Sorry, something went wrong",
        });

        return;
    }

    res.status(200).json({
        error: false,
        message: "OK",
    });
});

app.get("/me/feed/:pageNumber", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            type: "error",
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    const session = userSessions.find(v => v.u.user?.meta.serviceId == token.id);

    if (!session) {
        res.status(404).json({
            error: true,
            message: "Unable to find session"
        });

        return;
    }

    if (session.u.user?.meta.state == "reauth") {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return
    }

    const preset = req.query.p as "activity" | "discover" | undefined;
    const pageNumber = parseInt(req.params.pageNumber);

    if (isNaN(pageNumber)) {
        res.status(400).json({
            type: "error",
            message: "Invalid page number \"" + req.params.pageNumber + "\", make sure it is an integer",
        });

        return;
    }

    const feedConfig = {
        typeProbabilities: {
            history: 0.45,
            discover: 0.55,
        },
        maxItems: 20,
    }

    if (preset == "activity") {
        feedConfig.typeProbabilities = {
            history: 0.95,
            discover: 0.05,
        }
    } else if (preset == "discover") {
        feedConfig.typeProbabilities = {
            history: 0,
            discover: 1,
        }
    }

    // ---- FRIEND'S LISTENERSHIP HISTORY ----

    const availableUsers = await listFriendsIds(token.id, false);

    const offset = 3600e3 * 24 * 4;

    const startDate = Date.now() - offset;
    const endDate = Date.now();

    const INCLUDE_FULL_DATA = false;

    // Get the listenership data
    const unfiltered = userSessions.filter(v => availableUsers.includes(v.u.user?.meta.serviceId ?? "")).map(v => {
        let todayHistory = v.u.taste.history.filter((a, i) => {
            const valid = (a.timestamp >= startDate && a.timestamp < endDate);

            return valid
        });

        // If we dont want to include all data, only include interesting events
        // - Not skipped (v.sessionDuration >= 0.2) (Dont use v.skipped as we want to tolerate less of song being listened to)
        // - Replayed
        if (!INCLUDE_FULL_DATA) {
            todayHistory = todayHistory.filter(v => {
                return (v.sessionDuration >= 0.2 || v.replayed);
            });
        }

        return {
            userId: v.u.user?.meta.serviceId ?? "",
            username: v.u.user?.me.displayName ?? "",
            // A Spotify account with no profile picture has an empty images
            // array, and this indexed straight into it — so one avatar-less
            // listener in the session list took the whole feed down with it.
            // pfpUrl is optional downstream, so absent is a fine answer.
            pfpUrl: v.u.user?.me.images?.[0]?.url,
            pfpColourBlob: v.u.user?.me.profilePictureColourBlob,
            // (b.timestamp - a.timestamp) will sort in reverse order
            history: todayHistory.sort((a, b) => (b.timestamp - a.timestamp)),
        };
    }).filter(v => v.username !== "" && v.userId !== "");
    
    // Destructure processedUserHistory and store array of song listening sessions
    let processedSessions: {
        userId: string;
        username: string;
        pfpUrl?: string;
        pfpColourBlob?: string;
        previewUrl?: string;
        item: {
            track: SongData;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
        };
        timestamp: number;
    }[] = [];

    for (const item of unfiltered) {
        item.history.forEach(v => {
            const track = songMetaCache.getItem(v.songId);

            if (!track)
                return;

            processedSessions.push({
                userId: item.userId,
                username: item.username,
                pfpUrl: item.pfpUrl,
                pfpColourBlob: item.pfpColourBlob,
                item: {
                    track,
                    sessionDuration: v.sessionDuration,
                    skipped: v.skipped,
                    replayed: v.replayed,
                },
                timestamp: v.timestamp,
            });
        });
    }

    // ---- USER'S RECOMMENDATIONS ----

    const tasteProfile = await session.u.tasteHandler?.generateTasteProfile({
        includeListenedMusic: false,
        taste: session.u.taste,
    });

    let processedProfile: {
        id: string;
        title: string;
        artists: string[];
        album: string;
        imageUrl: string;
        previewUrl?: string;
        likeness: number;
    }[] = [];

    for (const item of (tasteProfile ?? [])) {
        const song = songMetaCache.getItem(item.songId);

        if (!song)
            continue;

        processedProfile.push({
            id: item.songId,
            title: song.name,
            artists: song.artists.map(v => v.name),
            album: song.album.name,
            imageUrl: song.album.artUrl,
            likeness: item.similarity,
        })
    }

    const discoverContent = processedProfile
    .sort((a, b) => b.likeness - a.likeness)
    .slice(0, 125); // Only include top 50 songs

    processedSessions = processedSessions.sort((a, b) => b.timestamp - a.timestamp).slice(0, 125);

    let feed = getUserFeed(token.id, [
        ...processedSessions.map(v => {
            const itm: FeedItem = {
                type: "history",
                data: v,
            };

            return itm;
        }),
        ...discoverContent.map(v => {
            const itm: FeedItem = {
                type: "discover",
                data: v,
            };

            return itm;
        }),
    ], pageNumber, feedConfig);

    try {
        const alerts = await session.u.getPriorityFYPAlerts();

        const processed = alerts.map(v => {
            const itm: FeedItem = {
                type: "alert",
                data: {
                    id: v.id,
                    alertType: v.alertType,
                    content: v.content,
                },
            };

            return itm;
        });

        feed = [...processed, ...feed];
    } catch { }

    // Resolve preview URLs concurrently.
    //
    // This used to await one Deezer lookup at a time, so a 20-item page cost 20
    // serial round-trips before anything was sent. Distinct ISRCs are also
    // deduplicated, since the same track can appear more than once on a page.
    const previewTargets: { index: number; isrc: string }[] = [];

    for (let i = 0; i < feed.length; i++) {
        const v = feed[i];

        if (!["discover", "history"].includes(v.type))
            continue;

        const id = (v.type == "discover")
            ? (v.data as { id: string; }).id
            : (v.data as { item: { track: SongData } }).item.track.id;

        const t = songMetaCache.getItem(id);

        if (!t || !t.isrc)
            continue;

        previewTargets.push({ index: i, isrc: t.isrc });
    }

    const uniqueIsrcs = [...new Set(previewTargets.map(v => v.isrc))];

    const resolved = new Map<string, string>();

    await Promise.all(uniqueIsrcs.map(async isrc => {
        try {
            const preview = await getPreviewWithISRC(isrc);

            if (preview)
                resolved.set(isrc, preview);
        } catch (ex) {
            // A missing preview must not fail the whole feed
            console.verbose("warn", "Failed to resolve preview for ISRC", isrc, "error:", ex);
        }
    }));

    for (const target of previewTargets) {
        const preview = resolved.get(target.isrc);

        if (preview)
            (feed[target.index].data as any).previewUrl = preview;
    }

    res.status(200).json({
        error: false,
        data: feed
    });
});

app.get("/profile/:userId/history/:pageNumber", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }

    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            type: "error",
            message: "You are not authorised to access this endpoint",
        });
        return;
    }

    const pageNumber = parseInt(req.params.pageNumber);

    if (isNaN(pageNumber)) {
        res.status(400).json({
            type: "error",
            message: `Invalid page number "${req.params.pageNumber}", make sure it is an integer`,
        });
        return;
    }

    const targetUser = userSessions.find(v => v.u.user?.meta.serviceId == req.params.userId);

    if (!targetUser) {
        res.status(404).json({
            error: true,
            message: `Unable to find user with id ${req.params.userId}`,
        });
        return;
    }

    const denied = await denyProfileAccess(token.id, targetUser);

    if (denied) {
        res.status(denied.status).json({ error: true, message: denied.message });

        return;
    }

    const INCLUDE_FULL_DATA = false;

    // 1. Get all listenership history for the user
    const unfiltered = userSessions
        .filter(v => (v.u.user?.meta.serviceId ?? "") === targetUser.u.user?.meta.serviceId)
        .map(v => {
            let todayHistory = v.u.taste.history;

            if (!INCLUDE_FULL_DATA) {
                todayHistory = todayHistory.filter(v => v.sessionDuration >= 0.2 || v.replayed);
            }

            return {
                userId: v.u.user?.meta.serviceId ?? "",
                username: v.u.user?.me.displayName ?? "",
                pfpUrl: v.u.pfpUrl,
                pfpColourBlob: v.u.user?.me.profilePictureColourBlob,
                history: todayHistory.sort((a, b) => b.timestamp - a.timestamp),
            };
        })
        .filter(v => v.username !== "" && v.userId !== "");

    let processedUserHistory: typeof unfiltered = [];

    // 2. Remove duplicates (keep latest sessions)
    for (const item of unfiltered) {
        const conflict = processedUserHistory.find(v => v.userId === item.userId);

        if (conflict && item.history[item.history.length - 1].timestamp > conflict.history[conflict.history.length - 1].timestamp) {
            processedUserHistory.splice(
                processedUserHistory.findIndex(v => v.userId === item.userId),
                1,
                item
            );
            continue;
        }

        // 3. Consolidate pauses/resumes
        let localHistory: typeof item.history = [];
        let combineTemp: typeof item.history = [];

        item.history.forEach((v, i) => {
            if (i === 0) {
                return localHistory.push(v);
            }

            const prev = item.history[i - 1];

            if (prev.songId === v.songId && prev.sessionDuration + v.sessionDuration <= 1 &&
                (combineTemp.length === 0 || combineTemp[combineTemp.length - 1].songId === v.songId)) {
                combineTemp.push(v);
            } else if (combineTemp.length > 0 && combineTemp[combineTemp.length - 1].songId !== v.songId) {
                if (combineTemp[combineTemp.length - 1].sessionDuration === 1) {
                    localHistory.push({
                        ...combineTemp[combineTemp.length - 1],
                        timestamp: combineTemp[0].timestamp,
                        skipped: false,
                    });
                } else {
                    localHistory = [...localHistory, ...combineTemp];
                }
                combineTemp = [];
                localHistory.push(v);
            } else {
                localHistory.push(v);
                combineTemp = [];
            }
        });

        if (combineTemp.length > 0) {
            if (combineTemp[combineTemp.length - 1].sessionDuration === 1) {
                localHistory.push({
                    ...combineTemp[combineTemp.length - 1],
                    timestamp: combineTemp[0].timestamp,
                    skipped: false,
                });
            } else {
                localHistory = [...localHistory, ...combineTemp];
            }
        }

        item.history = localHistory;
        processedUserHistory.push(item);
    }

    // 4. Flatten into a single list
    let processedSessions: {
        userId: string;
        username: string;
        pfpUrl?: string;
        pfpColourBlob?: string;
        item: {
            track: SongData;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
        };
        timestamp: number;
    }[] = [];

    for (const item of processedUserHistory) {
        item.history.forEach(v => {
            const track = songMetaCache.getItem(v.songId);
            if (!track) return;

            processedSessions.push({
                userId: item.userId,
                username: item.username,
                pfpUrl: item.pfpUrl,
                pfpColourBlob: item.pfpColourBlob,
                item: {
                    track,
                    sessionDuration: v.sessionDuration,
                    skipped: v.skipped,
                    replayed: v.replayed,
                },
                timestamp: v.timestamp,
            });
        });
    }

    // 5. Sort all sessions newest first
    const sortedSessions = processedSessions.sort((a, b) => b.timestamp - a.timestamp);

    // 6. Paginate properly
    const PAGE_SIZE = 20;
    const start = pageNumber * PAGE_SIZE;
    const end = start + PAGE_SIZE;

    const pageData = sortedSessions.slice(start, end);

    const isFinalPage = end >= sortedSessions.length;

    res.json({
        error: false,
        data: pageData,
        isFinalPage,
    });
});

app.get("/spotify/public/sessions", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            type: "error",
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    res.json(userSessions.filter(v => v.u.user && v.u.user.me?.id !== "" && v.u.playbackState).map(v => v.u.user?.me.id));
});

async function getAvailableSessions(userId: string) {
    const availableUsers = await listFriendsIds(userId, true);

    return userSessions.filter(v => (v.u.user?.me?.id !== userId && v.u.user?.settings.shareListeningActivity || v.u.user?.me?.id === userId) && availableUsers.includes(v.u.user?.meta.serviceId ?? "") && v.u.user && v.u.user.me?.id !== "" && v.u.playbackState).map(v => v.u.user?.me.id).filter(v => v !== undefined);
}

app.get("/spotify/friends/sessions", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const token = await getAuthorisedUser(req);

    if (!token) {
        res.status(403).json({
            type: "error",
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    res.json(await getAvailableSessions(token.id));
});

app.get("/appauth/complete/:swapToken", (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const swapToken = req.params.swapToken;

    if (!tokSwapStore[swapToken]) {
        res.status(400).json({
            error: true,
            message: "Invalid swap token"
        });

        return;
    }

    if (tokSwapStore[swapToken].completeCb)
        tokSwapStore[swapToken].completeCb();
});

/**
 * The session socket currently held by each client.
 *
 * Keyed by a client-supplied id rather than by user, so a second device keeps
 * its own socket while a reconnect, reload or hot reload from the same client
 * replaces the one it had. Without this, stale sockets stayed bound as
 * listeners and every playback update was serialised and sent once per dead
 * connection — wasted bandwidth, and duplicate events arriving at the UI.
 *
 * A client that sends no id gets no replacement behaviour, which is the safe
 * default: better a redundant socket than closing someone else's.
 */
const activeSessionSockets: {[clientId: string]: { ws: WebSocket; userId: string }} = {};

/**
 * Pushes a message to every socket a user currently has open.
 *
 * Used for changes the client cannot discover on its own — a friend request
 * arriving has no polling path at all, so without this it stays invisible until
 * the user happens to open the add-friends page.
 */
function pushToUser(userId: string, payload: object) {
    for (const entry of Object.values(activeSessionSockets)) {
        if (entry.userId !== userId || entry.ws.readyState !== WS_OPEN)
            continue;

        try {
            entry.ws.send(JSON.stringify(payload));
        } catch (ex) {
            console.warn("Failed to push to a socket for user", userId, "error:", ex);
        }
    }
}

/** Client-supplied socket id, from the query string. Bounded and sanitised. */
function readClientId(req: Request): string | undefined {
    const raw = req.query?.["c"];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (typeof value !== "string")
        return undefined;

    return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : undefined;
}

const WS_OPEN = 1;

/** Socket code telling a client its friendships changed and should be refetched. */
const FRIENDSHIP_CHANGED_CODE = -30;

/**
 * Tells a client that has just connected to go and look at its friendships.
 *
 * A friend request is announced once, over the socket, at the moment it is made.
 * There is no poll for friendships, so a request that arrives while the socket
 * is closed — the app in the background, the phone asleep, the connection
 * dropped — is announced to nobody and stays invisible until the recipient
 * happens to open add-friends.
 *
 * Sending the same signal on connect closes that hole. It carries no new
 * information, and does not need to: the client's only response is to refetch,
 * so replaying it is exactly as correct as the original and cannot duplicate
 * anything.
 *
 * Only sent when something is actually waiting, so an ordinary reconnect does
 * not cost every client a refetch it has no use for.
 */
async function replayPendingFriendships(userId: string, ws: WebSocket) {
    try {
        const friendships = await listFriends(userId);

        // Requests made *to* this user. u1Id is whoever sent it, so their own
        // outgoing requests are not something to be told about.
        const pending = friendships.filter(v => v.state === "request" && v.u1Id !== userId);

        if (pending.length === 0)
            return;

        // The lookup above is asynchronous, so the socket may have gone again
        if (ws.readyState !== WS_OPEN)
            return;

        ws.send(JSON.stringify({
            code: FRIENDSHIP_CHANGED_CODE,
            id: "FriendshipChanged",
            data: { reason: "pending", friendshipId: pending[0].id, pending: pending.length },
        }));

        console.log("Replayed", pending.length, "pending friend request(s) to a reconnecting client for", userId);
    } catch (ex) {
        console.warn("Failed to replay pending friendships for", userId, "error:", ex);
    }
}

const sockHandler = (userId: string, ws: WebSocket, clientId?: string) => {
    if (clientId) {
        const previous = activeSessionSockets[clientId]?.ws;

        if (previous && previous !== ws) {
            console.log("Replacing session socket for client", clientId, "(user", userId + ")");

            try {
                // readyState, not ws.OPEN — the latter is the constant 1 and is
                // always truthy regardless of whether the socket is really open
                if (previous.readyState === WS_OPEN)
                    previous.close(4000, "Replaced by a newer session socket");
            } catch (ex) {
                console.warn("Failed to close the previous session socket for client", clientId, "error:", ex);
            }
        }

        activeSessionSockets[clientId] = { ws, userId };
    }

    // Fire-and-forget: anything waiting for this user is announced to them now
    // rather than having been announced while they were not listening
    replayPendingFriendships(userId, ws);

    // let sessions = userSessions.find(v => v.u.user && v.u.user.me.id == userId);
    let sessions: Monitor[] = [];

    const cbId = randomBytes(6).toString("hex");

    const deleteCb = (session?: Monitor) => {
        const targetSessions: Monitor[] = (session ? [session] : sessions);

        targetSessions.forEach((session) => {
            session.nosies = session.nosies.filter(v => v.id !== cbId);
        });
    }

    let closeCompleteCb: (() => void) | undefined;

    const ourSesh = userSessions.find(v => v.u.user?.meta.serviceId == userId);

    if (ourSesh) ourSesh.socketCloseOverride = () => {
        return new Promise<void>((resolve) => {
            console.log("Socket close override has been triggered for user", userId);
            
            closeCompleteCb = resolve;

            if (ws.readyState === WS_OPEN)
                ws.close();
            else
                resolve();
        });
    }

    const stateChangeHookId = randomBytes(6).toString("hex");

    sessionListenerStateHooks[stateChangeHookId] = {
        currentTargets: [],
        hook: () => {
            // Constant-vs-readyState: this never short-circuited, so closed
            // sockets kept being handed state-change advertisements
            if (ws.readyState !== WS_OPEN)
                return;

            getAvailableSessions(userId)
            .then(sessions => {
                ws.send(JSON.stringify({
                    id: "StateChangeAdvertisement",
                    code: -21,
                    data: sessions,
                }));
            });
        }
    }

    ws.onmessage = async (m) => {
        // Client readiness ping
        if (m.data.toString().startsWith("PING-")) {
            const pingId = m.data.toString().split("PING-")[1];

            ws.send(`PONG-${pingId}`);
            return;
        }

        if (!m.data.toString().startsWith("[") || !m.data.toString().endsWith("]"))
            return;

        const availableUsers = await listFriendsIds(userId, true);

        const userIdsPre = JSON.parse(m.data.toString()) as string[];

        // Filter out any users requested which the user is not friends with
        const userIds = userIdsPre.filter(v => {
            const base = [...availableUsers, "QUERY", "RM", "nocb", "QUERY-LAST-STATES"].includes(v);

            if (base)
                return true;

            if (userIdsPre.length == 2 && userIdsPre[0] == "QUERY")
                return true;

            if (userIdsPre.length >= 2 && userIdsPre[0] == "QUERY-LAST-STATES")
                return true;

            if (userIdsPre.length == 3 && userIdsPre[0] == "RM")
                return true;
        });

        // Query listeners
        // ["QUERY", "<callback id>"]
        if (userIds.length == 2 && userIds[0] == "QUERY") {
            ws.send(JSON.stringify({
                id: userIds[1],
                userIds: sessions.map(v => v.u.user?.meta.serviceId),
            }));

            return;
        }

        // Query last known states
        // ["QUERY-LAST-STATES", <query_id>, ...<user IDs>]
        if (userIds.length >= 2 && userIds[0] == "QUERY-LAST-STATES") {
            // Get the last playback state of each hooked monitor
            const searchIds = userIds.slice(2, userIds.length); // idx 0 == method id, idx 1 == callback id
            const lastStates = userSessions.filter(v => searchIds.includes(v.u.user?.meta.serviceId ?? v.u.user?.me.id ?? "")).map(v => v.u.lastPlaybackState);

            const data: {
                id?: string;
                code: number;
                data?: (PlaybackState | undefined)[];
            } = {
                id: `QLS-${userIds[1]}`,
                code: -22,
                data: lastStates,
            };

            ws.send(JSON.stringify(data));

            return;
        }

        // Remove a listener
        // ["RM", "<user id>", "<callback id>"]
        if (userIds.length == 3 && userIds[0] == "RM") {
            const found = sessions.find(v => v.u.user?.meta.serviceId == userIds[1])

            if (found)
                deleteCb(found);

            const before = [...sessions].map(v => v.u.user?.meta.serviceId);
            sessions = sessions.filter(v => v.u.user?.meta.serviceId !== userIds[1]);

            sessionListenerStateHooks[stateChangeHookId].currentTargets = sessions.filter(v => v.u.user?.meta.serviceId !== userIds[1]).map(v => v.u.user?.meta.serviceId ?? v.u.user?.me.id).filter(v => v !== undefined);

            if (userIds[2] !== "nocb") {
                ws.send(JSON.stringify({
                    id: userIds[2],
                    removed: before.filter(v => !sessions.map(a => a.u.user?.meta.serviceId).includes(v)),
                }));
            }

            return;
        }

        const boundUserIds = sessions.map(a => a.u.user?.meta.serviceId);
        const notBoundUserIds = userIds.filter(v => !boundUserIds.includes(v));

        sessionListenerStateHooks[stateChangeHookId].currentTargets = userIds;

        sessions = [...sessions, ...userSessions.filter(v => v.u.user && notBoundUserIds.includes(v.u.user.me?.id))];

        sessions.forEach(v => {
            // We have already attached a listener for this socket session dont add another
            if (v.nosies.some(v => v.id == cbId && v.requesterdId == userId))
                return;

            v.nosies.push({
                id: cbId,
                requesterdId: userId,
                cb(state) {
                    if (ws.readyState !== WS_OPEN) {
                        return deleteCb(v);
                    }

                    ws.send(JSON.stringify({
                        code: 200,
                        // Carried on the envelope because a STOPPED update has no
                        // state, and the user id otherwise only exists inside it —
                        // leaving the client unable to tell who stopped
                        userId: v.u.user?.me?.id ?? v.u.user?.meta.serviceId,
                        data: state,
                    }));
                },
            });

            if (!v.u.playbackState) {
                console.log("Failed to set up load event for", v.u.user?.me.id);
                return;
            }

            ws.send(JSON.stringify({
                code: 200,
                data: {
                    state: {
                        ...v.u.playbackState,
                        username: v.u.user ? v.u.user.me?.displayName : v.u.playbackState?.username ?? "",
                    },
                    action: "LOAD",
                }
            }));
        });
    }

    let keepAliveLoop = setInterval(() => {
        if (ws.readyState !== WS_OPEN)
            return;

        ws.send(JSON.stringify({
            code: -1
        }));
    }, 30e3);

    ws.onclose = () => {
        clearInterval(keepAliveLoop);
        deleteCb();

        // Only clear the registry if this socket is still the current one — a
        // replaced socket closing must not evict its replacement
        if (clientId && activeSessionSockets[clientId]?.ws === ws)
            delete activeSessionSockets[clientId];

        delete sessionListenerStateHooks[stateChangeHookId];
        
        if (closeCompleteCb)
            closeCompleteCb();
    };
}

app.ws("/stream/sessions", async (ws, req, res) => {
    const token = await getAuthorisedUser(req);

    if (!token) {
        ws.send(JSON.stringify({
            code: 403,
            message: "You are not authorised to view this endpoint"
        }));

        ws.close();

        return;
    }

    sockHandler(token.id, ws, readClientId(req));
});

// Same as above route but this one requires manual auth
app.ws("/stream/sessions/lazy", (ws, req) => {
    let authed = false;

    const authExpireTimeout = setTimeout(() => {
        if (ws.readyState !== WS_OPEN || authed)
            return;

        ws.close();
    }, 120e3);

    ws.onmessage = async (m) => {
        if (authed)
            return;

        try {
            const data = JSON.parse(m.data.toString()) as {
                overrideToken: string;
                clientId?: string;
            }

            const valid = await isAuthorised(data.overrideToken);

            if (!valid) {
                ws.send(JSON.stringify({
                    error: true,
                    message: "Invalid auth token"
                }));

                return;
            }

            authed = true;
            clearTimeout(authExpireTimeout);

            ws.send(JSON.stringify({
                error: false,
                message: "Token accepted",
                flag: "TOK_ACCEPT"
            }));

            sockHandler(valid.id, ws, data.clientId ?? readClientId(req));
        } catch { }
    }
});

export interface UserFriendship {
    id: string;
    u1Id: string;
    u2Id: string;
    stats: {
        streak: number;
        tasteMatchScore: number;
    };
    state: "request" | "friends" | "blocked";
    lastUpdated: number;
}

export interface SpotifyUser {
    data: {
        accessToken?: string;
        refreshToken?: string;
        expires: number;
        scope: string;
        tokenType: string;
    };
    me: {
        id: string;
        displayName?: string;
        images: {
            url: string;
            height: number;
            width: number;
        }[];
        listenerTypeClassification: string;
        /**
         * The account's picture reduced to a 4x4 grid of colours, base64. Drawn
         * as a blurred stand-in until the real picture loads — see profile-blob.ts.
         */
        profilePictureColourBlob?: string;
        /**
         * Which picture the blob above was made from, so it is recomputed when
         * somebody changes their picture rather than describing their old one
         * forever.
         */
        profilePictureColourBlobFor?: string;
    };
    serverCreds: {
        clientId: string;
        clientSecret: string;
    };
    meta: {
        state: "unauth" | "authvalid" | "reauth" | "srverr";
        serviceId: string;
        nextRefresh: number;
        token: string;
        dayRecapAvailableDate: number;
        weekRecapAvailableDate: number;
        viewedDailyRecap: string;
        viewedWeeklyRecap: string;
        priorityFYPAlerts: {
            id: string;
            alertType: "ListenerTypeChange";
            content: any;
            expires: "After-View" | number;
            metaAlertVersion: "pr" | "r";
        }[];
        /** Revocation counter; see TempoTokenType.tokenVersion in jwtauth.ts */
        tokenVersion: string;
    };
    settings: {
        shareListeningActivity: boolean;
        // Not yet implemented
        // publicProfile: boolean;
        // friendSuggestions: boolean;
        // friendRequestsNotifications: boolean;
        // dailyRecapNotifications: boolean;
        // weeklyRecapNotifications: boolean;
        // reactionNotifications: boolean;
    };
    // A string array of friendship IDs
    friends: string[];
};

const defaultSettingsObject: SpotifyUser["settings"] = {
    shareListeningActivity: true,
};

function createAuthSession(username: string, cb: (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => Promise<void>, isEnrollment?: boolean, useServerCreds?: boolean, redirUri?: string) {
    const state = randomBytes(4).toString("hex");

    authSessions[state] = {
        username,
        successRedirect: (redirUri ? redirUri + "success" : undefined),
        errorRedirect: (redirUri ? redirUri + "error" : undefined),
        cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => {
            // Make sure session isnt removed while it is being used
            try{ clearTimeout(authSessions[state].rTimeout); } catch { }

            return cb(authSessions[state], code, clientId, clientSecret, res, storeMe);
        },
        useServerCreds,
        enroll: isEnrollment,
        rTimeout: setTimeout(() => {
            if (!authSessions[state])
                return;
    
        }, 60e3 * 5),
        remove: () => {
            if (!authSessions[state])
                return;

            try{ clearTimeout(authSessions[state].rTimeout); } catch { }

            delete authSessions[state];
        }
    };

    return state;
}

function createEmptyListenershipAggregate(fillNumber?: number) {
    // const baseWeeklyListenership: UserListenership = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0) as DailyListenership) as UserListenership;

    let b: [number[][], number][] = [];

    for (let c = 0; c < 4; c++) {
        let builder: number[][] = []

        for (let i = 0; i < 7; i++) {
            builder.push([]);

            for (let a = 0; a < 24; a++) {
                builder[i].push(fillNumber ?? -1);
            }
        }

        b.push([builder, -1]);
    }

    return b as UserTaste["hourlyListenershipAggregate"];

    // return JSON.parse(JSON.stringify(Array.from({ length: 4 }, () => [baseWeeklyListenership, -1]) as UserTaste["hourlyListenershipAggregate"]));
}

class User extends EventEmitter {
    public spotifyApi: SpotifyWebApi;
    public playbackState?: PlaybackState;
    public taste: UserTaste;
    private userId?: string;
    private auth?: {
        accessToken: string;
        refreshToken: string;
        expires: number;
        scope: string;
        tokenType: string;
    };
    public user?: SpotifyUser;
    public typicalListeningSchedule?: UserListenership;
    private redirUri?: string;
    private replayCount: number;
    private displaySeed: number;
    public playSessionStart: number;
    public interestingEventTimestamp: number;
    public tasteHandler?: Taste;
    public pfpUrl?: string;
    private detach: boolean;
    public lastPlaybackState: PlaybackState | undefined;

    constructor(clientId: string, clientSecret: string, redirUri?: string) {
        super();

        this.taste = {
            songData: {},
            history: [],
            streakHistory: [],
            affinityHistory: [],
            tasteEvolution: [],
            hourlyListenershipAggregate: createEmptyListenershipAggregate(),
        };

        this.spotifyApi = new SpotifyWebApi({
            clientId: clientId,
            clientSecret: clientSecret,
            redirectUri: SPOT_REDIRECT_URI
        });

        this.redirUri = redirUri;
        this.replayCount = 0;
        this.displaySeed = Math.random();
        this.playSessionStart = -1;
        this.interestingEventTimestamp = -1;
        this.detach = false;
        this.lastPlaybackState = undefined;
    }

    async init(user: SpotifyUser) {
        if (this.detach)
            return;

        this.user = await this.doAuth(user);

        if (!this.auth) {
            console.error("Authentication failed");

            return;
        }

        incrementRequestCount();

        const me = await this.spotifyApi.getMe();
        
        this.userId = me.body.id;

        /*
         * A session that cannot read the stored profile must not start.
         *
         * Everything below saves this.taste back - the write a few lines down,
         * the monitor's periodic saves, the save on detach. If the load failed
         * while a profile exists, this.taste is the empty object built a moment
         * ago, and the very next save would replace months of history with it.
         * No session at all is strictly better than that: the throw is caught
         * per user by the bootstrap scan and by enrolment, and the account is
         * retried on the next scan rather than run in a state that erases.
         */
        const tasteState = await this.loadTasteProfile();

        if (tasteState === "error")
            throw new Error("Refusing to start a session for " + this.userId + " without its stored taste profile - saving now could overwrite real history");

        if (!this.taste.hourlyListenershipAggregate)
            this.taste.hourlyListenershipAggregate = createEmptyListenershipAggregate();

        await this.saveTasteProfile();

        this.taste = {
            songData: {},
            history: [],
            streakHistory: [],
            affinityHistory: [],
            tasteEvolution: [],
            hourlyListenershipAggregate: createEmptyListenershipAggregate(),
        };

        if (await this.loadTasteProfile() === "error")
            throw new Error("Refusing to start a session for " + this.userId + " without its stored taste profile - saving now could overwrite real history");

        const listenership = this.getAverageDailyListenership(this.taste.hourlyListenershipAggregate, this.user.me?.id);

        this.typicalListeningSchedule = listenership;
        this.tasteHandler = new Taste(this.user.me?.id);

        console.log(`[${this.user.me?.id}]`, "Average monthly user listenership length", listenership.length);

        // Load previous streak if available
        if (previousStreaks[this.userId]) {
            this.playSessionStart = previousStreaks[this.userId];
            
            delete previousStreaks[this.userId];
        }

        if (this.user.me?.id) {
            try {
                const currentSettings = await db.get<UserDocType["settings"]>("users", this.user.me.id + "/settings");

                const patchedSettings: UserDocType["settings"] = {
                    ...defaultSettingsObject,
                    ...(currentSettings ?? {}),
                };

                const currentHash = objectHash(currentSettings, { unorderedObjects: true });
                const patchedHash = objectHash(patchedSettings, { unorderedObjects: true });

                if (currentHash !== patchedHash) {
                    await db.set<UserDocType["settings"]>("users", this.user.me.id + "/settings", patchedSettings);

                    console.log("Patched invalid user settings object for user", this.user.me.id, "unpatched:", currentSettings, `(${currentHash})`, "patched:", patchedSettings, `(${patchedHash})`);
                }
            } catch (ex) {
                console.error("Settings object integrity check failed for user", this.user.me.id, "error:", ex);
            }
        }

        const existingSesh = userSessions.find(v => v.u.user?.me && v.u.user.me?.id == me.body.id);

        if (!existingSesh) {
            userSessions.push({
                u: this,
                nosies: [],
                lastPlaySessionStart: this.playSessionStart,
            });
        } else if (existingSesh) {
            existingSesh.u = this;

            // Otherwise the monitor keeps whatever it was holding before the
            // session was rebuilt, and the loss check compares against a start
            // this user no longer has
            existingSesh.lastPlaySessionStart = this.playSessionStart;
        }
    }

    broadcastPlaybackUpdate(data: {
        state?: PlaybackState;
        action: string;
    }) {
        if (this.detach)
            return;

        if (!this.user)
            return;
        
        const session = userSessions.find(v => v.u.user && v.u.user.me?.id == this.user?.me.id)

        if (!session)
            return;

        const cbs = session.nosies;

        for (const cb of cbs) {
            if (cb.requesterdId !== this.userId && !this.user.settings.shareListeningActivity)
                continue;

            try { cb.cb(data); } catch { }
        }

        if (this.playbackState)
            this.playbackState.lastEventSentAt = new Date().getTime();
    }

    analyseDailyListenershipForSong(dayStartTime: number, songId: string): SongStatistic {
        if (this.detach)
            throw new Error("Unable to execute analyseDailyListenershipForSong: User has been detached");

        const timePeriodEnd = dayStartTime + (3600e3 * 24);

        const inPeriodHistory = this.taste.history.filter(v => (v.timestamp >= dayStartTime && v.timestamp <= timePeriodEnd) && v.songId == songId);

        if (inPeriodHistory.length == 0) return {
            totalListenCount: 0,
            completeListenCount: 0,
            averageSessionDuration: 0,
            totalSessionDuration: 0,
            skipCount: 0,
            replayCount: 0,
        };

        const stats: SongStatistic = {
            totalListenCount: inPeriodHistory.length,
            completeListenCount: inPeriodHistory.filter(v => v.sessionDuration >= 0.6).length,
            averageSessionDuration: (inPeriodHistory.map(v => v.sessionDuration).reduce((a, b) => (a + b)) / inPeriodHistory.length),
            totalSessionDuration: inPeriodHistory.map(v => v.sessionDuration).reduce((a, b) => (a + b)),
            skipCount: inPeriodHistory.filter(v => v.skipped).length,
            replayCount: inPeriodHistory.filter(v => v.replayed).length,
        }

        return stats;
    }

    async markPriorityFYPAlertViewed(id: string) {
        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", true)) ?? [];

        const filteredAlerts = existingAlerts.filter(v => v.id !== id);

        await db.update<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", filteredAlerts as UserDocType["meta"]["priorityFYPAlerts"]);
    }

    async getPriorityFYPAlerts() {
        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", true)) ?? [];

        const now = Date.now();

        // Make sure alerts are not expired
        const filteredAlerts = existingAlerts.filter(v => v.metaAlertVersion == EXPECTED_ALERT_VERSION && v.id && (v.expires == "After-View" || v.expires > now));

        await db.update<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", filteredAlerts as UserDocType["meta"]["priorityFYPAlerts"]);

        // Ignore expired alerts
        return existingAlerts.filter(v => v.metaAlertVersion == EXPECTED_ALERT_VERSION && v.id && (v.expires == "After-View" || v.expires >= now));
    }

    async addPriorityFYPAlert<T>(type: UserDocType["meta"]["priorityFYPAlerts"][0]["alertType"], content: T, expires: "After-View" | number) {
        const id = randomBytes(12).toString("hex");

        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", true)) ?? [];
        const newAlertsObj: UserDocType["meta"]["priorityFYPAlerts"] = [
            {
                id,
                alertType: type,
                content,
                expires,
                metaAlertVersion: "r",
            },
            ...existingAlerts,
        ];

        await db.update<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", newAlertsObj as UserDocType["meta"]["priorityFYPAlerts"]);
    }

    getAverageDailyListenership(listenershipAggregate: UserTaste["hourlyListenershipAggregate"], userId?: string) {
        if (this.detach)
            throw new Error("Unable to execute getAverageDailyListenership: User has been detached");

        let listenershipAggregateSum: UserListenership = createEmptyListenershipAggregate(0)[0][0];
        let nullListenershipOffset: number = 0;

        // Combine all the aggregated data into listenershipAggregateSum
        listenershipAggregate.forEach(v => {
            const week = v[0];

            let localNullCount = 0;
            
            for (let a = 0; a < week.length; a++) {
                const day = week[a];
                    
                if (day.every(v => v == -1)) {
                    localNullCount++;
                    continue;
                }
                
                const aggregate = listenershipAggregateSum[a];

                day.forEach((v, i) => {
                    aggregate[i] += v;
                });
            }

            if (localNullCount == week.length)
                nullListenershipOffset++;
        });

        // Calculate average of the aggregate (or set to empty if no data is available)
        const avgMonthlyListenership = ((listenershipAggregate.length - nullListenershipOffset) == 0 ?
            (new Array<DailyListenership>(7) as UserListenership).fill((new Array<number>(24) as DailyListenership).fill(0)) :
            listenershipAggregateSum.map(v => {
                const week = v;
                
                week.forEach((v, i) => {
                    week[i] = v / (listenershipAggregate.length - nullListenershipOffset);
                });

                return week;
            }) as UserListenership);
        
        // Update user`s listener type
        // Casual Listener (0–3 hrs/week)
        // Tune Treader (4–5 hrs/week)
        // Beat Seeker (6–8 hrs/week)
        // Groove Enthusiast (9–11 hrs/week)
        // Melody Maven (12–19 hrs/week)
        // Rhythm Rider (20–31 hrs/week)
        // Sound Junkie (32–44 hrs/week)
        // Playlist Pro (45–56 hrs/week)
        // Audio Addict (57+ hrs/week)
        if (userId) {
            const history = userSessions.find(v => v.u.userId == userId)?.u.taste.history;

            if (history) {
                const durations = history.map(v => {
                    // Past week
                    if (Date.now() - v.timestamp > 604800000)
                        return;

                    const song = songMetaCache.getItem(v.songId)

                    if (!song)
                        return;

                    return (song.duration * v.sessionDuration);
                }).filter(v => v !== undefined);

                let totalDuration = 0;

                durations.forEach(v => {
                    totalDuration += v;
                });

                const hours = (totalDuration / 3600e3);

                let hasIncreased = false;
                let previousTier = -1;

                const userSession = userSessions.find(v => v.u.userId == userId);

                const tiers: {[key: string]: number} = {
                    "Casual Listener": 1,
                    "Tune Treader": 2,
                    "Beat Seeker": 3,
                    "Groove Enthusiast": 4,
                    "Melody Maven": 5,
                    "Rhythm Rider": 6,
                    "Sound Junkie": 7,
                    "Playlist Pro": 8,
                    "Audio Addict": 9,
                    "Basically Dylan": 10,
                }

                if (userSession?.u.user?.me?.listenerTypeClassification)
                    previousTier = tiers[userSession?.u.user?.me?.listenerTypeClassification];

                let listenerTypeClassification = "Casual Listener";

                if (hours >= 4 && hours <= 5) {
                    listenerTypeClassification = "Tune Treader";
                } else if (hours >= 6 && hours <= 8) {
                    listenerTypeClassification = "Beat Seeker";
                } else if (hours >= 9 && hours <= 11) {
                    listenerTypeClassification = "Groove Enthusiast";
                } else if (hours >= 12 && hours <= 19) {
                    listenerTypeClassification = "Melody Maven";
                } else if (hours >= 20 && hours <= 31) {
                    listenerTypeClassification = "Rhythm Rider";
                } else if (hours >= 32 && hours <= 44) {
                    listenerTypeClassification = "Sound Junkie";
                } else if (hours >= 45 && hours <= 56) {
                    listenerTypeClassification = "Playlist Pro";
                } else if (hours >= 57 && hours <= 157) {
                    listenerTypeClassification = "Audio Addict";
                } else if (hours >= 158) {
                    listenerTypeClassification = "Basically Dylan";
                }

                const newTier = tiers[listenerTypeClassification];

                db.update<UserDocType["me"]["listenerTypeClassification"]>("users", userId + "/me/listenerTypeClassification", listenerTypeClassification)
                .then(async () => {
                    if (userSession?.u.user?.me) {
                        userSession.u.user.me.listenerTypeClassification = listenerTypeClassification;
                    }

                    if (newTier > previousTier) {
                        try {
                            await this.addPriorityFYPAlert<string>("ListenerTypeChange", listenerTypeClassification, "After-View");
                        } catch (ex) {
                            console.warn("Failed to add priority alert for updated listener type, error:", ex);
                        }
                    }

                    console.log("Updated listenerTypeClassification for user", userId, "value:", listenerTypeClassification, "avgWeeklyListenership:", hours, "hours");
                })
                .catch(ex => {
                    console.warn("Failed to update listenerTypeClassification, error:", ex, "userId:", userId);
                });
            }
        }
        
        return avgMonthlyListenership;
    }

    doAuth(user: SpotifyUser) {
        return new Promise<SpotifyUser>(async (resolve, reject) => {
            if (this.detach) {
                reject("Unable to authorise user " + user.meta.serviceId + ": User has been detached!");

                return;
            }

            if (!user.data?.accessToken || !user.data?.refreshToken) {
                console.log("User not authenticated, userId:", user.me?.id);

                const state = createAuthSession(user.me?.displayName || "User", async (session: AuthSession, code: string) => {
                    session.remove();

                    incrementRequestCount();

                    const a = await this.spotifyApi.authorizationCodeGrant(code);
        
                    const data = {
                        accessToken: a.body.access_token,
                        refreshToken: a.body.refresh_token,
                        expires: new Date().getTime() + (a.body.expires_in * 1e3),
                        scope: a.body.scope,
                        tokenType: a.body.token_type,
                    };
        
                    this.spotifyApi.setRefreshToken(data.refreshToken);
                    this.spotifyApi.setAccessToken(data.accessToken);
                    this.auth = data;

                    incrementRequestCount();
        
                    const me = await this.spotifyApi.getMe();

                    session.me = me;
        
                    const prevConf = await db.get<UserDocType>("users", user.meta.serviceId);
        
                    const token = createAuthToken(user.meta.serviceId);

                    // The app this account actually authorised against. Tempo's
                    // was written here unconditionally, so re-authenticating a
                    // bring-your-own-app user replaced their credentials with
                    // Tempo's — after which every refresh presented the wrong
                    // client for a refresh token their own app had issued, and
                    // Spotify rejected all of them.
                    const [accountClientId, accountClientSecret] = credsForAccount(prevConf ?? undefined);

                    const payload: SpotifyUser = {
                        data,
                        me: {
                            ...me.body,
                            displayName: me.body.display_name,
                            images: me.body.images as SpotifyUser["me"]["images"],
                            listenerTypeClassification: prevConf?.me.listenerTypeClassification ?? "Casual Listener"
                        },
                        serverCreds: {
                            clientId: accountClientId,
                            clientSecret: accountClientSecret,
                        },
                        meta: {
                            ...prevConf!.meta,
                            state: "authvalid",
                            token,
                        },
                        settings: {
                            shareListeningActivity: prevConf?.settings?.shareListeningActivity ?? defaultSettingsObject.shareListeningActivity,
                        },
                        friends: (prevConf?.friends ?? []),
                    };

                    const idx = userSessions.findIndex(v => v.u.user?.meta.serviceId == payload.meta.serviceId);

                    if (idx !== -1) {
                        userSessions[idx].u.user = payload;
                    }

                    await db.set<UserDocType>("users", me.body.id, payload);
        
                    resolve(payload);
                }, false, false, this.redirUri);

                /*
                 * The authorize step and the exchange have to name the same app.
                 *
                 * This is a second sign-in, with a state of its own — the one
                 * enrolment remembered credentials against is already spent. The
                 * route that builds the authorize URL looks them up by state and
                 * falls back to Tempo's when it finds none, so a
                 * bring-your-own-app account was sent to consent against Tempo's
                 * app and the code that came back was then exchanged against
                 * theirs. Spotify answers that with invalid_client, and it
                 * happened on the first set-up: enrol, no token yet, straight
                 * into this path.
                 *
                 * Read off the API client rather than the account, because that
                 * client is what performs the exchange — so whatever it is
                 * holding is by definition the app that has to be named here.
                 */
                const authorizeClientId = this.spotifyApi.getClientId();
                const authorizeClientSecret = this.spotifyApi.getClientSecret();

                if (authorizeClientId && authorizeClientSecret && authorizeClientId !== SPOT_CLIENT_ID)
                    rememberByoCreds(state, { clientId: authorizeClientId, clientSecret: authorizeClientSecret });

                this.emit("auth", BASE_URL + "/spotify/auth/" + (user.meta?.serviceId ?? user.me?.id) + "/" + state);

                return;
            }

            this.spotifyApi.setRefreshToken(user.data.refreshToken);
            this.spotifyApi.setAccessToken(user.data.accessToken);

            if (user.data.expires < new Date().getTime() + (5 * 60e3)) {
                console.log("Refreshing token for user", user.me?.id);

                try {
                    await this.refreshSpotifyToken(user);
                } catch (ex) {
                    reject(ex);

                    return;
                }
            }

            if (user.data.accessToken && user.data.refreshToken && (this.auth?.expires ?? 0) < user.data.expires) {
                this.auth = user.data as {
                    accessToken: string;
                    refreshToken: string;
                    expires: number;
                    scope: string;
                    tokenType: string;
                };
            } else if (!this.auth || !(user.data.accessToken && user.data.refreshToken)) {
                reject("Access token or refresh token is missing");

                return;
            }

            if (this.auth.expires < new Date().getTime() + (120 * 1e3)) {
                console.log("Refreshing token for", user.me?.id);

                let state: any = undefined;

                try {
                    state = await this.refreshSpotifyToken();
                } catch (ex) { }

                if (!state || state == "srverr") {
                    const prevConf = await db.get<UserDocType>("users", user.meta.serviceId, true);

                    if (!prevConf)
                        return reject("unauth");

                    prevConf.meta = {
                        ...prevConf.meta,
                        state: state ?? "reauth",
                    };

                    await db.set<UserDocType>("users", user.meta.serviceId, prevConf);
                }

                console.log("Flagged account", user.meta.serviceId, "for reauthorisation");

                reject(state == "srverr" ? "srverr" : "reauth");
            }

            if (this.user) {
                try {
                    incrementRequestCount();

                    const me = await this.spotifyApi.getMe();

                    this.user.me = {
                        ...me.body,
                        displayName: me.body.display_name,
                        images: me.body.images as SpotifyUser["me"]["images"],
                        listenerTypeClassification: user.me.listenerTypeClassification ?? "Casual Listener"
                    };

                    await db.update<UserDocType>("users", this.user.meta.serviceId, {
                        me: this.user.me,
                    });
                } catch { }
            }

            resolve(user);

            return;
        });
    }

    /**
     * Parks an account whose credentials Spotify will never accept again.
     *
     * Without this the monitor simply kept asking. A refresh that fails leaves
     * updateState resolving undefined rather than throwing, so the loop that
     * marks accounts for reauthorisation never saw it - the state stayed
     * "authvalid", /chkauth went on answering that all was well, and the
     * account spent every cycle spending two Spotify requests to fail twice.
     * From the outside the app is signed in and simply shows nothing.
     *
     * "reauth" is the state the client already knows how to recover from: it
     * prompts a sign-in, and signing in issues a fresh token against whichever
     * app the account belongs to now.
     */
    private async markNeedsReauthorisation(reason: unknown) {
        const serviceId = this.user?.meta.serviceId;

        if (!this.user || !serviceId)
            return;

        if (this.user.meta.state === "reauth")
            return;

        console.warn("Spotify has refused the credentials for", serviceId,
            "- marking the account for sign-in. Reason:",
            (reason as { body?: { error?: string }; spotifyError?: string })?.body?.error
            ?? (reason as { spotifyError?: string })?.spotifyError
            ?? reason);

        this.user.meta.state = "reauth";
        this.playbackState = undefined;

        const idx = userSessions.findIndex(v => v.u.user?.meta.serviceId === serviceId);

        if (idx !== -1) {
            userSessions[idx].u.user = this.user;
            userSessions[idx].u.playbackState = undefined;
        }

        try {
            await db.set<UserDocType>("users", serviceId, this.user);
        } catch (ex) {
            console.error("Failed to record that", serviceId, "needs to sign in again, error:", ex);
        }
    }

    async refreshSpotifyToken(authOverride?: SpotifyUser) {
        if (this.detach)
            return;

        // if (this.auth && this.auth.expires > new Date().getTime() + 5e3) {
        if (!authOverride && !this.user?.meta.serviceId)
            return;

        let auth: {
            "access_token": string;
            "refresh_token"?: string;
            "expires_in": number;
            "scope": string;
            "token_type": string;
        } | undefined | "srverr" = undefined;

        let primaryError: unknown = undefined;

        try {
            incrementRequestCount();
            auth = (await this.spotifyApi.refreshAccessToken()).body;
        } catch (ex) {
            console.warn("Primary token refresh strategy failed for user", this.user?.meta.serviceId + ", error:", ex, "(falling back to secondary)");

            primaryError = ex;

            try {
                incrementRequestCount();

                // Try our method if library failed
                // Same app the primary strategy uses: a refresh token is only
                // valid for the client that issued it, so hardcoding Tempo's
                // here meant the fallback could never succeed for an account
                // enrolled with its own app.
                const [fallbackClientId, fallbackClientSecret] = credsForAccount(this.user as unknown as UserDocType);

                auth = await refreshSpotifyToken({
                    clientId: fallbackClientId,
                    clientSecret: fallbackClientSecret,
                    refreshToken: this.auth?.refreshToken ?? authOverride?.data.refreshToken ?? "",
                });
                
                if (auth == "srverr") {
                    console.warn("Failed to refresh Spotify token using secondary refresh strategy as the server returned a server error state, user:", this.user?.meta.serviceId);

                    // Was written with ==, so it compared the state and threw
                    // the answer away rather than setting it. An assignment
                    // cannot be made through the optional chain, hence the guard.
                    if (this.user)
                        this.user.meta.state = "srverr";

                    return "srverr";
                }
            } catch (ex) {
                console.warn("Secondary token refresh strategy failed for user", this.user?.meta.serviceId + ", error:", ex, "(unable to refresh token)");

                if (isDeadCredentialsError(ex) || isDeadCredentialsError(primaryError))
                    await this.markNeedsReauthorisation(ex);
            }
        }

        if (!auth) {
            console.warn("Failed to reauthorise access token: no auth value was set");
            
            return;
        }

        const prevConf = await db.get<UserDocType>("users", this.user?.meta.serviceId ?? authOverride?.meta.serviceId, true);

        if (!prevConf)
            return;

        if (auth !== "srverr") {
            prevConf.data = {
                accessToken: auth.access_token,
                refreshToken: auth.refresh_token || prevConf.data?.refreshToken,
                expires: new Date().getTime() + (auth.expires_in * 1e3),
                scope: auth.scope,
                tokenType: auth.token_type,
            };
        }

        if (this.user)
            this.user.data = prevConf.data;
        
        if (this.user?.meta.serviceId ?? authOverride?.meta.serviceId)
            this.userId = (this.user?.meta.serviceId ?? authOverride?.meta.serviceId);

        await db.set<UserDocType>("users", this.userId, prevConf);

        // Make sure we are correctly authenticated
        this.user = await this.doAuth(prevConf);

        return true;
        // }

        // return false;
    }

    async saveTasteProfile() {
        if (!this.userId) {
            console.warn("Unable to save user taste profile, user ID not found");

            return;
        }

        const stored = await tasteStore.set(this.userId, this.taste);

        if (!stored)
            console.warn("Failed to save taste profile for", this.userId);
    }

    public async detachUser() {
        this.detach = true;

        await this.saveTasteProfile();
    }

    /**
     * Loads this user's taste profile, and says how that went.
     *
     * The distinction matters because this class saves the profile back - on a
     * timer, on detach, and once during init. "absent" means starting fresh is
     * correct; "error" means the stored profile could not be read, and a save
     * from this session would overwrite it with whatever this.taste happens to
     * hold, which right after construction is nothing. Callers that go on to
     * write must treat "error" as a reason not to run.
     */
    async loadTasteProfile(): Promise<"loaded" | "absent" | "error"> {
        if (this.detach)
            return "error";
        
        if (!this.userId) {
            console.warn("Unable to load user taste profile, user ID not found");

            return "error";
        }

        try {
            const result = await tasteStore.load(this.userId);

            if (result.status === "error") {
                console.warn("Could not read the stored taste profile for", this.userId);

                return "error";
            }

            if (result.status === "absent") {
                // Ordinary for someone who has never listened, rather than an error
                console.warn("User taste profile not found");

                return "absent";
            }

            const data = result.taste;

            // Backwards compatibility
            if (!data.streakHistory)
                data.streakHistory = [];

            // Backwards compatibility
            if (!data.affinityHistory)
                data.affinityHistory = [];

            // Backwards compatibility
            if (!data.tasteEvolution)
                data.tasteEvolution = [];

            this.taste = data;

            return "loaded";
        } catch (ex) {
            console.warn("Failed to load user taste profile, error:", ex);

            return "error";
        }
    }

    addStreakLostHistoryItem(duration: number) {
        if (this.detach)
            return;

        // Prepend the new history item
        this.taste.streakHistory = [
            {
                duration,
                timestamp: new Date().getTime(),
            },
            ...this.taste.streakHistory
        ];
    }

    addAffinityItem(songId: string, affinity: number) {
        if (this.detach)
            return;

        // Prepend the new history item
        this.taste.affinityHistory = [
            {
                songId,
                affinity,
                timestamp: new Date().getTime(),
            },
            ...this.taste.affinityHistory
        ];
    }

    addHistoryItem(songId: string, sessionDuration: number, skipped: boolean, replayed: boolean) {
        if (this.detach)
            return;

        // Prepend the new history item
        this.taste.history = [
            {
                songId,
                sessionDuration,
                skipped,
                replayed,
                timestamp: new Date().getTime(),
            },
            ...this.taste.history
        ];
    }

    resetCurrentSongReplayCount() {
        if (this.detach)
            return;

        this.replayCount = 0;
    }

    incrementSongReplayCount(songId: string) {
        if (this.detach)
            return;

        if (!this.taste.songData[songId]) {
            this.taste.songData[songId] = {
                rating: 0,
                skipCount: 0,
                playbackCount: 0,
                replayCount: 1,
            };
        } else {
            this.taste.songData[songId].replayCount++;
        }

        this.replayCount++;
    }

    incrementSongPlaybackCount(songId: string) {
        if (this.detach)
            return;

        if (!this.taste.songData[songId]) {
            this.taste.songData[songId] = {
                rating: 0,
                skipCount: 0,
                playbackCount: 1,
                replayCount: 0,
            };
        } else {
            this.taste.songData[songId].playbackCount++;
        }

        this.displaySeed = Math.random();

        if (this.user) {
            const weekStartDate = getWeekStartDate();

            const isWeekInAggregate = this.taste.hourlyListenershipAggregate.find(v => v[1] == weekStartDate) !== undefined;

            if (!isWeekInAggregate) {
                // This week needs to be prepended to aggregate
                this.taste.hourlyListenershipAggregate.unshift([createEmptyListenershipAggregate(0)[0][0], weekStartDate]);
                
                // Remove the last item from array
                this.taste.hourlyListenershipAggregate.splice(this.taste.hourlyListenershipAggregate.length - 2, 1);
            }

            const currentDate = new Date();
            const dayIndex = currentDate.getDay();
            const hourIndex = currentDate.getHours();

            // Increment counter for this hour by 1
            // Safe to use hourlyListenershipAggregate index position 0 since we make sure this week is at pos 0 above
            this.taste.hourlyListenershipAggregate[0][0][dayIndex][hourIndex] += 1;
        }
    }

    incrementSongSkipCount(songId: string) {
        if (this.detach)
            return;
        
        if (!this.taste.songData[songId]) {
            this.taste.songData[songId] = {
                rating: 0,
                skipCount: 1,
                playbackCount: 0,
                replayCount: 0,
            };
        } else {
            this.taste.songData[songId].skipCount++;
        }
    }

    updateState() {
        return new Promise<typeof this.playbackState | undefined>(async (resolve, reject) => {
            if (this.detach) {
                resolve(undefined);

                return;
            }

            if (appRateLimit !== 0) {
                await new Promise(resolve => setTimeout(resolve, 5e3));

                resolve(undefined);
                return;

            }
            // Refresh token if about to expire
            if (!this.user || this.user.data.expires < new Date().getTime() + (5 * 60e3) || this.user.meta.state == "srverr") {
                let s: any = undefined;
                
                try {
                    s = await this.refreshSpotifyToken();
                } catch { }

                if (!s)
                    return resolve(undefined);
            }

            incrementRequestCount();

            getMyCurrentPlayingTrack({
                authToken: this.user?.data.accessToken ?? "",
                additionalTypes: ["episode", "track"]
            })
            .then(data => {
                if (!data?.item) {
                    resolve(undefined);

                    return;
                }

                const item = data.item;

                const songId = item.id;
                const progressNormal = data.progress_ms ? (data.progress_ms / item.duration_ms) : 0;
                const isPlaying = data.is_playing;
                const timeRemaining = item.duration_ms - (data.progress_ms ?? 0);
                const duration = item.duration_ms;
                
                let imageUrl = "";
                let explicit = false;
                let name = "";
                let artists: {
                    name: string;
                    url: string;
                }[] = [];
                let albumId: string = "";

                if ('album' in item) {
                    let image = item.album.images.find(v => v.height == 300);

                    // As above: an artwork-less album would crash the fallback
                    imageUrl = (image?.url ?? item.album.images?.[0]?.url ?? "");
                    explicit = item.explicit;
                    name = item.name;
                    artists = item.artists.map(v => {
                        return {
                            name: v.name,
                            url: v.href
                        };
                    });
                    albumId = item.album.id;

                    songMetaCache.setItemIfNotExist({
                        id: songId,
                        name,
                        artists: item.artists.map(v => {
                            return {
                                id: v.id,
                                name: v.name,
                                url: v.href,
                                uri: v.uri,
                            };
                        }),
                        duration,
                        explicit,
                        album: {
                            id: albumId,
                            name: item.album.name,
                            releaseDate: new Date(item.album.release_date).getTime(),
                            artUrl: imageUrl,
                        },
                        isrc: item.external_ids?.isrc,
                        type: data.currently_playing_type == "episode" ? "episode" : "track",
                        meta: {
                            updatedAt: new Date().getTime(),
                        }
                    });
                }

                // User is listening to a podcast
                if (data.currently_playing_type == "episode") {
                    const episodeItem = item as SpotifyApi.EpisodeObject;

                    const img = episodeItem.images.find(v => v.url.startsWith("https://i.scdn."));

                    if (img)
                        imageUrl = img.url;
                    else if (episodeItem.images.length > 0)
                        imageUrl = episodeItem.images[0].url;

                    explicit = episodeItem.explicit;
                    name = episodeItem.name;
                    artists = [{
                        name: episodeItem.show.name,
                        url: `https://open.spotify.com/show/${episodeItem.show.id}`,
                    }];
                    albumId = episodeItem.show.id;

                    songMetaCache.setItemIfNotExist({
                        id: songId,
                        name,
                        artists: [{
                            id: episodeItem.show.id,
                            name: episodeItem.show.name,
                            url: `https://open.spotify.com/show/${episodeItem.show.id}`,
                            uri: episodeItem.show.uri,
                        }],
                        duration,
                        explicit,
                        album: {
                            id: albumId,
                            name: episodeItem.show.name,
                            releaseDate: -1,
                            artUrl: imageUrl,
                        },
                        type: data.currently_playing_type == "episode" ? "episode" : "track",
                        meta: {
                            updatedAt: new Date().getTime(),
                        },
                    })
                }

                /**
                 * Collapse alternate formats of the same recording.
                 *
                 * Spotify reports a music video as its own track — different id,
                 * different artwork, frequently its own ISRC — so the same song
                 * would otherwise be recorded twice: once per format, splitting
                 * play counts and showing duplicates in history and top songs.
                 * Only identity and display metadata are rewritten; progress and
                 * duration stay with the item actually playing, since the video
                 * and the audio release differ in length.
                 */
                let canonicalSongId = songId;

                if (data.currently_playing_type !== "episode") {
                    const played = songMetaCache.getItem(songId);

                    if (played) {
                        canonicalSongId = songMetaCache.resolveCanonicalId(played);

                        if (canonicalSongId !== songId) {
                            const canonical = songMetaCache.getItem(canonicalSongId);

                            if (canonical) {
                                name = canonical.name;
                                imageUrl = canonical.album.artUrl;
                                albumId = canonical.album.id;
                                explicit = canonical.explicit;
                                artists = canonical.artists.map(v => ({ name: v.name, url: v.url }));
                            }
                        }
                    }
                }

                const todayStartTime = getTodayStartDate();

                const todaysSongStats = this.analyseDailyListenershipForSong(todayStartTime, canonicalSongId);

                if (this.user && (this.user.me?.images?.length ?? 0) > 0) {
                    const scdnUrl = this.user.me?.images.find(v => v.url.startsWith("https://i.scdn."));

                    const targetImg = scdnUrl ?? this.user.me?.images[0]

                    this.pfpUrl = targetImg.url;
                }

                const state = {
                    userId: this.user?.meta.serviceId ?? "",
                    songId: canonicalSongId,
                    albumId,
                    progressNormal,
                    isPlaying,
                    timeRemaining,
                    duration,
                    imageUrl,
                    username: this.user?.me.displayName ?? "",
                    pfpUrl: (this.pfpUrl ?? ""),
                    pfpColourBlob: this.user?.me.profilePictureColourBlob,
                    explicit,
                    displaySeed: this.displaySeed,
                    replayCount: this.replayCount,
                    playSessionStart: this.playSessionStart,
                    name,
                    artists,
                    updatedAt: new Date().getTime(),
                    lastEventSentAt: this.playbackState?.lastEventSentAt ?? -1,
                    todayStats: todaysSongStats,
                    mediaType: data.currently_playing_type,
                };

                this.lastPlaybackState = state;

                resolve(state);
            })
            .catch(e => {
                try {
                    const rateLimitSec = parseInt(e.headers['retry-after'] ?? "0");

                    updateRateLimit(rateLimitSec);
                } catch { }

                reject(e);
            });
        });
    }
}

async function scanAuthorisedUsers() {
    if (SKIP_BOOTSTRAP) {
        console.log("Skipped user bootstrap scan as SKIP_BOOTSTRAP is set to true");

        return;
    }

    if (!(await db.exists("users", undefined, true)))
        return;

    const users = await db.all<UserDocType>("users");

    users.forEach(async data => {
        try {
            console.log("Starting monitor for user:", data.me?.id);

            const user = new User(...credsForAccount(data));

            await user.init(data);
        } catch (ex) {
            console.error("Failed to start user account monitor for", data.me?.id, "error:", ex, "user:", data);
        }
    });
}

/**
 * The Spotify app an account authorised against.
 *
 * A refresh token is only valid for the client that issued it, so an account
 * enrolled with its own app must keep using that app for every refresh. Falls
 * back to Tempo's app for accounts enrolled before this existed, whose stored
 * credentials are Tempo's anyway.
 */
/**
 * Does this account need the person to sign in again before it can do anything?
 *
 * "reauth" is set when a refresh fails, and was for a long time the only state
 * treated as needing attention. It is not the only one that does.
 *
 * An account is written at enrolment with state "unauth" and no tokens, and the
 * sign-in that immediately follows is what promotes it to "authvalid". When that
 * sign-in fails — a bring-your-own-app account whose credentials Spotify
 * rejects, someone who closes the consent screen — the account is left behind
 * exactly as enrolment made it: a real account, with a valid auth cookie, and no
 * token to its name.
 *
 * Nothing noticed. /chkauth answered 200 because the state was not "reauth", so
 * the app concluded it was signed in and sat waiting for data that could never
 * arrive, on a loading screen with no way out and nothing logged. Saying "not
 * authenticated" here is what turns that into the sign-in prompt it should
 * always have been.
 *
 * Keyed on the missing refresh token rather than the state alone, so this cannot
 * catch an account that is briefly mid-enrolment but already holds a token.
 */
function accountNeedsSignIn(user: SpotifyUser | undefined): boolean {
    if (!user)
        return false;

    if (user.meta?.state == "reauth")
        return true;

    return (user.meta?.state == "unauth" && !user.data?.refreshToken);
}

/**
 * Whether Spotify has refused these credentials outright, as opposed to being
 * briefly unable to answer.
 *
 * The difference decides whether an account is worth retrying. "invalid_client"
 * means the client id and secret it is enrolled with are not a Spotify app any
 * more - most often because the app was deleted from the dashboard - and
 * "invalid_grant" means the refresh token itself has been revoked. Neither can
 * come good on its own, so both need the person back to sign in. Everything
 * else, a timeout or a 500 or a rate limit, must not cost anybody their session.
 */
function isDeadCredentialsError(ex: unknown): boolean {
    const error = ex as {
        statusCode?: number;
        body?: { error?: string };
        spotifyError?: string;
    };

    const reason = error?.body?.error ?? error?.spotifyError;

    return (reason === "invalid_client" || reason === "invalid_grant");
}

function credsForAccount(data: Pick<UserDocType, "serverCreds"> | undefined): [string, string] {
    const id = data?.serverCreds?.clientId;
    const secret = data?.serverCreds?.clientSecret;

    if (id && secret)
        return [id, secret];

    return [SPOT_CLIENT_ID, SPOT_CLIENT_SECRET];
}

/**
 * @param swapTokenId the sign-in session waiting on this, if any. An app cannot
 *                    read the cookie this hands out, so it waits on the swap
 *                    store instead - and until now only an account that was
 *                    already signed in ever filled it. A first-time enrolment
 *                    left the app polling a token that would never arrive,
 *                    while the browser drifted on to the website.
 */
function authNewUser(auth: SpotifyUser, redirUri?: string, swapTokenId?: string) {
    return new Promise<string>((resolve, reject) => {
        if (flagServerShutdown)
            reject("Server is unable to process request");

        try {
            const user = new User(...credsForAccount(auth as unknown as UserDocType));

            user.on("auth", (url) => {
                resolve(url);
            });

            // Not awaited - init blocks on the sign-in completing, and the auth
            // URL above has to reach the caller first for that sign-in to ever
            // happen. Caught because init can now throw long after this frame
            // is gone, and an unhandled rejection takes the whole process down.
            user.init(auth).then(async () => {
                // init settles once the sign-in behind it has landed, which is
                // the moment there is something to hand back
                if (!swapTokenId || !tokSwapStore[swapTokenId])
                    return;

                try {
                    tokSwapStore[swapTokenId].token = await issueAuthToken(
                        auth.meta.serviceId,
                        auth.me?.displayName ?? "");

                    tokSwapStore[swapTokenId].completeCb?.();

                    console.log("Handed a signed token to the app waiting on", auth.meta.serviceId, "after enrolment");
                } catch (ex) {
                    console.error("Could not hand the app its token after enrolment for", auth.meta.serviceId, "error:", ex);
                }
            }).catch(ex => {
                console.error("Session for", auth.me?.id, "failed after sign-in:", ex);
            });
        } catch (ex) {
            reject(ex);
        }
    });
}

/**
 * Options for the auth cookie.
 *
 * Keyed on whether this API is actually served over HTTPS rather than on
 * NODE_ENV, because the two come apart: a development server behind an HTTPS
 * tunnel still needs SameSite=None with Secure for the browser to send the
 * cookie cross-site, while a plain loopback server cannot use Secure at all.
 *
 * Domain is omitted unless configured — an IP address is not a valid cookie
 * Domain, so a host-only cookie is the only thing that works on loopback.
 */
function authCookieOptions() {
    const overHttps = BASE_URL.startsWith("https://");

    return {
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
        sameSite: (overHttps ? "none" : "lax") as "none" | "lax",
        secure: overHttps,
    };
}

async function removeAuthCookie(userId: string, res: Response) {
    // Rotating this invalidates every token previously issued to the user
    const nextVersion = randomBytes(12).toString("hex");

    await db.set<UserDocType["meta"]["tokenVersion"]>("users", userId + "/meta/tokenVersion", nextVersion);

    tempoToken.setUserTokenVersion(userId, nextVersion);

    res.clearCookie("tempo.a", authCookieOptions());
}

/**
 * Issues this account's credential as a cookie, and returns it.
 *
 * Returned because the cookie cannot always be read back by the client that
 * needs it: the native app runs on its own origin and never sees a cookie set
 * for the API's, which is what the token swap exists to bridge. That swap was
 * handing over meta.token instead - a random string from createAuthToken that
 * predates signed tokens and can never verify - so the app stored something the
 * API rejects on every request. This is the value it should carry.
 */
/**
 * Mints this account's credential.
 *
 * Separate from the cookie because the app cannot read one: it runs on its own
 * origin and never sees a cookie set for the API's, which is what the token
 * swap exists to bridge. Both paths need the same token, and it must be the
 * signed kind - meta.token is a random string from before signed tokens and
 * verifies nowhere.
 */
async function issueAuthToken(userId: string, username: string): Promise<string> {
    let tokenVersion = randomBytes(12).toString("hex");

    const storedVersion = await db.get<UserDocType["meta"]["tokenVersion"]>("users", userId + "/meta/tokenVersion");

    if (storedVersion) {
        tokenVersion = storedVersion;
    } else {
        await db.set<UserDocType["meta"]["tokenVersion"]>("users", userId + "/meta/tokenVersion", tokenVersion);
    }

    tempoToken.setUserTokenVersion(userId, tokenVersion);

    return tempoToken.generateSignedToken({
        id: userId,
        username,
        tokenVersion,
    });
}

async function setAuthCookie(res: Response, userId: string, username: string): Promise<string> {
    const tok = await issueAuthToken(userId, username);

    const opts = authCookieOptions();

    // Drop any host-only cookie of the same name first. Issuing the domain
    // cookie below does not replace one, and a leftover would be sent alongside
    // it and shadow it on every request.
    if (opts.domain)
        res.clearCookie("tempo.a", { sameSite: opts.sameSite, secure: opts.secure });

    res.cookie("tempo.a", tok, {
        ...opts,
        // Expires in 1 year
        expires: new Date(Date.now() + (3600e3 * 24 * 365)),
    })

    return tok;
}

function hash(str: string) {
    return createHash("sha256").update(str, "utf8").digest("hex");
}

async function doesFriendshipPairExist(u1: string, u2: string) {
    const exists = await db.exists("friends", hash([u1, u2].sort().join(":")), true);

    console.log("doesFriendshipPairExist lookup, hash:", hash([u1, u2].sort().join(":")), "obj:", exists);

    return exists;
}

async function getMutualFriends(userId: string, friendId: string) {
    // mutual friends are friends of friendId that are also friends of userId
    const f = (await listFriends(friendId)).filter(v => v.state == "friends");
    const u = (await listFriends(userId)).filter(v => v.state == "friends");
    
    return f.filter(v => {
        const targetUId = v.u1Id == friendId ? v.u2Id : v.u1Id;

        // Dont include this relationship as a mutual friend
        if ((v.u1Id == friendId && v.u2Id == userId) || (v.u2Id == friendId && v.u1Id == userId))
            return false;

        return (u.find(v => v.u1Id == targetUId || v.u2Id == targetUId) !== undefined);
    });
}

async function listFriendRequests(userId: string) {
    const f = await listFriends(userId);
    
    return f.filter(v => v.state == "request");
}

async function listFriends(userId: string) {
    const doesExist = await db.exists("users", userId, true);

    if (!doesExist)
        return [];

    const friendships = await db.get<UserDocType["friends"]>("users", userId + "/friends", true);

    if (!friendships)
        return [];

    let processed: UserFriendship[] = [];

    for (const frId of friendships) {
        const fr = await db.get<UserFriendship>("friends", frId, true);

        // Dont cause error, just ignore this friendship for the moment
        // TODO: Implement better logic in the case of a missing friendship
        if (!fr)
            continue;

        // Backwards compatibility
        if (!fr.lastUpdated) {
            const time = new Date().getTime();

            await db.update<UserFriendship>("friends", fr.id, {
                lastUpdated: time,
            });
            fr.lastUpdated = time;
        }

        processed.push(fr);
    }

    return processed;
}

async function listFriendsIds(userId: string, includeSelf?: boolean) {
    const availableUsers = (await listFriends(userId)).filter(v => v.state == "friends").map(v => v.u1Id == userId ? v.u2Id : v.u1Id);

    let self: string[] = [];

    if (includeSelf)
        self = [userId];

    return [...availableUsers, ...self];
}

async function listAcceptedFriends(userId: string) {
    const friends = (await listFriends(userId)).filter(v => v.state == "friends");

    const friendUsers = (await Promise.all(friends.map(async v => {
        // Get each user's profile from the friendship objects
        const usr = await db.get<UserDocType>("users", v.u1Id == userId ? v.u2Id : v.u1Id, true);

        if (!usr)
            return null;

        return usr;
    }))).filter(v => v !== null);

    return friendUsers;
}

/**
 * Pairs of friends already known to be playing the same song, keyed by the
 * unordered pair and holding the song they matched on.
 *
 * This is the latch. Playback is polled continuously, and a Spotify Jam parks a
 * whole group on the same track for an entire session — without it, every poll
 * of every member would fire the notification again. An entry is created when a
 * pair moves from apart to together, and removed the moment they diverge, so
 * the next match notifies afresh.
 */
const listeningSyncLatch: {[pairKey: string]: string} = {};

/** Order-independent, so A→B and B→A are the same latch. */
function syncPairKey(a: string, b: string) {
    return [a, b].sort().join("|");
}

/**
 * The song a session is actually playing, or undefined if it is not playing —
 * or has listening activity switched off.
 *
 * The setting is honoured here rather than at the notification, which keeps a
 * private listener out of the matching entirely: they are never named to anyone
 * and never matched themselves, instead of being hidden from the feed but
 * announced by a push.
 */
interface ActiveSongLookup {
    /** The id matching compares. Absent means this user cannot be matched. */
    songId?: string;
    /** Why there is no matchable song, for the sync log. */
    reason?: "no-session" | "sharing-off" | "not-playing" | "no-song";
    /** What Spotify actually reports, before canonical resolution. */
    rawSongId?: string;
    /** False when the song had no cached metadata and the raw id was used. */
    canonicalResolved?: boolean;
}

/**
 * The same lookup activeSongIdFor performs, with the reasoning kept.
 *
 * A pair failing to match is invisible from the outside — nothing is sent, and
 * there is no record of what was compared. Keeping the reason turns "no
 * notification arrived" into a line saying which side had no song and why.
 */
function lookupActiveSong(userId: string): ActiveSongLookup {
    const session = userSessions.find(v => v.u.user?.meta.serviceId === userId);

    if (!session?.u.user)
        return { reason: "no-session" };

    if (!session.u.user.settings.shareListeningActivity)
        return { reason: "sharing-off" };

    const state = session.u.playbackState;

    if (!state?.isPlaying)
        return { reason: "not-playing" };

    if (!state.songId)
        return { reason: "no-song" };

    // A music video and its album track are the same song to a listener, so
    // match on the canonical id rather than letting the pair miss each other
    const meta = songMetaCache.getItem(state.songId);

    return {
        songId: meta ? songMetaCache.resolveCanonicalId(meta) : state.songId,
        rawSongId: state.songId,
        canonicalResolved: (meta !== undefined && meta !== null),
    };
}

function activeSongIdFor(userId: string): string | undefined {
    return lookupActiveSong(userId).songId;
}

function displayNameFor(userId: string): string {
    const session = userSessions.find(v => v.u.user?.meta.serviceId === userId);

    return session?.u.user?.me.displayName || "A friend";
}

/**
 * "Alex" / "Alex and Sam" / "Alex, Sam and Kai" / "Alex, Sam and 2 others"
 *
 * Names everyone up to three, because a notification that says "and 1 other"
 * withholds a name it had room to show.
 */
function joinNames(names: string[]): string {
    if (names.length === 0)
        return "";

    if (names.length === 1)
        return names[0];

    if (names.length <= 3)
        return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * Notifies friends who have landed on the same song at the same time.
 *
 * Driven from the playback poll: whenever a user starts or changes a song we
 * look at who among their friends is on that same song right now. Anyone newly
 * matched is notified along with this user, and their mutual friends are told
 * too. Pairs that have drifted apart are unlatched here as well, which is what
 * lets the same pair be notified again next time they line up.
 */
async function evaluateListeningSync(userId: string, trigger: string = "unspecified") {
    try {
        const self = lookupActiveSong(userId);
        const songId = self.songId;

        const friendIds = await listFriendsIds(userId);

        console.log(
            "[sync]", userId, "trigger=" + trigger,
            (songId
                ? "song=" + songId
                    + (self.rawSongId !== songId ? " (raw=" + self.rawSongId + ")" : "")
                    + (self.canonicalResolved ? "" : " [no cached metadata, raw id used]")
                : "unmatchable(" + self.reason + ")"),
            "friends=" + friendIds.length
        );

        // Not playing: everything this user was latched to has ended
        if (!songId) {
            for (const friendId of friendIds)
                delete listeningSyncLatch[syncPairKey(userId, friendId)];

            return;
        }

        const newlySynced: string[] = [];
        const alreadySynced: string[] = [];

        for (const friendId of friendIds) {
            const key = syncPairKey(userId, friendId);
            const friend = lookupActiveSong(friendId);

            if (friend.songId !== songId) {
                // The pair are on the same recording as far as Spotify is
                // concerned, and matching still disagrees — which only happens
                // when one side had no cached metadata and fell back to the raw
                // id while the other resolved to a different canonical one
                if (friend.rawSongId && friend.rawSongId === self.rawSongId)
                    console.warn("[sync]  ", friendId, "SAME TRACK", self.rawSongId, "but canonical ids differ:", songId, "vs", friend.songId, "- metadata cached for self:", self.canonicalResolved, "friend:", friend.canonicalResolved);
                else
                    console.log("[sync]  ", friendId, (friend.songId ? "on " + friend.songId + " - diverged" : "unmatchable(" + friend.reason + ")"));

                // Diverged (or never matched) — clears the latch so the next
                // time they line up counts as a fresh match
                delete listeningSyncLatch[key];

                continue;
            }

            if (listeningSyncLatch[key] === songId) {
                console.log("[sync]  ", friendId, "already latched on", songId);

                alreadySynced.push(friendId);

                continue;
            }

            console.log("[sync]  ", friendId, "NEW MATCH on", songId);

            listeningSyncLatch[key] = songId;
            newlySynced.push(friendId);
        }

        if (newlySynced.length === 0) {
            console.log("[sync]", userId, "no new matches (already latched:", alreadySynced.length + ")");

            return;
        }

        const meta = songMetaCache.getItem(songId);
        const songName = meta?.name;

        // Everyone on this song, so a third person joining an existing pair is
        // described as joining the group rather than just the one user
        const group = [userId, ...alreadySynced, ...newlySynced];

        // Latch every pair inside the group, not only the ones involving this
        // user. When three friends move to the same song together, this user's
        // poll notifies all of them — but the pair between the other two would
        // still look unlatched, so whichever of them polled next would notify
        // the same group about the same song a second time.
        for (let i = 0; i < group.length; i++)
            for (let j = i + 1; j < group.length; j++)
                listeningSyncLatch[syncPairKey(group[i], group[j])] = songId;

        // Each participant hears it from their own side. "You" leads the list so
        // it reads as one sentence — "You, Alex and Sam" rather than the
        // "You and Alex and Sam" that appending the others would produce.
        for (const memberId of [userId, ...newlySynced]) {
            const who = joinNames(["You", ...group.filter(v => v !== memberId).map(displayNameFor)]);

            await notify.notifyUser(memberId, {
                title: "You're in sync 🎧",
                message: songName
                    ? `${who} are listening to ${songName}.`
                    : `${who} are listening to the same song.`,
            });
        }

        // Their mutual friends, deduplicated across every pair that matched so
        // a three-way jam does not send the same person three notifications
        const observers = new Set<string>();

        for (const friendId of newlySynced) {
            const mutuals = await getMutualFriends(userId, friendId);

            for (const m of mutuals) {
                const other = m.u1Id === friendId ? m.u2Id : m.u1Id;

                if (!group.includes(other))
                    observers.add(other);
            }
        }

        const groupNames = group.map(displayNameFor);

        console.log("[sync]", userId, "notified", group.length, "member(s) and", observers.size, "observer(s) for", songId);

        for (const observerId of observers) {
            await notify.notifyUser(observerId, {
                title: `${group.length} friends are in sync 🎧`,
                message: songName
                    ? `${joinNames(groupNames)} are listening to ${songName}.`
                    : `${joinNames(groupNames)} are listening to the same song.`,
            });
        }
    } catch (ex) {
        console.error("Failed to evaluate listening sync for", userId, "error:", ex);
    }
}

/**
 * Whether Spotify refused to authenticate the app itself.
 *
 * The library wraps this as a WebapiAuthenticationError whose body carries
 * `invalid_client`, and prints as "[object Object]" — so the string that ends up
 * in the log says nothing about which of the many things that can go wrong went
 * wrong. Matched on the body rather than the message for that reason.
 */
function isInvalidClient(ex: unknown): boolean {
    const body = (ex as { body?: { error?: string; error_description?: string } })?.body;

    return (body?.error === "invalid_client" || /invalid_client/i.test(String(body?.error_description ?? "")));
}

/**
 * Explains a failure from Spotify's /v1/me during sign-in.
 *
 * A 403 here is almost always the development-mode allowlist rather than
 * anything wrong with the request: the token exchange has already succeeded at
 * this point, so the credentials and redirect URI are fine, and Spotify rejects
 * every Web API call from an account that is not listed under the app's User
 * Management. The raw WebapiError prints as "[object Object]" with an empty
 * body, which says none of that.
 */
function describeUserInfoFailure(ex: unknown): string {
    const status = (ex as { statusCode?: number })?.statusCode;

    if (status === 403)
        return "Spotify returned 403 for /v1/me. The token exchange succeeded, so this is "
            + "almost certainly the app being in Development Mode with this account missing "
            + "from User Management in the Spotify dashboard (limit 25 accounts).";

    if (status === 401)
        return "Spotify returned 401 for /v1/me — the access token was rejected.";

    return `Spotify returned ${status ?? "an unknown error"} for /v1/me.`;
}

async function createFriendRequest(initiatorId: string, targetId: string) {
    const initUser = await db.exists("users", initiatorId, true);
    const targetUser = await db.exists("users", targetId, true);

    if (!initUser)
        throw new Error("Unable to create friend request: initiator user not found (I:" + initiatorId + " --> T:" + targetId + ")");

    if (!targetUser)
        throw new Error("Unable to create friend request: target user not found (I:" + initiatorId + " --> T:" + targetId + ")");

    if (await doesFriendshipPairExist(initiatorId, targetId))
        return "EXISTS";

    const frId = hash([initiatorId, targetId].sort().join(":"))

    const friendship: UserFriendship = {
        id: frId,
        u1Id: initiatorId,
        u2Id: targetId,
        stats: {
            streak: 0,
            tasteMatchScore: 0,
        },
        state: "request",
        lastUpdated: new Date().getTime(),
    };

    const res = await db.set<UserFriendship>("friends", frId, friendship);

    if (!res)
        throw new Error("Unable to create friend request: database returned an undefined state");

    // The new friendship reference to the users
    for (const uid of [friendship.u1Id, friendship.u2Id]) {
        const friendIds = await db.get<UserDocType["friends"]>("users", uid + "/friends", true);

        if (!friendIds || friendIds.includes(frId))
            continue;
        
        await db.update<UserDocType["friends"]>("users", uid + "/friends", [...friendIds, frId]);
    }

    // The recipient has no way to learn about this otherwise — there is no poll
    // for friendships, so it would sit unseen until they opened add-friends.
    // The initiator is told too, so their other signed-in devices move to the
    // "requested" state rather than still offering to send the request again.
    for (const id of [targetId, initiatorId])
        pushToUser(id, {
            code: FRIENDSHIP_CHANGED_CODE,
            id: "FriendshipChanged",
            data: { reason: "request", friendshipId: frId },
        });

    return "VALIDATED";
}

async function acceptFriendRequest(accepterId: string, friendshipId: string) {
    const friendship = await db.get<UserFriendship>("friends", friendshipId, true);

    // no-op
    if (!friendship)
        return false;

    // The person who made the request tried to accept it
    if (friendship.u1Id == accepterId)
        return false;

    // Update object
    const res = await db.update<UserFriendship>("friends", friendshipId, {
        state: "friends",
        lastUpdated: new Date().getTime(),
    });

    if (!res)
        return false;

    // Both sides are told, not just the requester. The accepter's own client
    // usually updates optimistically off its own response, but any *other*
    // device they are signed in on has no way to learn the request is gone —
    // it would keep showing the pending banner until that page remounted.
    for (const id of [friendship.u1Id, friendship.u2Id])
        pushToUser(id, {
            code: FRIENDSHIP_CHANGED_CODE,
            id: "FriendshipChanged",
            data: { reason: "accepted", friendshipId },
        });

    return true;
}

async function blockFriend(friendshipId: string, blockerId: string) {
    const prevUser = await db.get<UserDocType>("users", blockerId, true);

    // no-op
    if (!prevUser) {
        console.warn("User", blockerId, "attempted to block friendship", friendshipId, "but the user could not be found");

        return false;
    }

    const doesExist = await db.exists("friends", friendshipId, true);

    // no-op
    if (!doesExist) {
        console.warn("User", blockerId, "attempted to block friendship", friendshipId, "but the friendship does not exist");

        return false;
    }

    // Update object
    const res = await db.update<UserFriendship>("friends", friendshipId, {
        state: "blocked",
        lastUpdated: new Date().getTime(),
    });

    if (!res)
        return false;

    // Remove this friendship from the blocking user's account
    const usrRes = await db.update<UserDocType>("users", blockerId, {
        friends: prevUser.friends.filter(v => v !== friendshipId),
    });

    if (!usrRes)
        return false;

    return true;
}

async function removeFriendship(friendshipId: string) {
    const doesExist = await db.exists("friends", friendshipId, true);

    if (!doesExist)
        return false;

    const fr = await db.get<UserFriendship>("friends", friendshipId, true);

    if (!fr)
        return false;

    // Remove the reference to the friendship
    for (const uid of [fr.u1Id, fr.u2Id]) {
        const userFriends = await db.get<UserDocType["friends"]>("users", uid + "/friends", true);

        if (!userFriends)
            continue;

        try {
            await db.update<UserDocType["friends"]>("users", uid + "/friends", userFriends.filter(v => v !== friendshipId));
        } catch (ex) {
            console.error("Failed to remove friendship for user", uid, "error:", ex);
        }
    }

    // Remove the friendship object
    await db.remove("friends", friendshipId);

    return true;
}

let tokSwapStore: {[key: string]: {
    token: string;
    completeCb?: () => void;
}} = {};

/**
 * Credentials for in-flight bring-your-own-app enrolments, keyed by auth state.
 *
 * The authorise redirect happens before we know who the user is, so the client
 * id cannot come from their account — it has to be held against the state that
 * links the two halves of the flow. Entries are dropped once used, and expire
 * on their own so an abandoned enrolment does not leave a secret in memory.
 */
const byoAuthorizeCreds: {[state: string]: { clientId: string; clientSecret: string }} = {};

const BYO_CREDS_TTL = 60e3 * 10;

function rememberByoCreds(state: string, creds: { clientId: string; clientSecret: string }) {
    byoAuthorizeCreds[state] = creds;

    // The session is the authoritative copy; the map above is a fallback for
    // the moment before a session exists, and expires only to avoid holding
    // credentials in memory forever
    if (authSessions[state])
        authSessions[state].byoCreds = creds;

    setTimeout(() => { delete byoAuthorizeCreds[state]; }, BYO_CREDS_TTL);
}

/**
 * Which Spotify app the authorise redirect for this sign-in must name.
 *
 * Never guesses. A sign-in with no session behind it cannot be completed - the
 * callback would find nothing to exchange the code against - so it fails here,
 * where it can still be explained, rather than sending someone out to Spotify
 * to consent to something that will be discarded on the way back.
 */
function authorizeCredsFor(state: string): { clientId?: string; error?: string } {
    const session = authSessions[state];

    if (!session)
        return { error: "expired" };

    const byo = session.byoCreds ?? byoAuthorizeCreds[state];

    if (byo) {
        console.log("Authorising sign-in", state, "against its own Spotify app", byo.clientId);

        return { clientId: byo.clientId };
    }

    console.log("Authorising sign-in", state, "against Tempo's app");

    return { clientId: undefined };
}

/**
 * @param byoCreds the user's own Spotify app. Spotify's development mode caps an
 *                 app at a handful of listed accounts, so anyone beyond that has
 *                 to authorise against an app of their own. Their credentials are
 *                 used for the authorise redirect, the code exchange and every
 *                 later token refresh — all three must agree, since a refresh
 *                 token is only valid for the client that issued it.
 */
function enrollNewUser(redirToUI?: boolean, swapTokenId?: string, byoCreds?: { clientId: string; clientSecret: string }) {
    return new Promise<string>((resolve) => {
        const spotifyApi = new SpotifyWebApi({
            clientId: byoCreds?.clientId || SPOT_CLIENT_ID,
            clientSecret: byoCreds?.clientSecret || SPOT_CLIENT_SECRET,
            redirectUri: SPOT_REDIRECT_URI
        });

        const state = createAuthSession("", async (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean, cb?: (state: string) => void) => {
            const storeMeData = async () => {
                incrementRequestCount();
                const a = await spotifyApi.authorizationCodeGrant(code);

                const data = {
                    accessToken: a.body.access_token,
                    refreshToken: a.body.refresh_token,
                    expires: new Date().getTime() + (a.body.expires_in * 1e3),
                    scope: a.body.scope,
                    tokenType: a.body.token_type,
                };

                spotifyApi.setAccessToken(data.accessToken);

                // Held for the already-signed-in path below, which would
                // otherwise throw away a freshly granted token and leave the
                // account on whatever scopes it first authorised with
                session.grantedAuth = data;

                incrementRequestCount();

                const me = await spotifyApi.getMe();

                /*
                 * Test harness: treat this account as if Spotify had refused it.
                 *
                 * Thrown from here, before session.me is set, because that is
                 * the exact point the real refusal lands - an unlisted account
                 * fails at getMe, never earlier - so everything downstream (the
                 * quotaBlocked catch, the redirect to /connect-spotify) runs
                 * unmodified. Guarded to Tempo's own app and to explicitly
                 * listed IDs; unset in production this is dead code.
                 */
                if (!byoCreds && SIMULATE_UNLISTED_IDS.includes(me.body.id)) {
                    console.warn("SIMULATE_UNLISTED_IDS: pretending", me.body.id, "is not on Tempo's app allowlist");

                    throw { statusCode: 403, body: { error: { status: 403, message: "User not registered in the Developer Dashboard (simulated)" } } };
                }

                session.me = me;
            }

            if (storeMe) {
                try {
                    await storeMeData();

                    return;
                } catch (ex) {
                    console.error("Failed to get user info:", describeUserInfoFailure(ex), "raw error:", ex);
                }
            }
            
            if (!clientId || !clientSecret) {
                res?.status(400).send("Invalid client ID or secret");

                return;
            }

            if (!session.me) {
                try {
                    await storeMeData();
                } catch (ex) {
                    console.error("Failed to get user info:", describeUserInfoFailure(ex), "raw error:", ex);

                    // A 403 on an enrolment against Tempo's own app means the
                    // account is not one of the few Spotify allows in
                    // development mode. That is not an error the user can act on
                    // as phrased, but it is fixable — send them to set up an app
                    // of their own instead of a dead error page.
                    const quotaBlocked = (ex as { statusCode?: number })?.statusCode === 403 && !byoCreds;

                    if (quotaBlocked) {
                        if (swapTokenId && tokSwapStore[swapTokenId])
                            tokSwapStore[swapTokenId].token = "ERR";

                        res?.redirect(WEB_APP_URL + "/connect-spotify");

                        return;
                    }

                    /*
                     * The same refusal, but from an app the user owns.
                     *
                     * Their app is in development mode too, and it will not
                     * serve an account that is not listed on it — including the
                     * account that created it, which nothing on Spotify's side
                     * tells you. Everything else has already worked at this
                     * point: the credentials are right, the redirect URI
                     * matched, consent was given. Sending this to the generic
                     * error page tells somebody their set-up failed when it is
                     * one checkbox from working.
                     */
                    if ((ex as { statusCode?: number })?.statusCode === 403) {
                        if (swapTokenId && tokSwapStore[swapTokenId])
                            tokSwapStore[swapTokenId].token = "ERR";

                        res?.redirect(WEB_APP_URL + "/connect-spotify?issue=user-management");

                        return;
                    }

                    if (swapTokenId && tokSwapStore[swapTokenId]) {
                        tokSwapStore[swapTokenId].token = "ERR";
                        res?.redirect(WEB_APP_URL + "/static-error");
                    } else if (redirToUI) {
                        res?.redirect(WEB_APP_URL + "/error");

                        return;
                    }

                    res?.status(500).send("Unable to authorise");

                    return;
                }
            }

            const me = session.me;

            const activeSession = userSessions.find(v => v.u.user?.me.id == me.body.id && v.u.user?.meta.state == "authvalid");

            if (activeSession) {
                // Re-authorising an account that is already signed in used to
                // stop here, cookie reissued and the new tokens dropped. That
                // made it impossible to widen an account's scopes: the consent
                // screen granted them and nothing ever stored the result.
                if ((session.grantedAuth || byoCreds) && activeSession.u.user) {
                    if (session.grantedAuth) {
                        activeSession.u.user.data = {
                            ...activeSession.u.user.data,
                            ...session.grantedAuth,
                        };

                        activeSession.u.user.meta.state = "authvalid";
                    }

                    /*
                     * The app this account now belongs to.
                     *
                     * Somebody already signed in who sets up a new Spotify app
                     * came through here, and only their tokens were kept - so
                     * the account went on naming the app they had just replaced.
                     * Sign-in was then routed to an app that no longer exists
                     * and refused, which reads as "your saved app is no longer
                     * accepted" on a set-up finished seconds earlier.
                     *
                     * It has to move with the tokens, not after them: the
                     * refresh token granted a moment ago was issued by this app
                     * and is valid for no other.
                     */
                    if (byoCreds) {
                        activeSession.u.user.serverCreds = {
                            clientId: byoCreds.clientId,
                            clientSecret: byoCreds.clientSecret,
                        };
                    }

                    try {
                        await db.set<UserDocType>("users", activeSession.u.user.meta.serviceId, activeSession.u.user);

                        console.log("Re-authorised", activeSession.u.user.meta.serviceId,
                            session.grantedAuth ? "with scopes: " + session.grantedAuth.scope : "",
                            byoCreds ? "against its new Spotify app " + byoCreds.clientId : "");
                    } catch (ex) {
                        console.error("Failed to store re-authorised tokens for", activeSession.u.user.meta.serviceId, "error:", ex);
                    }
                }

                // Old session doesnt have an auth token, create one
                if (activeSession.u.user && !activeSession.u.user.meta.token) {
                    activeSession.u.user.meta.token = createAuthToken(activeSession.u.user.me?.id);

                    await db.set<UserDocType>("users", activeSession.u.user.meta.serviceId, activeSession.u.user);
                }

                let signedToken: string | undefined;

                try {
                    if (res && activeSession.u.user?.meta.token)
                        signedToken = await setAuthCookie(res, activeSession.u.user?.meta.serviceId, activeSession.u.user.me?.displayName ?? "");
                } catch { }

                if (swapTokenId && tokSwapStore[swapTokenId] && signedToken) {
                    tokSwapStore[swapTokenId].token = signedToken;
                    
                    if (tokSwapStore[swapTokenId].completeCb)
                        tokSwapStore[swapTokenId].completeCb();

                    // The swap's own id, which is what /appauth/complete looks
                    // up. It was given the auth token instead, so that route
                    // answered "Invalid swap token" for every native sign-in.
                    return res?.redirect(WEB_APP_URL + "/static-success?st=" + swapTokenId);
                } else if (redirToUI) {
                    return res?.redirect(WEB_APP_URL + "/success");
                }

                res?.redirect(WEB_APP_URL + "/success");

                return;
            }

            session.remove();

            console.log("Enrolling user with ID", me.body.id, clientId, clientSecret);

            const token = createAuthToken(me.body.id);

            let prev: UserDocType | null;
            
            try {
                prev = await db.get<UserDocType>("users", me.body.id);
            } catch {
                if (res)
                    res.status(500).send("ERROR");

                return;
            }

            const payload: SpotifyUser = {
                data: {
                    expires: -1,
                    scope: "",
                    tokenType: "",
                },
                me: {
                    id: me.body.id,
                    displayName: me.body.display_name,
                    images: me.body.images,
                    listenerTypeClassification: prev?.me?.listenerTypeClassification ?? "Casual Listener",
                },
                serverCreds: {
                    // What this account actually authorised against, so its
                    // refreshes keep using the same app
                    clientId: byoCreds?.clientId || clientId,
                    clientSecret: byoCreds?.clientSecret || clientSecret,
                },
                meta: {
                    serviceId: me.body.id,
                    state: "unauth",
                    nextRefresh: new Date().getTime() + 1e3,
                    token,
                    dayRecapAvailableDate: -1,
                    weekRecapAvailableDate: -1,
                    viewedDailyRecap: "",
                    viewedWeeklyRecap: "",
                    priorityFYPAlerts: [],
                    // Keep any existing entropy so re-enrolling does not sign out
                    // this user's other devices
                    tokenVersion: prev?.meta?.tokenVersion ?? randomBytes(12).toString("hex"),
                },
                settings: {
                    // Preserved like the friends list below. Reinstalling and
                    // signing in again went through here, so a user who had
                    // turned activity sharing off silently had it turned back
                    // on — a privacy setting must survive a reinstall.
                    shareListeningActivity: prev?.settings?.shareListeningActivity ?? defaultSettingsObject.shareListeningActivity,
                },
                // If there are stored friends for this user, make sure we keep them
                friends: (prev?.friends ?? []),
            };

            await db.set<UserDocType>("users", me.body.id, payload);

            // Issue the cookie only after the document is written.
            //
            // This used to run before the write, so setAuthCookie stored one
            // entropy value and signed the token with it, and the db.set below
            // then replaced the whole document with a freshly generated one.
            // Every enrolled user therefore received a cookie whose entropy
            // could never match the database, and every authenticated request
            // failed verification with "Entropy mismatch".
            try {
                if (res)
                    await setAuthCookie(res, me.body.id, me.body.display_name);
            } catch (ex) {
                console.warn("Failed to set auth cookie during enrollment for", me.body.id, "error:", ex);
            }

            try {
                const redirUrl = await authNewUser(payload, redirToUI ? (WEB_APP_URL + "/") : undefined, swapTokenId);

                if (res)
                    res.redirect(redirUrl);
                else if (cb)
                    cb(redirUrl.split("/")[redirUrl.split("/").length - 1]);
            } catch {
                res?.status(500).send("ERROR")
            }
        }, true, true, redirToUI ? (WEB_APP_URL + "/") : undefined);

        if (byoCreds)
            rememberByoCreds(state, byoCreds);

        resolve(`${BASE_URL}/spotify/auth/cb/${state}`);
    });
}

function getTodayStartDate() {
    const currentDate = new Date();
    const todayDayBeginTime = new Date(currentDate.getTime() - ((currentDate.getHours() * 3600e3 + currentDate.getMinutes() * 60e3 + currentDate.getSeconds() * 1e3 + currentDate.getMilliseconds()))).getTime();

    return todayDayBeginTime;
}

function getWeekStartDate() {
    const currentDate = new Date();
    const currentDay = currentDate.getDay();
    const todayDayBeginTime = new Date(currentDate.getTime() - ((currentDate.getHours() * 3600e3 + currentDate.getMinutes() * 60e3 + currentDate.getSeconds() * 1e3 + currentDate.getMilliseconds()))).getTime();
    const weekStartDay = todayDayBeginTime - (3600e3 * 24 * currentDay);

    return weekStartDay;
}

async function wait(timeout: number) {
    await new Promise(resolve => setTimeout(resolve, timeout));
}

const BASE_REFRESH_RATE = 200;
const MIN_REFRESH_RATE = 1250;
const MAX_REFRESH_RATE = 100e3;

function advertisePlaybackStateChange(userId: string) {
    const keys = Object.keys(sessionListenerStateHooks);

    keys.forEach(k => {
        const v = sessionListenerStateHooks[k];

        if (!v.currentTargets.includes(userId))
            v.hook();
    });
}

async function userStateRefreshLoop() {
    const currentDate = new Date();
    const todayDayBeginTime = new Date(currentDate.getTime() - ((currentDate.getHours() * 3600e3 + currentDate.getMinutes() * 60e3 + currentDate.getSeconds() * 1e3 + currentDate.getMilliseconds()))).getTime();

    let nextUserAvgListenershipRefreshTime = todayDayBeginTime;
    
    while (true) {
        if (flagServerShutdown) {
            await wait(BASE_REFRESH_RATE);
            continue;
        }

        const currentDate = new Date().getTime();
        const refreshableUsers = userSessions.filter(v => v.u.user && v.u.user.me && v.u.user.meta.nextRefresh - currentDate <= 0);

        if (refreshableUsers.length == 0) {
            await wait(BASE_REFRESH_RATE);
            continue;
        }

        if (nextUserAvgListenershipRefreshTime - currentDate <= 0) {
            let refreshCount = 0;

            refreshableUsers.forEach(v => {
                if (!v.u.user)
                    return;
                
                v.u.typicalListeningSchedule = v.u.getAverageDailyListenership(v.u.taste.hourlyListenershipAggregate, v.u.user?.me?.id ?? v.u.user?.meta?.serviceId);
                refreshCount++;
            });

            nextUserAvgListenershipRefreshTime += (3600e3 * 24);

            console.log("Refreshed", refreshCount, "user weekly average listenership metric" + (refreshCount !== 1 ? "s" : "") + ", next refresh at", new Date(nextUserAvgListenershipRefreshTime).toString());
        }

        if (appRateLimit !== 0) {
            console.log("Pausing state update loop due to a rate limit, resumes ~=", new Date(appRateLimitExpiry));

            await wait(Math.max(BASE_REFRESH_RATE, appRateLimitExpiry - Date.now()));
        }

        const states = await Promise.all(refreshableUsers.map(v => v.u.updateState().catch(async (e) => {
            const suser = v.u.user;

            if (!suser)
                return undefined;

            console.log("Fetch error:", e);

            // Mark this user for reauthorisation
            suser.meta.state = "reauth";
            v.u.playbackState = undefined;

            const idx = userSessions.findIndex(v => v.u.user && v.u.user.meta.serviceId == suser.meta.serviceId);

            // Make sure we update in memory as well
            if (idx !== -1) {
                userSessions[idx].u.user = suser;
                userSessions[idx].u.playbackState = undefined;
            }

            // Save the user's auth state
            await db.set<UserDocType>("users", suser.meta.serviceId, suser);
        })));

        states.forEach(async (v, i) => {
            if (flagServerShutdown)
                return;

            const user = refreshableUsers[i];

            if (!user.u.user)
                return;

            const userLostStreakAction = (user: Monitor) => {
                if (!user.u.user)
                    return;

                const result = evaluateStreakLoss({
                    lastPlaySessionStart: user.lastPlaySessionStart,
                    prevItemTimestamp: user.u.taste.history[0]?.timestamp ?? -2,
                    interestingEventTimestamp: user.u.interestingEventTimestamp,
                    nextRefreshTimeout,
                    nextRefresh: user.u.user.meta.nextRefresh,
                    now: Date.now(),
                });

                if (!result.lost)
                    return;

                console.log(user.u.user?.me?.id, "has lost a", result.durationMs, "ms streak");

                // A run with no measurable length is still a run that ended: the
                // bookkeeping below has to be cleared either way, but there is
                // nothing worth putting in the history.
                if (result.durationMs > 0)
                    user.u.addStreakLostHistoryItem(result.durationMs);

                user.lastPlaySessionStart = -1;

                // Cleared here too, not just on the monitor. Leaving it behind
                // meant the run was reported as lost while the session still
                // held its start — so it went on being broadcast, and the next
                // backupStreak wrote it straight back into the database,
                // resurrecting a streak that had already ended. Resuming sets it
                // again from the track's own progress.
                user.u.playSessionStart = -1;

                const streakUserId = (user.u.user.me?.id ?? user.u.user.meta?.serviceId);

                if (streakUserId)
                    streakStore.remove(streakUserId).catch(ex => console.warn("Failed to clear streak for", streakUserId, "error:", ex));
            }

            const schedule = user.u.typicalListeningSchedule || (new Array<DailyListenership>(7) as UserListenership).fill((new Array<number>(24) as DailyListenership).fill(0));

            const todaySchedule = schedule[new Date().getDay()];
            const currentHourPlayCount = user.u.taste.hourlyListenershipAggregate[0][0][new Date().getDay()][new Date().getHours()];

            let hourlySchedule = todaySchedule[new Date().getHours()];

            // If we exceed the expected hourly count, use current value in our calculation
            if (currentHourPlayCount > hourlySchedule * 1.25)
                hourlySchedule = currentHourPlayCount;

            console.log(`[${user.u.user?.me.id}]`, "Hourly schedule:", hourlySchedule)

            // Refresh time == 2 min if not available, or proportion of hour listened to music
            // (3600e3 / (hourlySchedule * 60)) == 60 min / (# of songs in this hour typically * 60)
            let nextRefreshTimeout = (hourlySchedule == 0 ? MAX_REFRESH_RATE : (3600e3 / (hourlySchedule * 60)));

            if (nextRefreshTimeout < MIN_REFRESH_RATE)
                nextRefreshTimeout = MIN_REFRESH_RATE;

            user.u.user.meta.nextRefresh = (new Date().getTime() + nextRefreshTimeout);

            const prevState = user.u.playbackState;

            if (!v) {
                userLostStreakAction(user);

                // Playback has stopped (but was playing before)
                if (prevState) {
                    user.u.addHistoryItem(prevState.songId, prevState.progressNormal, false, false);
                    user.u.interestingEventTimestamp = Date.now();
                }

                user.u.user.meta.nextRefresh = (new Date().getTime() + (nextRefreshTimeout * 2));
                
                // Dont cap at 60sec if we were already over 60 sec
                // and dont let the increase in delay get us over 60 if we arent already
                if (nextRefreshTimeout < 60e3 && nextRefreshTimeout * 2 < 60e3)
                    user.u.user.meta.nextRefresh = (new Date().getTime() + (nextRefreshTimeout * 2));
                else if (nextRefreshTimeout < 60e3 && nextRefreshTimeout * 2 > 60e3)
                    user.u.user.meta.nextRefresh = (new Date().getTime() + (60e3));

                user.u.playbackState = undefined;

                advertisePlaybackStateChange(user.u.user.meta.serviceId);

                user.u.broadcastPlaybackUpdate({
                    state: undefined,
                    action: "STOPPED"
                });

                // Nothing is playing now, so drop any sync latches this user
                // held — otherwise the pair would stay latched and never be
                // notified the next time they line up
                evaluateListeningSync(user.u.user.meta.serviceId, "stopped");

                return;
            }

            if (v.timeRemaining !== -1) {
                // We want to refresh slightly before we mark song skipped in case user has skipped, then we can mark as appropriate
                // This means we refresh before and after song finishes
                const offset = (v.progressNormal <= 0.725 ? (v.timeRemaining / (1 - v.progressNormal)) * 0.75 : (v.timeRemaining / (1 - v.progressNormal)) + 1500);
                const nextTargetRefresh = (new Date().getTime() + offset);

                // If our calculated ideal refresh time is before then use calculated time
                if (offset < nextRefreshTimeout)
                    user.u.user.meta.nextRefresh = nextTargetRefresh;
            }

            // If been stuck on playing for > 5 min, mark paused
            if (
                v.lastEventSentAt !== -1 &&
                prevState?.isPlaying &&
                v.isPlaying &&
                v.updatedAt - v.lastEventSentAt >= 60e3 * 1 &&
                prevState.progressNormal == v.progressNormal
            ) {
                v.isPlaying = false;
            }

            // Consent given over text (by Sorcha Bright)
            const sorchCentralCeeNotifierPlugin = (userId: string, songId: string) => {
                if (userId !== "dcfc1wdwx310qgps19sm60xvn")
                    return;

                const song = songMetaCache.getItem(songId);

                if (!song)
                    return;

                // Central Cee's artist id
                if (!song.artists.some(v => v.id == "5H4yInM5zmHqpKIoMNAx4r"))
                    return;

                // Notify these users
                const TARGET_IDS = ["nfsind1dp1j2x5ak8a820e6pt", "yh1q376ly901c0qk03n9kaphh"];

                TARGET_IDS.forEach(async v => {
                    await notify.notifyUser(v, {
                        title: "Sorcha's listening to Central Cee",
                        message: `Listening to ${song.name} 😂`,
                    });
                });
            }

            const backupStreak = () => {
                if (!user.u.user)
                    return;

                const usrId = (user.u.user.me?.id ?? user.u.user.meta?.serviceId);

                if (!usrId)
                    return;

                // Fire-and-forget: a streak is a nicety and must not hold up the
                // playback poll. updatedAt is refreshed each time, which is what
                // lets a restart tell a live run from an abandoned one.
                lastStreakTouch[usrId] = Date.now();

                streakStore.set(usrId, {
                    playSessionStart: user.u.playSessionStart,
                    updatedAt: Date.now(),
                }).catch(ex => console.warn("Failed to save user streak for", usrId, "error:", ex));
            }

            // Set by the transition branches below and acted on once the new state
            // has been committed.
            //
            // Evaluating inline compared this user's *previous* song: the branches
            // run while user.u.playbackState still holds the old state, and that
            // is what lookupActiveSong reads. So a match was only ever found one
            // song-change late, against a track the user had already left — which
            // is why starting a friend's song sent nothing, and their next song
            // change sent a notification about the song they had just stopped
            // playing.
            // One reading of what changed, so the branches below cannot disagree
            // about it and the decisions can be tested without a running server
            const transition = classifyPlaybackTransition(prevState, v);

            if (v.isPlaying) {
                let localPlaySessionStart = v.playSessionStart;

                if (transition.started) {
                    // Song started playing
                    console.log(`[${user.u.user?.me.id}]`, "Song started playing", v.songId);

                    user.u.resetCurrentSongReplayCount();
                    user.u.incrementSongPlaybackCount(v.songId);

                    const prevItemTimestamp = user.u.taste.history[0]?.timestamp ?? -2;
                    const refreshOffset = Math.max(nextRefreshTimeout, user.u.user.meta.nextRefresh - Date.now());
                    const checkTime = Math.max(prevItemTimestamp, user.u.interestingEventTimestamp) + Math.max(refreshOffset, 0);

                    // If the last item was played >= 10 min ago reset session start timestamp
                    // (user loses their listening streak)
                    if (user.u.playSessionStart == -1 || Date.now() - checkTime >= 600e3) {
                        user.u.playSessionStart = Date.now();
                        user.lastPlaySessionStart = user.u.playSessionStart;
                        localPlaySessionStart = user.u.playSessionStart;

                        backupStreak();
                    }

                    // Update this after tending to playSessionStart, otherwise itll never reset
                    user.u.interestingEventTimestamp = Date.now();

                    sorchCentralCeeNotifierPlugin(user.u.user.meta.serviceId, v.songId);

                    // Playback beginning where there was no previous state is
                    // exactly the case where listening may have gone unseen
                    reportHistoryReconciliation(user, true);

                }

                // A run with no start while something is playing should not be
                // possible, and where it happens anyway the track's own progress
                // says when it began. Better than the current time, which throws
                // away however much of the track has already played, and better
                // than leaving it unset, which reads downstream as not listening
                // while they plainly are.
                if (user.u.playSessionStart === -1) {
                    const songStartedAt = (v.duration > 0
                        ? Date.now() - Math.round(v.progressNormal * v.duration)
                        : Date.now());

                    user.u.playSessionStart = songStartedAt;
                    user.lastPlaySessionStart = songStartedAt;
                    localPlaySessionStart = songStartedAt;

                    console.log(`[${user.u.user?.me.id}]`, "Repaired a missing play session start to", new Date(songStartedAt).toISOString());

                    backupStreak();
                }

                // Bounded to one write per interval per listener, which is what
                // makes keeping it fresh affordable at all
                if (user.u.playSessionStart !== -1) {
                    const touched = lastStreakTouch[user.u.user.meta.serviceId] ?? 0;

                    if (Date.now() - touched >= STREAK_TOUCH_INTERVAL_MS)
                        backupStreak();
                }

                user.u.broadcastPlaybackUpdate({
                    state: {
                        ...v,
                        playSessionStart: localPlaySessionStart,
                    },
                    action: "PLAYING:" + v.songId,
                });
            }

            if (prevState && v) {
                if (transition.songChanged) {
                    // Song changed
                    console.log(`[${user.u.user?.me.id}]`, "Song changed", prevState.songId, "-->", v.songId);

                    user.u.resetCurrentSongReplayCount();
                    user.u.incrementSongPlaybackCount(v.songId);

                    user.u.interestingEventTimestamp = Date.now();

                    // Check if we have skipped the song
                    if (transition.skipped) {
                        console.log(`[${user.u.user?.me.id}]`, "Skipped song:", prevState.songId);

                        user.u.incrementSongSkipCount(prevState.songId);
                        user.u.addHistoryItem(prevState.songId, prevState.progressNormal, true, false);

                        // Refresh again quickly incase user is spamming skip button
                        if (nextRefreshTimeout <= 1750)
                            user.u.user.meta.nextRefresh = (new Date().getTime() + 750);
                        else
                            user.u.user.meta.nextRefresh = (new Date().getTime() + 1500)

                        user.u.broadcastPlaybackUpdate({
                            state: v,
                            action: "SKIPPED:" + prevState.songId,
                        });
                    } else  {
                        user.u.addHistoryItem(prevState.songId, 1, false, false);

                        user.u.broadcastPlaybackUpdate({
                            state: v,
                            action: "LISTENED:" + prevState.songId,
                        });
                    }

                    backupStreak();

                    reportDerivedStreak(user);

                    // Not a return from silence: Tempo was already watching
                    reportHistoryReconciliation(user, false);

                    sorchCentralCeeNotifierPlugin(user.u.user.meta.serviceId, v.songId);

                }

                if (transition.playStateChanged) {
                    // Play state changed
                    console.log(`[${user.u.user?.me.id}]`, "Play state changed, isPlaying:", prevState.isPlaying, "-->", v.isPlaying);

                    user.u.interestingEventTimestamp = Date.now();

                    user.u.broadcastPlaybackUpdate({
                        state: v,
                        action: `${v.isPlaying ? "PLAYING" : "PAUSED"}:${v.songId ?? prevState.songId}`,
                    });

                    // Do lost streak actions if user is not playing anything
                    if (!v.isPlaying)
                        userLostStreakAction(user);

                }

                // Detect if the song is replayed
                if (transition.replayed) {
                    console.log(`[${user.u.user?.me.id}]`, "Song replayed:", v.songId);

                    user.u.interestingEventTimestamp = Date.now();

                    user.u.addHistoryItem(prevState.songId, prevState.progressNormal, false, true);
                    user.u.incrementSongReplayCount(prevState.songId);
                    user.u.incrementSongPlaybackCount(v.songId);
                    user.u.broadcastPlaybackUpdate({
                        state: {
                            ...v,
                            replayCount: v.replayCount + 1,
                        },
                        action: "REPLAYED:" + prevState.songId,
                    });
                }
            }

            console.log(`[${user.u.user?.me.id}]`, "Next refresh in", user.u.user.meta.nextRefresh - new Date().getTime(), "ms");

            const listeningStarted = (!user.u.playbackState && v);

            user.u.playbackState = v;

            // After the assignment above, never before it: this reads the very
            // state it is matching on. Fire-and-forget, so a friend landing on
            // the same song does not hold up the playback poll.
            // Pausing breaks a sync, and resuming onto the same song a friend is
            // still playing counts as a fresh match, so a play state change asks
            // for an evaluation just as a song change does. Where a single poll
            // saw several, the last one is the one that describes where the user
            // ended up.
            if (transition.syncTrigger && user.u.user)
                evaluateListeningSync(user.u.user.meta.serviceId, transition.syncTrigger);

            await user.u.saveTasteProfile();

            // Advertise this new listening session
            if (listeningStarted)
                advertisePlaybackStateChange(v.userId);
        });

        await wait(BASE_REFRESH_RATE);
    }
}

/**
 * A rejected promise inside an async route handler is not caught by Express, so
 * it surfaces here. Node's default is to terminate, which meant a single bad
 * request could take the entire server down along with every connected socket.
 * Log it and keep serving — the request itself still fails.
 */
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});

/**
 * Installs the development fake friend: seeds the database records, then holds
 * an in-memory session with a live playback state so they surface in
 * /spotify/friends/sessions and on the friends list as currently listening.
 */
async function installFakeFriend() {
    const friendshipIdFor = (a: string, b: string) => hash([a, b].sort().join(":"));

    /**
     * Links the fixture to every real user, skipping the write when they are
     * already linked.
     *
     * Runs on a timer rather than only at boot: a user who authenticates for the
     * first time after startup would otherwise never be befriended, which is
     * exactly what happens on a fresh database.
     */
    const linkRealUsers = async () => {
        const users = await db.all<UserDocType>("users");
        const realUserIds = users
            .map(v => v?.meta?.serviceId)
            .filter(v => typeof v === "string" && v !== "" && v !== FAKE_FRIEND_ID);

        if (realUserIds.length === 0)
            return;

        const unlinked = users.some(v => {
            const id = v?.meta?.serviceId;

            if (!id || id === FAKE_FRIEND_ID)
                return false;

            return !(v.friends ?? []).includes(friendshipIdFor(id, FAKE_FRIEND_ID));
        });

        if (unlinked)
            await seedFakeFriendData(db, realUserIds, friendshipIdFor);

        // Runs regardless of linking, so a request sent from the UI is accepted
        await acceptPendingFakeFriendRequests(db, realUserIds, friendshipIdFor);
    };

    try {
        await linkRealUsers();

        setInterval(() => {
            linkRealUsers().catch(ex => console.warn("[dev-fake-friend] re-link failed:", ex));
        }, 15e3);

        const fake = new User("", "");

        // Backdated so a streak is visible immediately rather than after 5 real
        // minutes of the server running
        const fakeSessionStart = Date.now() - (47 * 60e3);

        fake.user = buildFakeFriendDocument() as unknown as SpotifyUser;
        fake.playbackState = buildFakePlaybackState(Math.random(), fakeSessionStart) as unknown as PlaybackState;

        const existing = userSessions.findIndex(v => v.u.user?.meta.serviceId === FAKE_FRIEND_ID);

        const monitor: Monitor = {
            u: fake,
            nosies: [],
            lastPlaySessionStart: fake.playbackState?.playSessionStart ?? -1,
        };

        if (existing === -1)
            userSessions.push(monitor);
        else
            userSessions[existing] = monitor;

        // Keep the state moving so progress bars advance and the entry does not
        // look frozen. Cheap, and only ever runs behind the dev flag.
        setInterval(() => {
            const session = userSessions.find(v => v.u.user?.meta.serviceId === FAKE_FRIEND_ID);

            if (!session)
                return;

            const wasStopped = !session.u.playbackState;

            const next = buildFakePlaybackState(
                session.u.playbackState?.displaySeed ?? Math.random(),
                fakeSessionStart
            ) as unknown as PlaybackState;

            session.u.playbackState = next;

            session.u.broadcastPlaybackUpdate({
                state: next,
                action: "PLAYING:" + next.songId,
            });

            // Resuming is the case the wakeup exists for: any socket that
            // unsubscribed when this user stopped is no longer receiving their
            // broadcasts, so it has to be told the session list changed
            if (wasStopped)
                advertisePlaybackStateChange(FAKE_FRIEND_ID);
            // Fast enough that toggling play/stop feels immediate while testing
        }, 2e3);

        console.log("[dev-fake-friend] active as", FAKE_FRIEND_ID, "- set DEV_FAKE_FRIEND=false to remove");
    } catch (ex) {
        console.error("[dev-fake-friend] failed to install:", ex);
    }
}

/**
 * When each user's streak record was last written.
 *
 * The record's updatedAt is what a restart uses to tell a live run from an
 * abandoned one, and it was only rewritten when a song changed. A single long
 * track — a mix, a set, a podcast — changes nothing for its whole length, so the
 * record aged out of the restore window while the listener was still going, and
 * the next restart dropped a streak that was very much alive.
 */
const lastStreakTouch: {[userId: string]: number} = {};

/** How often the record is refreshed while somebody is listening. */
const STREAK_TOUCH_INTERVAL_MS = 5 * 60e3;

/**
 * Per user, what has happened since their play history was last checked.
 *
 * In memory only. A check missed because the server restarted costs nothing —
 * the next one picks up whatever was outstanding, since the watermark that
 * matters is stored with the account rather than here.
 */
const reconciliationStates: {[userId: string]: ReconciliationState} = {};

/**
 * Counts a song change and reports when play history would be fetched.
 *
 * Reports only; nothing is fetched. The cadence is worth watching on real
 * listening before it starts spending Spotify requests, because it draws on the
 * same quota the playback poll is already rationing — and a policy firing more
 * often than intended would be paid for out of poll frequency, which is what
 * everything else here depends on.
 */
function reportHistoryReconciliation(user: Monitor, returnedFromSilence: boolean) {
    if (!user.u.user)
        return;

    const userId = user.u.user.meta.serviceId;

    const state = recordSongEvent(reconciliationStates[userId] ?? newReconciliationState());

    const decision = shouldReconcile(state, {
        now: Date.now(),
        // Accounts authorised before Tempo asked for play history cannot read it
        hasScope: tokenHasScope("user-read-recently-played", user.u.user.data?.scope),
        returnedFromSilence,
    });

    if (!decision.run) {
        reconciliationStates[userId] = state;

        return;
    }

    console.log("[history]", userId, "would reconcile:", decision.reason, `(${state.eventsSinceLastRun} song(s) since last)`);

    reconciliationStates[userId] = recordReconciliation(state, { now: Date.now() });
}

/**
 * How far back to look when deriving a streak.
 *
 * A run cannot span a gap longer than the break threshold, so anything older
 * than a generous multiple of it cannot be part of the current one. Bounded
 * because history grows without limit and this runs on every song change.
 */
const DERIVED_STREAK_WINDOW_MS = 24 * 3600e3;

/** Only worth reporting when the two answers are further apart than this. */
const DERIVED_STREAK_TOLERANCE_MS = 30e3;

/**
 * Works out the streak from stored history and says where it disagrees with the
 * one the poll has been tracking.
 *
 * Reports only; nothing reads the derived answer yet. Tracking a streak
 * incrementally cannot survive a gap in observation — listening that happened
 * while Tempo was not watching looks like silence, and once a run is declared
 * over there is nothing to reverse. Deriving it from history instead makes it a
 * function of the data, so filling a hole and recomputing gives the right answer
 * without anything being undone.
 *
 * Running both and logging the difference is how that gets established on real
 * listening before anything depends on it.
 */
function reportDerivedStreak(user: Monitor) {
    if (!user.u.user)
        return;

    try {
        const now = Date.now();
        const since = now - DERIVED_STREAK_WINDOW_MS;

        const recent = user.u.taste.history.filter(v => v.timestamp >= since);

        const plays = playedTracksFromHistory(recent, songId => songMetaCache.getItem(songId)?.duration);

        const derived = deriveStreak(plays, now);
        const live = user.u.playSessionStart;

        const userId = user.u.user.meta.serviceId;

        // Both agree there is no run
        if (derived.startedAt === null && live === -1)
            return;

        if (derived.startedAt === null || live === -1) {
            console.log(
                "[streak]", userId,
                "disagree: live", (live === -1 ? "none" : new Date(live).toISOString()),
                "derived", (derived.startedAt === null ? "none" : new Date(derived.startedAt).toISOString()),
                `(${plays.length} of ${recent.length} plays usable)`,
            );

            return;
        }

        const difference = Math.abs(derived.startedAt - live);

        if (difference <= DERIVED_STREAK_TOLERANCE_MS)
            return;

        console.log(
            "[streak]", userId,
            "differ by", Math.round(difference / 1000) + "s:",
            "live", new Date(live).toISOString(),
            "derived", new Date(derived.startedAt).toISOString(),
            `over ${derived.trackCount} track(s),`,
            `${plays.length} of ${recent.length} plays usable`,
        );
    } catch (ex) {
        console.warn("Failed to derive a streak for", user.u.user.meta.serviceId, "error:", ex);
    }
}

const LEADERBOARD_STANDINGS_COLLECTION = "leaderboardStandings";

/** The hour a morning digest goes out, in the server's own time. */
const LEADERBOARD_DIGEST_HOUR = 10;

/** The day a digest last went out, so a restart cannot send a second one. */
let lastLeaderboardDigestDay = "";

/**
 * Tells people they have moved up the leaderboard, once a day.
 *
 * Not the moment it happens: two friends listening at similar rates cross back
 * and forth over an afternoon, and a notification per crossing is noise about
 * something that keeps un-happening. Comparing where somebody stands now with
 * where they stood yesterday says it once, and only while it is still true.
 *
 * Reads every user's board, which is the expensive part — a profile per friend
 * per user. Once a day is what makes that affordable, and it is another reason
 * not to do this on every change.
 */
async function runLeaderboardDigest() {
    console.log("[leaderboard] running the morning digest");

    let notified = 0;

    try {
        const users = await db.all<UserDocType>("users");

        for (const account of users) {
            const userId = account?.meta?.serviceId;

            if (!userId)
                continue;

            try {
                const board = await buildLeaderboardFor(userId);
                const me = board.find(e => e.isViewer);

                if (!me)
                    continue;

                const currentlyAhead = board.filter(e => e.listeningMs > me.listeningMs).map(e => e.userId);
                const presentNow = board.filter(e => !e.isViewer).map(e => e.userId);

                const previous = await db.get<Standing>(LEADERBOARD_STANDINGS_COLLECTION, userId, false, true);

                const digest = buildDigest({
                    previous: previous ?? undefined,
                    currentlyAhead,
                    position: me.position,
                    presentNow,
                    nameFor: id => board.find(e => e.userId === id)?.displayName ?? "A friend",
                });

                // Recorded whether or not anything was sent, so tomorrow is
                // compared against today rather than against the last day
                // somebody happened to move
                await db.set<Standing>(LEADERBOARD_STANDINGS_COLLECTION, userId, {
                    aheadOfMe: currentlyAhead,
                    position: me.position,
                    takenAt: Date.now(),
                });

                if (!digest.notification)
                    continue;

                await notify.notifyUser(userId, digest.notification);

                notified++;

                console.log("[leaderboard]", userId, "passed", digest.passed.join(", "), "- now", me.position);
            } catch (ex) {
                console.error("[leaderboard] failed to build a digest for", userId, "error:", ex);
            }
        }
    } catch (ex) {
        console.error("[leaderboard] digest run failed:", ex);

        return;
    }

    console.log("[leaderboard] digest complete,", notified, "notification(s) sent");
}

/**
 * Runs the digest at the first opportunity on or after the hour.
 *
 * Deliberately not "exactly at ten": a tick can fall either side of a given
 * minute and a restart can miss it entirely, which would silently skip a day.
 * Keying on the date instead means a late start still sends, and sends once.
 */
function scheduleLeaderboardDigest() {
    setInterval(() => {
        const now = new Date();

        if (now.getHours() < LEADERBOARD_DIGEST_HOUR)
            return;

        const today = now.toDateString();

        if (today === lastLeaderboardDigestDay)
            return;

        lastLeaderboardDigestDay = today;

        runLeaderboardDigest().catch(ex => console.error("[leaderboard] digest failed:", ex));
    }, 30e3);
}

/**
 * Removes the development fake friend from the database.
 *
 * The fixture writes real user and friendship documents, so it outlives the run
 * that created it: a DEV_FAKE_FRIEND session pointed at a shared database leaves
 * "Test Listener" sitting in every real user's friends list, where it reads as a
 * stranger rather than a test account. seedFakeFriendData already refuses to run
 * in production, but that only stops new writes — this clears the ones already
 * there, on every boot where the flag is off.
 */
async function uninstallFakeFriend() {
    try {
        // Cheap guard first: a database that never ran the fixture has nothing
        // to clean, and should not pay for a full user scan on every startup.
        if (!(await db.exists("users", FAKE_FRIEND_ID, true)))
            return;

        const friendshipIdFor = (a: string, b: string) => hash([a, b].sort().join(":"));

        const users = await db.all<UserDocType>("users");
        const realUserIds = users
            .map(v => v?.meta?.serviceId)
            .filter(v => typeof v === "string" && v !== "" && v !== FAKE_FRIEND_ID);

        await removeFakeFriendData(db, realUserIds, friendshipIdFor);

        // Anyone connected right now is still being sent the fixture's session
        const stale = userSessions.findIndex(v => v.u.user?.meta.serviceId === FAKE_FRIEND_ID);

        if (stale !== -1) {
            userSessions.splice(stale, 1);
            advertisePlaybackStateChange(FAKE_FRIEND_ID);
        }
    } catch (ex) {
        console.error("[dev-fake-friend] failed to remove the fixture:", ex);
    }
}

/**
 * Makes sure an account carries a colour blob matching its current picture.
 *
 * Cheap to call on an account that is already up to date: the recorded source
 * URL is compared against the live one and nothing is fetched unless they differ,
 * which after the first pass is every account except the ones who just changed
 * their picture.
 */
async function ensureProfileColourBlob(userId: string, me: SpotifyUser["me"] | undefined): Promise<boolean> {
    if (!me)
        return false;

    const url = me.images?.[0]?.url;

    // No picture means the app draws an initial instead, and that needs no blob
    if (!url)
        return false;

    if (me.profilePictureColourBlobFor === url && isValidColourBlob(me.profilePictureColourBlob))
        return false;

    const blob = await computeColourBlob(url);

    if (!blob)
        return false;

    // The in-memory copy as well as the stored one, or every session already
    // running keeps serving the old value until it is next read from the database
    me.profilePictureColourBlob = blob;
    me.profilePictureColourBlobFor = url;

    await db.update<string>("users", userId + "/me/profilePictureColourBlob", blob);
    await db.update<string>("users", userId + "/me/profilePictureColourBlobFor", url);

    return true;
}

/**
 * Fills in colour blobs for accounts that predate them.
 *
 * Runs once at startup, after the sessions are up so it is not competing with
 * them for the Spotify API. Accounts that already have a current blob cost a
 * string comparison, so this is only expensive the first time it runs, and it is
 * done one at a time on purpose — it is backfill, and nobody is waiting for it.
 */
async function backfillProfileColourBlobs() {
    try {
        const users = await db.all<UserDocType>("users");

        let filled = 0;

        for (const user of users) {
            const userId = user?.meta?.serviceId;

            if (!userId)
                continue;

            // Prefer the live session's copy, so a user who is signed in right
            // now gets the blob written onto the object being served rather than
            // onto a detached read of it
            const session = userSessions.find(v => v.u.user?.meta.serviceId === userId);
            const me = session?.u.user?.me ?? user.me;

            if (await ensureProfileColourBlob(userId, me))
                filled += 1;
        }

        if (filled > 0)
            console.log("Backfilled profile colour blobs for", filled, "account(s)");
    } catch (ex) {
        console.warn("Failed to backfill profile colour blobs, error:", ex);
    }
}

db.on("ready", () => {
    setInterval(() => {
        globalSpotifyAPIRequestCount = globalSpotifyAPIRequestCounter;
        globalSpotifyAPIRequestCounter = 0;
    }, 10e3);

    const server = app.listen(PORT, () => {
        console.log("Listening on port", PORT);

        // Before scanAuthorisedUsers, which constructs the User objects that read
        // previousStreaks as they are built
        migrateTasteProfilesFromDisk()
        .then(() => loadPreviousStreaks())
        .then(() => scanAuthorisedUsers())
        .then(() => {
            scheduleLeaderboardDigest();

            if (DEV_FAKE_FRIEND)
                return installFakeFriend();

            return uninstallFakeFriend();
        })
        // Last, and not awaited by anything: the server is already serving, and
        // an account without a blob renders exactly as it did before
        .then(() => backfillProfileColourBlobs());

        userStateRefreshLoop();

        process.on('SIGINT', async () => {
            console.log("Caught interrupt signal, safely shutting down the server...");

            flagServerShutdown = true;
            authSessions = {};

            // Shutdown API server
            server.close();

            // Exit runtime loops
            clearInterval(appRateLimitUnlockTimeout);

            // Stop monitoring users
            console.log("Detaching", userSessions.length, "user sessions");

            for (let i = 0; i < userSessions.length; i++) {
                await userSessions[i].u.detachUser();
                
                try {
                    await userSessions[i].socketCloseOverride?.();
                } catch { }

                console.log("Detached user", userSessions[i].u.user?.meta.serviceId);

                delete userSessions[i];
            }
        
            // // Close databases
            // await db.shutdown();

            console.log("Tempo API is now offline, goodbye! ;)");

            process.exit(0);
        });
    });
});