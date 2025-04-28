import SpotifyWebApi from "spotify-web-api-node";
import { DailyListenership, Taste, UserListenership, UserTaste } from "./user-taste";
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

// Local imports
import "./copyright-message";
import { getMyCurrentPlayingTrack, refreshSpotifyToken } from "./spotify-methods";
import { NotificationHandler } from "./notification-handler";
import { DataStore, TasteDocType, UserDocType } from "./db";
import { WebSocket } from "ws";
import { SongData, SongDataCache } from "./song-data-cache";
import { TempoTokenType, Token } from "./jwtauth";
import { alphaMergedSimilarity, combinedSimilarity, euclideanDistance } from "./similarity";
import { Recap, UserListenershipRecapScheduler } from "./recap-scheduler";
import { FeedItem, getUserFeed } from "./feed";
import { sampleRandomEmbedding } from "./test-taste";

interface StreakSave {
    honorId: string;
    userId: string;
    playSessionStart: number;
}

interface StreakSaveServerLiveliness {
    honorId: string;
    timestamp: number;
}

const SERVER_LIVELINESS_META_PATH = "/tempodb/.srvlife";
const STREAK_BAK_META_PATH = "/tempodb/streaks/";
const BASE_URL = "https://api.tempo-music.co";
// const BASE_URL = "http://localhost:2246";

// Select correct client ID and secret based on environment
const SPOT_CLIENT_ID = (BASE_URL.startsWith("https://") ? "931970aea8e840b0b9678ea890fa4cea" : "c432b1d2c50846a1aa3c41bded12c91e");
const SPOT_CLIENT_SECRET = (BASE_URL.startsWith("https://") ? "33460761b24240e88475bcbcbbcf28c6" : "21f3c1fcf24146c9b63f98e32cf70728");

const SPOT_REDIRECT_URI = BASE_URL + "/spotify/callback";
const BYPASS_AUTH = false;
const EXPECTED_ALERT_VERSION: UserDocType["meta"]["priorityFYPAlerts"][0]["metaAlertVersion"] = "r";
const APP_UI_VERSION = 12;
const APP_UI_NOTICE: {
    title: string,
    text: string[],
    primaryButtonText?: string;
    secondaryButtonText?: string;
    secondaryButtonPage?: string;
} = {
    title: "Tempo. Update",
    text: [
        "Changes:",
        " - The mock settings page is now available",
        " - The toggles do not yet have any effect",
        " - Please review design and provide feedback where possible",
        "",
        "Thank you!",
        "",
        "👋 Reach us at hello@tempo-music.co!"
    ],
    secondaryButtonText: "View Settings",
    secondaryButtonPage: "preferences",
};

console.log("APP_UI_VERSION:", APP_UI_VERSION);
console.log("(APP_UI_VERSION is indicative of application ecosystem version)");

const db = new DataStore();
const songMetaCache = new SongDataCache();
const tempoToken = new Token(db);
const notify = new NotificationHandler();
const recapScheduler = new UserListenershipRecapScheduler(db, songMetaCache, notify);

if (!existsSync("/tempodb/.lastknownappversion"))
    writeFileSync("/tempodb/.lastknownappversion", "0");

const lastKnownAppVersion = parseInt(readFileSync("/tempodb/.lastknownappversion").toString());

if (lastKnownAppVersion < APP_UI_VERSION) {
    console.log("Updating app version to", APP_UI_VERSION);

    writeFileSync("/tempodb/.lastknownappversion", APP_UI_VERSION.toString());

    notify.broadcast({
        title: "✨ Tempo. Update",
        message: "Tempo has been updated, open the app to see what's new!",
    });
}

interface AuthSession {
    me?: any;
    successRedirect?: string;
    errorRedirect?: string;
    cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean, cb?: (state: string) => void) => Promise<void>;
    enroll?: boolean;
    useServerCreds?: boolean;
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
    entropy: number;
    playSessionStart: number;
    imageUrl: string;
    pfpUrl: string;
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
let serverLiveliness: StreakSaveServerLiveliness = {
    honorId: randomBytes(16).toString("hex"),
    timestamp: Date.now(),
}
let previousStreaks: {[key: string]: number} = {};

if (!existsSync(STREAK_BAK_META_PATH))
    mkdirSync(STREAK_BAK_META_PATH);

try {
    if (existsSync(SERVER_LIVELINESS_META_PATH)) {
        const liveliness = JSON.parse(readFileSync(SERVER_LIVELINESS_META_PATH).toString()) as StreakSaveServerLiveliness;

        if (Date.now() - liveliness.timestamp <= 600e3) {
            const streaks = readdirSync(STREAK_BAK_META_PATH);

            streaks.forEach(v => {
                const p = STREAK_BAK_META_PATH + v;
                const data = JSON.parse(readFileSync(p).toString()) as StreakSave;

                if (data.honorId !== liveliness.honorId)
                    return unlinkSync(p);

                previousStreaks[data.userId] = data.playSessionStart;

                console.log("Loaded previous streak for user", data.userId, "playSessionStart:", data.playSessionStart);

                unlinkSync(p);
            });
        }
    }
} catch (ex) {
    console.warn("Failed to load previous server liveliness metadata from", SERVER_LIVELINESS_META_PATH, "error:", ex);
}

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

    serverLiveliness.timestamp = Date.now();

    writeFileSync(SERVER_LIVELINESS_META_PATH, JSON.stringify(serverLiveliness));
}, 10e3);

function incrementRequestCount() {
    globalSpotifyAPIRequestCounter++;
}

async function updateRateLimit(limit: number) {
    await rlMutex.runExclusive(() => {
        if (appRateLimit == 0 && limit == 0)
            return;

        // Make sure we wait full duration of rate limit
        if (limit !== 0 && limit < appRateLimit)
            return;

        appRateLimit = limit;

        const expectedResolution = new Date(Date.now() + (limit * 1e3) + 5e3);

        appRateLimitExpiry = expectedResolution.getTime();

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
            }
        }, 1e3);
    });
}

async function isAuthorised(token: string | undefined): Promise<TempoTokenType | false> {
    if (BYPASS_AUTH) return {
        id: "fakeuser",
        username: "Fake User",
        ent: "fakeuser",
    };

    console.log("TVERIFY:", token)

    if (!token)
        return false;

    const tok = await tempoToken.verifySignedToken(token);

    if (!tok)
        return false;

    return tok;
}

function createAuthToken(userId: string) {
    const token = randomBytes(12).toString("hex");

    return token;
}

const allowedOrigins = [
    'https://tempo-music.co',
    'https://www.tempo-music.co',
    'http://localhost:3000',
    'capacitor://localhost'
];

const limiterKeyGen = (req: Request) => {
    const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    const ipString = Array.isArray(ip) ? ip.join(",") : ip ?? "";

    const hash = createHash("sha256").update(ipString).digest("hex");

    return hash;
}

const speedLimiter = slowDown({
	windowMs: 1800e3,
	delayAfter: 2750,
	delayMs: (hits) => hits * 50,
    maxDelayMs: 5e3,
    skipFailedRequests: true,
    keyGenerator: limiterKeyGen,
});

const rateLimiter = rateLimit({
	windowMs: 1800e3,
	limit: 5400,
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

    if (allowedOrigins.includes(origin ?? "")) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    } else {
        console.warn("Request from unauthorised origin:", origin, "path:", req.path);
    }

    res.setHeader("Access-Control-Allow-Headers", "Access-Control-Allow-Headers, Origin,Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers, x-api-token");

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

app.get("/.version-notice", (_, res) => {
    res.json(APP_UI_NOTICE);
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

            res.redirect("https://tempo-music.co/success");

            return;
        } catch (ex) {
            console.error("User account setup failed, error:", ex);

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

    // We already have an app configured for this user, use it
    if (await db.exists("users", preAuthUser.id)) {
        const userData = await db.get<UserDocType>("users", preAuthUser.id);

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

    if (req.params.userId == "cb") {
        res.redirect(`https://accounts.spotify.com/authorize?client_id=${SPOT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SPOT_REDIRECT_URI)}&scope=&state=${state}`);

        return;
    }

    if (!await db.exists("users", req.params.userId)) {
        res.status(400).send("User not configured");

        return;
    }

    const userCreds = await db.get<SpotifyUser>("users", req.params.userId);

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SPOT_REDIRECT_URI)}&scope=user-read-playback-state%20user-read-currently-playing%20user-read-private%20user-read-email&state=${state}`;

    res.redirect(authUrl);
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
    
    const recapData: {
        daily: Recap | null;
        weekly: Recap | null;
    } = {
        daily: await db.getRecap(token.id, "daily", req.query["seen"] == "true"),
        weekly: await db.getRecap(token.id, "weekly", req.query["seen"] == "true"),
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

    try {
        const u = await db.get<UserDocType>("users", token.id);

        newCurrentUsername = u?.me.displayName;
    } catch { }

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
        const success = acceptFriendRequest(token.id, friendshipId);

        if (!success) {
            res.status(500).json({
                error: true,
                message: "Sorry, we were unable to accept the friend request"
            });

            return;
        }

        try {
            const friendship = await db.get<UserFriendship>("friends", friendshipId);

            if (friendship?.u1Id) {
                let newCurrentUsername: string | undefined;

                const u = await db.get<UserDocType>("users", token.id);

                newCurrentUsername = u?.me.displayName;
                
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

    if (!(await db.exists("friends", friendshipId))) {
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

    const resultsWithMutuals = await Promise.all(results.map(async user => {
        const mutualFriends = await getMutualFriends(token.id, user.id);
        return { user, mutualFriends };
    }));

    let sortedResults = resultsWithMutuals.sort((a, b) => b.mutualFriends.length - a.mutualFriends.length).slice(0, data.limit || 10);

    // If multiple results start with a query match, move them to top
    const queryMatches = sortedResults.filter(v => v.user.displayName?.toLowerCase().startsWith(query));
    const sortedResultsWithoutQueryMatches = sortedResults.filter(v => !v.user.displayName?.toLowerCase().startsWith(query));
    const sortedResultsWithQueryMatches = [...queryMatches, ...sortedResultsWithoutQueryMatches];

    sortedResults = sortedResultsWithQueryMatches;

    // If theres an exact match, move it to the top
    const exactMatch = sortedResults.find(v => v.user.displayName?.toLowerCase() == query);
    
    if (exactMatch) {
        sortedResults.splice(sortedResults.indexOf(exactMatch), 1);
        sortedResults.unshift(exactMatch);
    }

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

app.post("/notify/subscribe", (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    const subId = req.body.id as string | undefined;
    const sub = req.body.subscription as PushSubscriptionJSON | undefined;

    if (!subId || !sub) {
        res.status(400).json({
            error: true,
            message: "Invalid subscription",
        });

        return;
    }

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

const getAuthorisedUser = (req: Request) => {
    let token = req.cookies["tempo.a"];

    if (req.headers["x-api-token"])
        token = req.headers["x-api-token"];

    return isAuthorised(token);
}

app.get("/taste-compare/:u1/:u2", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
        return;
    }
    
    // TODO: Add authorisation

    const session1 = userSessions.find(v => v.u.user?.meta.serviceId == req.params.u1);
    const session2 = userSessions.find(v => v.u.user?.meta.serviceId == req.params.u2);

    if (!session1 || !session2) {
        res.status(404).json({
            error: true,
            message: "Unable to find sessions"
        });

        return;
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

app.get("/debug-emb", async (req, res) => {
    // Test average cosine similarity across random pairs
    let similarities = [];

    for (let i = 0; i < 4000; i++) {
        const a = sampleRandomEmbedding();
        const b = sampleRandomEmbedding();
        if (!a || !b) continue;
        similarities.push(combinedSimilarity(a, b));
    }

    const meanSim = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    console.log("Average random similarity:", meanSim);

});

app.get("/taste/:u", async (req, res) => {
    if (flagServerShutdown) {
        res.status(502).send("Sorry, Tempo is currently unable to service your request!");
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
        u = await db.get<UserDocType>("users", req.params.userId);

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

    const startTimestamp = Date.now() - (3600e3 * 24 * 7);

    const filteredStreaks = session.u.taste.streakHistory.filter(v => v.timestamp >= startTimestamp);

    const longestStreak = filteredStreaks.reduce((max, v) => Math.max(max, v.duration), 0);

    const filteredSessions = session.u.taste.history.map(v => {
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

    const filteredSessions = session.u.taste.history.filter(v => {
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
        res.redirect("https://www.tempo-music.co/static-error");

        return;
    }

    const redirUrl = await enrollNewUser(false, swapToken);

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);
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
    
    const swapToken = req.params["swapToken"];

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
            console.log("ATSS CALLED CHK", swapToken);

            if (!ws.OPEN)
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
            pfpUrl: v.u.user?.me.images[0].url,
            // (b.timestamp - a.timestamp) will sort in reverse order
            history: todayHistory.sort((a, b) => (b.timestamp - a.timestamp)),
        };
    }).filter(v => v.username !== "" && v.userId !== "");
    
    // Destructure processedUserHistory and store array of song listening sessions
    let processedSessions: {
        userId: string;
        username: string;
        pfpUrl?: string;
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
            message: "Invalid page number \"" + req.params.pageNumber + "\", make sure it is an integer",
        });

        return;
    }

    const targetUser = userSessions.find(v => v.u.user?.meta.serviceId == req.params.userId);

    if (!targetUser) {
        res.status(404).json({
            error: true,
            message: "Unable to find user with id " + req.params.userId,
        });

        return;
    }

    const availableUsers = await listFriendsIds(token.id, true);

    if (!availableUsers.includes(targetUser.u.user?.meta.serviceId ?? "")) {
        res.status(403).json({
            error: true,
            message: "You are not authorised to access this endpoint",
        });

        return;
    }

    // Limit at 7 days of history
    const dayOffset = 3600e3 * 24 * Math.min(pageNumber, 7);

    // TODO: Add request parameter to get data from further in past
    const startDate = getTodayStartDate() - dayOffset;
    const endDate = startDate + (3600e3 * 24);

    const INCLUDE_FULL_DATA = false;

    let isFinalPage = true;

    // Get the listenership data
    const unfiltered = userSessions.filter(v => (v.u.user?.meta.serviceId ?? "") == targetUser.u.user?.meta.serviceId).map(v => {
        let todayHistory = v.u.taste.history.filter((a, i) => {
            const valid = (a.timestamp >= startDate && a.timestamp < endDate);

            // This makes sure isFinalPage is set to false if any user history isnt at its final items
            if (i == v.u.taste.history.length - 1 && !valid)
                isFinalPage = false;

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
            pfpUrl: v.u.pfpUrl,
            // (b.timestamp - a.timestamp) will sort in reverse order
            history: todayHistory.sort((a, b) => (b.timestamp - a.timestamp)),
        };
    }).filter(v => v.username !== "" && v.userId !== "");
    
    let processedUserHistory: typeof unfiltered = [];

    // Remove duplicates (if there are any and ensure latest data is used)
    for (const item of unfiltered) {
        const conflictItem = processedUserHistory.find(v => v.userId == item.userId);

        if (conflictItem && item.history[item.history.length - 1].timestamp > conflictItem.history[conflictItem.history.length - 1].timestamp) {
            // Found conflicting item, this data is newer, overwrite other one
            processedUserHistory.splice(processedUserHistory.findIndex(v => v.userId == item.userId), 1, item);
            
            continue;
        }

        // Consolidate pauses and resumes of a song into 1
        let localHistory: typeof item.history = [];
        let combineTemp: typeof item.history = [];

        item.history.forEach((v, i) => {
            if (i == 0) 
                return localHistory.push(v);
            
            const prev = item.history[i-1];

            if (prev.songId == v.songId && prev.sessionDuration + v.sessionDuration <= 1 && (combineTemp.length == 0 || combineTemp[combineTemp.length-1].songId == v.songId)) {
                combineTemp.push(v);
            } else if (combineTemp.length > 0 && combineTemp[combineTemp.length-1].songId !== v.songId && combineTemp[combineTemp.length-1].sessionDuration == 1) {
                // We have consolidated this set of playback sessions into one
                localHistory.push({
                    ...combineTemp[combineTemp.length-1],
                    // Set session start to the entry at start of array
                    // This makes total session duration > song duration
                    timestamp: combineTemp[0].timestamp,
                    skipped: false,
                });
                combineTemp = [];
            } else if (combineTemp.length > 0 && combineTemp[combineTemp.length-1].songId !== v.songId && combineTemp[combineTemp.length-1].sessionDuration !== 1) {
                // Unable to consolidate into one session, add each one individually
                localHistory = [...localHistory, ...combineTemp];
                combineTemp = [];
            } else {
                // Session is unrelated
                localHistory.push(v);
                combineTemp = [];
            }
        });

        // Flush any remaining sessions in combineTemp after iterating.
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

            combineTemp = [];
        }

        item.history = localHistory;

        processedUserHistory.push(item);
    }
    
    // Destructure processedUserHistory and store array of song listening sessions
    let processedSessions: {
        userId: string;
        username: string;
        pfpUrl?: string;
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

            if (!track)
                return;

            processedSessions.push({
                userId: item.userId,
                username: item.username,
                pfpUrl: item.pfpUrl,
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

    // Reverse sort destructured history by timestamp
    const sortedSessions = processedSessions.sort((a, b) => (b.timestamp - a.timestamp));

    res.json({
        error: false,
        data: sortedSessions,
        isFinalPage
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
    
    const availableUsers = await listFriendsIds(token.id, true);

    res.json(userSessions.filter(v => availableUsers.includes(v.u.user?.meta.serviceId ?? "") && v.u.user && v.u.user.me?.id !== "" && v.u.playbackState).map(v => v.u.user?.me.id));
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

const sockHandler = (userId: string, ws: WebSocket) => {
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

            if (ws.OPEN)
                ws.close();
            else
                resolve();
        });
    }

    ws.onmessage = async (m) => {
        if (!m.data.toString().startsWith("[") || !m.data.toString().endsWith("]"))
            return;

        const availableUsers = await listFriendsIds(userId, true);

        const userIdsPre = JSON.parse(m.data.toString()) as string[];

        // Filter out any users requested which the user is not friends with
        const userIds = userIdsPre.filter(v => [...availableUsers, "QUERY", "RM", "nocb"].includes(v));

        // Query listeners
        // ["QUERY", "<callback id>"]
        if (userIds.length == 2 && userIds[0] == "QUERY") {
            ws.send(JSON.stringify({
                id: userIds[1],
                userIds: sessions.map(v => v.u.user?.meta.serviceId),
            }));

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

        sessions = [...sessions, ...userSessions.filter(v => v.u.user && notBoundUserIds.includes(v.u.user.me?.id))];

        sessions.forEach(v => {
            v.nosies.push({
                id: cbId,
                cb(state) {
                    if (!ws.OPEN) {
                        return deleteCb(v);
                    }
        
                    ws.send(JSON.stringify({
                        code: 200,
                        data: state,
                    }));
                },
            });

            if (!v.u.playbackState)
                return;

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
        if (!ws.OPEN)
            return;

        ws.send(JSON.stringify({
            code: -1
        }));
    }, 30e3);

    ws.onclose = () => {
        clearInterval(keepAliveLoop);
        deleteCb();
        
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

    sockHandler(token.id, ws);
});

// Same as above route but this one requires manual auth
app.ws("/stream/sessions/lazy", (ws, req) => {
    let authed = false;

    const authExpireTimeout = setTimeout(() => {
        if (!ws.OPEN || authed)
            return;

        ws.close();
    }, 120e3);

    ws.onmessage = async (m) => {
        if (authed)
            return;

        try {
            const data = JSON.parse(m.data.toString()) as {
                overrideToken: string;
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

            sockHandler(valid.id, ws);
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
        tokenEntropy: string;
    };
    // A string array of friendship IDs
    friends: string[];
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
    private spotifyApi: SpotifyWebApi;
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
    private unsecureEntropy: number;
    public playSessionStart: number;
    public interestingEventTimestamp: number;
    public tasteHandler?: Taste;
    public pfpUrl?: string;
    private detach: boolean;

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
        this.unsecureEntropy = Math.random();
        this.playSessionStart = -1;
        this.interestingEventTimestamp = -1;
        this.detach = false;
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

        await this.loadTasteProfile();

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

        await this.loadTasteProfile();

        const listenership = this.getAverageDailyListenership(this.taste.hourlyListenershipAggregate, this.user.me?.id);

        this.typicalListeningSchedule = listenership;
        this.tasteHandler = new Taste(this.user.me?.id);

        console.log(`[${this.user.me?.id}]`, "Average monthly user listenership length", listenership.length);

        // Load previous streak if available
        if (previousStreaks[this.userId]) {
            this.playSessionStart = previousStreaks[this.userId];
            
            delete previousStreaks[this.userId];
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
        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts")) ?? [];

        const now = Date.now();

        const filteredAlerts = existingAlerts.filter(v => v.id !== id);

        await db.update<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", filteredAlerts as UserDocType["meta"]["priorityFYPAlerts"]);
    }

    async getPriorityFYPAlerts() {
        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts")) ?? [];

        const now = Date.now();

        // Make sure alerts are not expired
        const filteredAlerts = existingAlerts.filter(v => v.metaAlertVersion == EXPECTED_ALERT_VERSION && v.id && (v.expires == "After-View" || v.expires > now));

        await db.update<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts", filteredAlerts as UserDocType["meta"]["priorityFYPAlerts"]);

        // Ignore expired alerts
        return existingAlerts.filter(v => v.metaAlertVersion == EXPECTED_ALERT_VERSION && v.id && (v.expires == "After-View" || v.expires >= now));
    }

    async addPriorityFYPAlert<T>(type: UserDocType["meta"]["priorityFYPAlerts"][0]["alertType"], content: T, expires: "After-View" | number) {
        const id = randomBytes(12).toString("hex");

        const existingAlerts = (await db.get<UserDocType["meta"]["priorityFYPAlerts"]>("users", this.userId + "/meta/priorityFYPAlerts")) ?? [];
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
        
        // Update user's listener type
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

                    const payload: SpotifyUser = {
                        data,
                        me: {
                            ...me.body,
                            displayName: me.body.display_name,
                            images: me.body.images as SpotifyUser["me"]["images"],
                            listenerTypeClassification: prevConf?.me.listenerTypeClassification ?? "Casual Listener"
                        },
                        serverCreds: {
                            clientId: SPOT_CLIENT_ID,
                            clientSecret: SPOT_CLIENT_SECRET,
                        },
                        meta: {
                            ...prevConf!.meta,
                            state: "authvalid",
                            token,
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

                this.emit("auth", BASE_URL + "/spotify/auth/" + (user.meta?.serviceId ?? user.me?.id) + "/" + state);

                return;
            }

            this.spotifyApi.setRefreshToken(user.data.refreshToken);
            this.spotifyApi.setAccessToken(user.data.accessToken);

            if (user.data.expires < new Date().getTime() + (5 * 60e3)) {
                console.log("Refreshing token for user", user.me?.id);

                await this.refreshSpotifyToken(user);
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

                const state = await this.refreshSpotifyToken();

                if (!state || state == "srverr") {
                    const prevConf = await db.get<UserDocType>("users", user.meta.serviceId);

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

        try {
            incrementRequestCount();
            auth = (await this.spotifyApi.refreshAccessToken()).body;
        } catch (ex) {
            console.warn("Primary token refresh strategy failed for user", this.user?.meta.serviceId + ", error:", ex, "(falling back to secondary)");

            try {
                incrementRequestCount();

                // Try our method if library failed
                auth = await refreshSpotifyToken({
                    clientId: SPOT_CLIENT_ID,
                    clientSecret: SPOT_CLIENT_SECRET,
                    refreshToken: this.auth?.refreshToken ?? authOverride?.data.refreshToken ?? "",
                });
                
                if (auth == "srverr") {
                    console.warn("Failed to refresh Spotify token using secondary refresh strategy as the server returned a server error state, user:", this.user?.meta.serviceId);
                    
                    this.user?.meta.state == "srverr";

                    return "srverr";
                }
            } catch (ex) {
                console.warn("Secondary token refresh strategy failed for user", this.user?.meta.serviceId + ", error:", ex, "(unable to refresh token)");
            }
        }

        if (!auth) {
            console.warn("Failed to reauthorise access token: no auth value was set");
            
            return;
        }

        const prevConf = await db.get<UserDocType>("users", this.user?.meta.serviceId ?? authOverride?.meta.serviceId);

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
        const filePath = `/tempodb/data/tastes/${this.userId}.json`;

        if (!this.userId) {
            console.warn("Unable to save user taste profile, user ID not found");

            return;
        }

        writeFileSync(filePath, JSON.stringify(this.taste));
    }

    public async detachUser() {
        this.detach = true;

        await this.saveTasteProfile();
    }

    async loadTasteProfile() {
        if (this.detach)
            return;
        
        if (!this.userId) {
            console.warn("Unable to load user taste profile, user ID not found");

            return;
        }

        const filePath = `/tempodb/data/tastes/${this.userId}.json`;

        if (!existsSync(filePath)) {
            console.warn("User taste profile not found");

            return;
        }

        try {
            const data = JSON.parse(readFileSync(filePath).toString()) as UserTaste

            if (!data)
                return;

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
        } catch (ex) {
            console.warn("Failed to load user taste profile, error:", ex);

            return;
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

        this.unsecureEntropy = Math.random();

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
                const s = await this.refreshSpotifyToken();

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

                    imageUrl = (image ? image.url : item.album.images[0].url);
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
                        previewUrl: item.preview_url ?? undefined,
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
                        }
                    })
                }

                const todayStartTime = getTodayStartDate();

                const todaysSongStats = this.analyseDailyListenershipForSong(todayStartTime, songId);

                if (this.user && this.user.me?.images.length > 0) {
                    const scdnUrl = this.user.me?.images.find(v => v.url.startsWith("https://i.scdn."));

                    const targetImg = scdnUrl ?? this.user.me?.images[0]

                    this.pfpUrl = targetImg.url;
                }

                resolve({
                    userId: this.user?.meta.serviceId ?? "",
                    songId,
                    albumId,
                    progressNormal,
                    isPlaying,
                    timeRemaining,
                    duration,
                    imageUrl,
                    username: this.user?.me.displayName ?? "",
                    pfpUrl: (this.pfpUrl ?? ""),
                    explicit,
                    entropy: this.unsecureEntropy,
                    replayCount: this.replayCount,
                    playSessionStart: this.playSessionStart,
                    name,
                    artists,
                    updatedAt: new Date().getTime(),
                    lastEventSentAt: this.playbackState?.lastEventSentAt ?? -1,
                    todayStats: todaysSongStats,
                    mediaType: data.currently_playing_type,
                });
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
    if (!(await db.exists("users")))
        return;

    const users = await db.all<UserDocType>("users");

    users.forEach(async data => {
        try {
            console.log("Starting monitor for user:", data.me?.id);

            const user = new User(SPOT_CLIENT_ID, SPOT_CLIENT_SECRET);

            await user.init(data);
        } catch (ex) {
            console.error("Failed to start user account monitor for", data.me?.id, "error:", ex, "user:", data);
        }
    });
}

function authNewUser(auth: SpotifyUser, redirUri?: string) {
    return new Promise<string>((resolve, reject) => {
        if (flagServerShutdown)
            reject("Server is unable to process request");

        try {
            const user = new User(SPOT_CLIENT_ID, SPOT_CLIENT_SECRET);

            user.on("auth", (url) => {
                resolve(url);
            });

            user.init(auth);
        } catch (ex) {
            reject(ex);
        }
    });
}

async function removeAuthCookie(userId: string, res: Response) {
    const newEnt = randomBytes(12).toString("hex");

    await db.set<UserDocType["meta"]["tokenEntropy"]>("users", userId + "/meta/tokenEntropy", newEnt);

    tempoToken.setUserEntropy("tempo", newEnt);

    res.clearCookie("tempo.a", {
        domain: ".tempo-music.co",
        sameSite: "none",
        secure: true,
    });
}

async function setAuthCookie(res: Response, userId: string, username: string) {
    let ent = randomBytes(12).toString("hex");

    const userObjEnt = await db.get<UserDocType["meta"]["tokenEntropy"]>("users", userId + "/meta/tokenEntropy");

    if (userObjEnt) {
        ent = userObjEnt;
    } else {
        await db.set<UserDocType["meta"]["tokenEntropy"]>("users", userId + "/meta/tokenEntropy", ent);
    }

    tempoToken.setUserEntropy(userId, ent);

    const tok = tempoToken.generateSignedToken({
        id: userId,
        username,
        ent,
    });

    res.cookie("tempo.a", tok, {
        domain: ".tempo-music.co",
        sameSite: "none",
        secure: true,
        // Expires in 1 year
        expires: new Date(Date.now() + (3600e3 * 24 * 365)),
    })
}

function hash(str: string) {
    return createHash("sha256").update(str, "utf8").digest("hex");
}

async function doesFriendshipPairExist(u1: string, u2: string) {
    const exists = await db.get<UserFriendship>("friends", hash([u1, u2].sort().join(":")));

    console.log("doesFriendshipPairExist lookup, hash:", hash([u1, u2].sort().join(":")), "obj:", exists);

    return (exists !== null);
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
    const doesExist = await db.exists("users", userId);

    if (!doesExist)
        return [];

    const friendships = await db.get<UserDocType["friends"]>("users", userId + "/friends");

    if (!friendships)
        return [];

    let processed: UserFriendship[] = [];

    for (const frId of friendships) {
        const fr = await db.get<UserFriendship>("friends", frId);

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
        const usr = await db.get<UserDocType>("users", v.u1Id == userId ? v.u2Id : v.u1Id);

        if (!usr)
            return null;

        return usr;
    }))).filter(v => v !== null);

    return friendUsers;
}

async function createFriendRequest(initiatorId: string, targetId: string) {
    const initUser = await db.exists("users", initiatorId);
    const targetUser = await db.exists("users", targetId);

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
        const friendIds = await db.get<UserDocType["friends"]>("users", uid + "/friends");

        if (!friendIds || friendIds.includes(frId))
            continue;
        
        await db.update<UserDocType["friends"]>("users", uid + "/friends", [...friendIds, frId]);
    }
    
    return "VALIDATED";
}

async function acceptFriendRequest(accepterId: string, friendshipId: string) {
    const friendship = await db.get<UserFriendship>("friends", friendshipId);

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

    return true;
}

async function blockFriend(friendshipId: string, blockerId: string) {
    const prevUser = await db.get<UserDocType>("users", blockerId);

    // no-op
    if (!prevUser) {
        console.warn("User", blockerId, "attempted to block friendship", friendshipId, "but the user could not be found");

        return false;
    }

    const doesExist = await db.exists("friends", friendshipId);

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
    const doesExist = await db.exists("friends", friendshipId);

    if (!doesExist)
        return false;

    const fr = await db.get<UserFriendship>("friends", friendshipId);

    if (!fr)
        return false;

    // Remove the reference to the friendship
    for (const uid of [fr.u1Id, fr.u2Id]) {
        const userFriends = await db.get<UserDocType["friends"]>("users", uid + "/friends");

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

function enrollNewUser(redirToUI?: boolean, swapTokenId?: string) {
    return new Promise<string>((resolve) => {
        const spotifyApi = new SpotifyWebApi({
            clientId: SPOT_CLIENT_ID,
            clientSecret: SPOT_CLIENT_SECRET,
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

                incrementRequestCount();

                const me = await spotifyApi.getMe();

                session.me = me;
            }

            if (storeMe) {
                try {
                    await storeMeData();

                    return;
                } catch (ex) {
                    console.error("Failed to get user info, error:", ex);
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
                    console.error("Failed to get user info, error:", ex);

                    if (swapTokenId && tokSwapStore[swapTokenId]) {
                        tokSwapStore[swapTokenId].token = "ERR";
                        res?.redirect("https://www.tempo-music.co/static-error");
                    } else if (redirToUI) {
                        res?.redirect("https://www.tempo-music.co/error");

                        return;
                    }

                    res?.status(500).send("Unable to authorise");

                    return;
                }
            }

            const me = session.me;

            const activeSession = userSessions.find(v => v.u.user?.me.id == me.body.id && v.u.user?.meta.state == "authvalid");

            if (activeSession) {
                // Old session doesnt have an auth token, create one
                if (activeSession.u.user && !activeSession.u.user.meta.token) {
                    activeSession.u.user.meta.token = createAuthToken(activeSession.u.user.me?.id);

                    await db.set<UserDocType>("users", activeSession.u.user.meta.serviceId, activeSession.u.user);
                }

                if (res && activeSession.u.user?.meta.token)
                    await setAuthCookie(res, activeSession.u.user?.meta.serviceId, activeSession.u.user.me?.displayName ?? "");

                if (swapTokenId && tokSwapStore[swapTokenId] && activeSession.u.user?.meta.token) {
                    tokSwapStore[swapTokenId].token = activeSession.u.user.meta.token;
                    
                    if (tokSwapStore[swapTokenId].completeCb)
                        tokSwapStore[swapTokenId].completeCb();

                    return res?.redirect((BASE_URL.includes("tempo-music") ? "https://tempo-music.co" : "http://localhost:3000")+ "/static-success?st=" + activeSession.u.user.meta.token);
                } else if (redirToUI) {
                    return res?.redirect(BASE_URL.includes("tempo-music") ? "https://tempo-music.co/success" : "http://localhost:3000/success");
                }

                res?.redirect("https://tempo-music.co/success");

                return;
            }

            session.remove();

            console.log("Enrolling user with ID", me.body.id, clientId, clientSecret);

            const token = createAuthToken(me.body.id);
            
            if (res)
                await setAuthCookie(res, me.body.id, me.body.display_name);

            const prev = await db.get<UserDocType>("users", me.body.id);

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
                    listenerTypeClassification: "Casual Listener",
                },
                serverCreds: {
                    clientId: clientId,
                    clientSecret: clientSecret,
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
                    tokenEntropy: randomBytes(12).toString("hex"),
                },
                // If there are stored friends for this user, make sure we keep them
                friends: (prev?.friends ?? []),
            };

            await db.set<UserDocType>("users", me.body.id, payload);

            try {
                const redirUrl = await authNewUser(payload, redirToUI ? "https://www.tempo-music.co/" : undefined);

                if (res)
                    res.redirect(redirUrl);
                else if (cb)
                    cb(redirUrl.split("/")[redirUrl.split("/").length - 1]);
            } catch {
                res?.status(500).send("ERROR")
            }
        }, true, true, redirToUI ? "https://www.tempo-music.co/" : undefined);

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

            const idx = userSessions.findIndex(v => v.u.user && v.u.user.meta.serviceId == suser.meta.serviceId);

            // Make sure we update in memory as well
            if (idx !== -1)
                userSessions[idx].u.user = suser;

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

                const prevItemTimestamp = user.u.taste.history[0]?.timestamp ?? -2;
                const refreshOffset = Math.max(nextRefreshTimeout, user.u.user.meta.nextRefresh - Date.now());
                const checkTime = Math.max(prevItemTimestamp, user.u.interestingEventTimestamp) + Math.max(refreshOffset, 0);

                // If the last item was played >= 10 min ago reset session start timestamp
                if (user.lastPlaySessionStart !== -1 && checkTime > 0 && Date.now() - checkTime >= 600e3 && checkTime > user.lastPlaySessionStart) {
                    console.log(user.u.user?.me?.id, "has lost a", checkTime - user.lastPlaySessionStart, "ms streak");
                    
                    user.u.addStreakLostHistoryItem(checkTime - user.lastPlaySessionStart);
                    user.lastPlaySessionStart = -1;

                    try { unlinkSync(STREAK_BAK_META_PATH + (user.u.user.me?.id ?? user.u.user.meta?.serviceId)); } catch { }
                }
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

                user.u.broadcastPlaybackUpdate({
                    state: undefined,
                    action: "STOPPED"
                });

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
                        
                try {
                    if (usrId) {
                        const streakSave: StreakSave = {
                            honorId: serverLiveliness.honorId,
                            userId: usrId,
                            playSessionStart: user.u.playSessionStart,
                        };

                        writeFileSync(STREAK_BAK_META_PATH + (user.u.user.me?.id ?? user.u.user.meta?.serviceId), JSON.stringify(streakSave));
                    }
                } catch (ex) {
                    console.warn("Failed to save user streak backup for user", usrId, "error:", ex);
                }
            }

            if (v.isPlaying) {
                let localPlaySessionStart = v.playSessionStart;

                if (!prevState) {
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
                if (prevState.songId !== v.songId) {
                    // Song changed
                    console.log(`[${user.u.user?.me.id}]`, "Song changed", prevState.songId, "-->", v.songId);

                    user.u.resetCurrentSongReplayCount();
                    user.u.incrementSongPlaybackCount(v.songId);

                    user.u.interestingEventTimestamp = Date.now();

                    // Check if we have skipped the song
                    if (prevState.progressNormal < 0.75) {
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

                    sorchCentralCeeNotifierPlugin(user.u.user.meta.serviceId, v.songId);
                }

                if (prevState.isPlaying !== v.isPlaying) {
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
                if (prevState.songId === v.songId && v.progressNormal < 0.2 && prevState.progressNormal > 0.65) {
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

            console.log(`[${user.u.user?.me.id}]`, "Next refresh in", user.u.user.meta.nextRefresh - new Date().getTime(), "ms")

            user.u.playbackState = v;
            await user.u.saveTasteProfile();
        });

        await wait(BASE_REFRESH_RATE);
    }
}

db.on("ready", () => {
    setInterval(() => {
        globalSpotifyAPIRequestCount = globalSpotifyAPIRequestCounter;
        globalSpotifyAPIRequestCounter = 0;
    }, 10e3);

    const server = app.listen(2246, () => {
        console.log("Listening on port 2246");

        scanAuthorisedUsers();
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