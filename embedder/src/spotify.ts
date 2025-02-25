import SpotifyWebApi from "spotify-web-api-node";
import { UserTaste } from "./user-taste";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import express, { Response } from "express";
import bodyParser from "body-parser";
import { randomBytes } from "crypto";
import EventEmitter from "events";

const BASE_URL = "https://tempo.filmclick.eu.org";
// const BASE_URL = "http://localhost:2246";
const SPOT_CLIENT_ID = "931970aea8e840b0b9678ea890fa4cea";
const SPOT_CLIENT_SECRET = "33460761b24240e88475bcbcbbcf28c6";
const SPOT_REDIRECT_URI = BASE_URL + "/spotify/callback";

interface AuthSession {
    me?: any;
    cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => Promise<void>;
    enroll?: boolean;
    username?: string;
    rTimeout: NodeJS.Timeout;
    remove: () => void;
};

let authSessions: {[key: string]: AuthSession} = {};

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/spotify/callback", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;

    const session = authSessions[state];

    if (!session) {
        res.redirect("/auth");

        return;
    }

    if (!session.enroll) {
        try {
            await session.cb(code);

            res.send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Welcome to Tempo</title>
                <!-- Google Fonts -->
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
                <link
                    href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap"
                    rel="stylesheet"
                />
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
                    color: #333;
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
                    fill: #28a745;
                    }
                </style>
                </head>
                <body>
                <div class="card">
                    <div class="icon">
                    <svg viewBox="0 0 52 52">
                        <path d="M26,0C11.664,0,0,11.664,0,26s11.664,26,26,26s26-11.664,26-26S40.336,0,26,0z M21.02,39.428l-10.29-10.29
                        l3.576-3.576l6.714,6.714l14.644-14.644l3.576,3.576L21.02,39.428z"/>
                    </svg>
                    </div>
                    <h1>All Done!</h1>
                    <p>Your Tempo account has now been setup.<br>You are logged in as ${session.username}.</p>
                </div>
                </body>
                </html>
            `);
        } catch (ex) {
            console.error("User account setup failed, error:", ex);

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
                </body>
                </html>
            `);
        }

        return;
    }

    await authSessions[state].cb(code, undefined, undefined, undefined, true);

    const preAuthUser: { id: string } = (authSessions[state].me && authSessions[state].me.body) ? authSessions[state].me.body : undefined;

    // We already have an app configured for this user, use it
    if (existsSync(`./auth/${preAuthUser.id}_auth.json`)) {
        const userData = JSON.parse(readFileSync(`./auth/${preAuthUser.id}_auth.json`, "utf8")) as SpotifyUser;

        if (userData.serverCreds.clientId && userData.serverCreds.clientSecret)
            await authSessions[state].cb(code, userData.serverCreds.clientId, userData.serverCreds.clientSecret, res);

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
        </div>
        </body>
        </html>
    `);
});

app.get("/spotify/auth/:userId/:state", (req, res) => {
    const state = req.params.state;

    if (req.params.userId == "cb") {
        res.redirect(`https://accounts.spotify.com/authorize?client_id=${SPOT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SPOT_REDIRECT_URI)}&scope=&state=${state}`);

        return;
    }

    if (!existsSync(`./auth/${req.params.userId}_auth.json`)) {
        res.status(400).send("User not configured");

        return;
    }

    const userCreds = JSON.parse(readFileSync(`./auth/${req.params.userId}_auth.json`, "utf8")) as SpotifyUser;

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${userCreds.serverCreds.clientId}&response_type=code&redirect_uri=${encodeURIComponent(SPOT_REDIRECT_URI)}&scope=user-read-playback-state%20user-read-currently-playing%20user-read-private%20user-read-email&state=${state}`;

    res.redirect(authUrl);
});

app.post("/spotify/enroll", (req, res) => {
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

app.get("/auth", async (_, res) => {
    const redirUrl = await enrollNewUser();

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);
});

interface SpotifyUser {
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
    };
    serverCreds: {
        clientId: string;
        clientSecret: string;
    };
    meta: {
        state: "unauth" | "authvalid" | "reauth";
        serviceId: string;
    }
};

function createAuthSession(username: string, cb: (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => Promise<void>, isEnrollment?: boolean) {
    const state = randomBytes(4).toString("hex");

    authSessions[state] = {
        username,
        cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => {
            // Make sure session isnt removed while it is being used
            try{ clearTimeout(authSessions[state].rTimeout); } catch { }

            return cb(authSessions[state], code, clientId, clientSecret, res, storeMe);
        },
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

class User extends EventEmitter {
    private spotifyApi: SpotifyWebApi;
    private playbackState?: {
        songId: string;
        progressNormal: number;
        isPlaying: boolean;
    };
    private taste: UserTaste;
    private userId?: string;
    private auth?: {
        accessToken: string;
        refreshToken: string;
        expires: number;
        scope: string;
        tokenType: string;
    };

    constructor(clientId: string, clientSecret: string) {
        super();

        this.taste = {
            songData: {},
            history: [],
        };

        console.log(clientId, clientSecret)

        this.spotifyApi = new SpotifyWebApi({
            clientId: clientId,
            clientSecret: clientSecret,
            redirectUri: SPOT_REDIRECT_URI
        });
    }

    async init(user: SpotifyUser) {
        await this.doAuth(user);

        if (!this.auth) {
            console.error("Authentication failed");

            return;
        }

        const me = await this.spotifyApi.getMe()
        
        this.userId = me.body.id;

        this.loadTasteProfile();

        // Actual loop
        while (true) {
            if (this.auth.expires < new Date().getTime() + (120 * 1e3)) {
                console.log("Refreshing token");

                await this.refreshSpotifyToken()
            }

            const prevState = this.playbackState;
            const currentState = await this.updateState();

            if (currentState?.isPlaying && (!prevState || prevState.songId !== currentState.songId)) {
                // Song started playing
                console.log("Song started playing", currentState.songId);

                this.incrementSongPlaybackCount(currentState.songId);
            }

            if (prevState && currentState) {
                if (prevState.songId !== currentState.songId) {
                    // Song changed
                    console.log("Song changed", prevState.songId, "-->", currentState.songId);

                    // Check if we have skipped the song
                    if (prevState.songId !== currentState.songId && prevState.progressNormal < 0.75) {
                        console.log("Skipped song");

                        this.incrementSongSkipCount(prevState.songId);
                        this.addHistoryItem(prevState.songId, prevState.progressNormal, true);
                    } else {
                        this.addHistoryItem(prevState.songId, 1, false);
                    }
                }

                // if (prevState.progressNormal !== currentState.progressNormal) {
                //     // Progress changed
                //     console.log("Progress changed:", prevState.progressNormal, "-->", currentState.progressNormal);
                // }

                if (prevState.isPlaying !== currentState.isPlaying) {
                    // Play state changed
                    console.log("Play state changed, isPlaying:", prevState.isPlaying, "-->", currentState.isPlaying);

                    if (!currentState.isPlaying)
                        this.addHistoryItem(currentState.songId, currentState.progressNormal, false);
                }

                // Detect if the song is replayed
                if (prevState.songId === currentState.songId && currentState.progressNormal < 0.05 && prevState.progressNormal > 0.05) {
                    console.log("Song replayed");

                    this.addHistoryItem(prevState.songId, 1, false);
                    this.incrementSongReplayCount(prevState.songId);
                }
            }

            this.playbackState = currentState;

            this.saveTasteProfile();

            // Wait for 1 second before the next iteration
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    doAuth(user: SpotifyUser) {
        return new Promise<SpotifyUser>(async (resolve, reject) => {
            console.log("Authorising user:", user);

            if (!user.data.accessToken || !user.data.refreshToken) {
                console.log("User not authenticated, userId:", user.me.id);

                const state = createAuthSession(user.me.displayName || "User", async (session: AuthSession, code: string) => {
                    session.remove();

                    const a = await this.spotifyApi.authorizationCodeGrant(code);
        
                    const data = {
                        accessToken: a.body.access_token,
                        refreshToken: a.body.refresh_token,
                        expires: new Date().getTime() + (a.body.expires_in * 1e3),
                        scope: a.body.scope,
                        tokenType: a.body.token_type,
                    };

                    console.log(data)
        
                    this.spotifyApi.setRefreshToken(data.refreshToken);
                    this.spotifyApi.setAccessToken(data.accessToken);
                    this.auth = data;
        
                    const me = await this.spotifyApi.getMe();

                    console.log(code)
        
                    if (!existsSync("./auth/"))
                        mkdirSync("./auth/");
        
                    const prevConf = JSON.parse(readFileSync(`./auth/${me.body.id}_auth.json`, "utf8")) as SpotifyUser;
        
                    const payload: SpotifyUser = {
                        data,
                        me: {
                            ...me.body,
                            displayName: me.body.display_name
                        },
                        serverCreds: {
                            clientId: prevConf.serverCreds.clientId,
                            clientSecret: prevConf.serverCreds.clientSecret,
                        },
                        meta: {
                            ...prevConf.meta,
                            state: "authvalid",
                        },
                    };
        
                    writeFileSync(`./auth/${me.body.id}_auth.json`, JSON.stringify(payload, undefined, 4));
        
                    resolve(payload);
                });

                this.emit("auth", BASE_URL + "/spotify/auth/" + user.meta.serviceId + "/" + state);

                return;
            }

            console.log("Authenticating user", user.me.id);

            this.spotifyApi.setRefreshToken(user.data.refreshToken);
            this.spotifyApi.setAccessToken(user.data.accessToken);

            if (user.data.expires < new Date().getTime() + (120 * 1e3)) {
                console.log("Refreshing token");

                await this.refreshSpotifyToken();
            }

            if (user.data.accessToken && user.data.refreshToken) {
                this.auth = user.data as {
                    accessToken: string;
                    refreshToken: string;
                    expires: number;
                    scope: string;
                    tokenType: string;
                };
            } else {
                reject("Access token or refresh token is missing");

                return;
            }

            if (this.auth.expires < new Date().getTime() + (120 * 1e3)) {
                console.log("Refreshing token for", user.me.id);

                const state = await this.refreshSpotifyToken();

                if (!state) {
                    const prevConf = JSON.parse(readFileSync(`./auth/${user.meta.serviceId}_auth.json`, "utf8")) as SpotifyUser;

                    prevConf.meta = {
                        ...prevConf.meta,
                        state: "reauth",
                    };

                    writeFileSync(`./auth/${user.meta.serviceId}_auth.json`, JSON.stringify(prevConf, undefined, 4));
                }

                console.log("Flagged account", user.meta.serviceId, "for reauthorisation");

                reject("reauth");
            }

            resolve(user);

            return;
        });
    }

    async refreshSpotifyToken() {
        if (this.auth && this.auth.expires > new Date().getTime() + 5e3) {
            const auth = await this.spotifyApi.refreshAccessToken();

            const prevConf = JSON.parse(readFileSync(`./auth/${this.userId}_auth.json`, "utf8")) as SpotifyUser;

            prevConf.data = {
                accessToken: auth.body.access_token,
                refreshToken: auth.body.refresh_token || prevConf.data.refreshToken,
                expires: new Date().getTime() + (auth.body.expires_in * 1e3),
                scope: auth.body.scope,
                tokenType: auth.body.token_type,
            };

            writeFileSync(`./auth/${this.userId}_auth.json`, JSON.stringify(prevConf, undefined, 4));

            // Make sure we are correctly authenticated
            await this.doAuth(prevConf);

            return true;
        }

        return false;
    }

    saveTasteProfile() {
        if (!this.userId) {
            console.warn("Unable to save user taste profile, user ID not found");

            return;
        }

        // Save the taste data
        if (!existsSync("./user-tastes/"))
            mkdirSync("./user-tastes/");

        writeFileSync(`./user-tastes/${this.userId}.json`, JSON.stringify(this.taste, undefined, 4));
    }

    loadTasteProfile() {
        if (!this.userId) {
            console.warn("Unable to load user taste profile, user ID not found");

            return;
        }

        if (!existsSync(`./user-tastes/${this.userId}.json`)) {
            console.warn("User taste profile not found");

            return;
        }

        this.taste = JSON.parse(readFileSync(`./user-tastes/${this.userId}.json`, "utf8"));
    }

    addHistoryItem(songId: string, sessionDuration: number, skipped: boolean) {
        // Prepend the new history item
        this.taste.history = [
            {
                songId,
                sessionDuration,
                skipped,
                timestamp: new Date().getTime(),
            },
            ...this.taste.history
        ];
    }

    incrementSongReplayCount(songId: string) {
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
    }

    incrementSongPlaybackCount(songId: string) {
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
    }

    incrementSongSkipCount(songId: string) {
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
        return new Promise<typeof this.playbackState | undefined>((resolve, reject) => {
            this.spotifyApi.getMyCurrentPlaybackState()
            .then(data => {
                const item = data.body.item;

                if (!item) {
                    resolve(undefined);

                    return;
                }

                const songId = item.id;
                const progressNormal = data.body.progress_ms ? (data.body.progress_ms / item.duration_ms) : 0;
                const isPlaying = data.body.is_playing;

                // console.log(songId, progressNormal, isPlaying);

                resolve({
                    songId,
                    progressNormal,
                    isPlaying
                });
            })
            .catch(e => {
                console.error(e);

                reject(e);
            });
        });
    }
}

function scanAuthorisedUsers() {
    // no-op if directory doesnt exist
    if (!existsSync("./auth/"))
        return;

    const files = readdirSync("./auth/");

    files.forEach(async file => {
        try {
            const data = JSON.parse(readFileSync(`./auth/${file}`, "utf8")) as SpotifyUser;

            const user = new User(data.serverCreds.clientId, data.serverCreds.clientSecret);

            await user.init(data);
        } catch (ex) {
            console.error("Failed to start user account monitor for config at", file, "error:", ex);
        }
    });
}

function authNewUser(auth: SpotifyUser) {
    return new Promise<string>((resolve, reject) => {
        try {
            console.log(auth.serverCreds.clientId, auth.serverCreds.clientSecret)
            const user = new User(auth.serverCreds.clientId, auth.serverCreds.clientSecret);

            user.on("auth", (url) => {
                resolve(url);
            });

            user.init(auth);
        } catch (ex) {
            reject(ex);
        }
    });
}

function enrollNewUser() {
    return new Promise<string>((resolve) => {
        const spotifyApi = new SpotifyWebApi({
            clientId: SPOT_CLIENT_ID,
            clientSecret: SPOT_CLIENT_SECRET,
            redirectUri: SPOT_REDIRECT_URI
        });

        const state = createAuthSession("", async (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => {
            if (storeMe) {
                const a = await spotifyApi.authorizationCodeGrant(code);

                const data = {
                    accessToken: a.body.access_token,
                    refreshToken: a.body.refresh_token,
                    expires: new Date(Date.now() + a.body.expires_in * 1e3),
                    scope: a.body.scope,
                    tokenType: a.body.token_type,
                };

                spotifyApi.setAccessToken(data.accessToken);

                const me = await spotifyApi.getMe();

                session.me = me;

                return;
            }
            
            if (!clientId || !clientSecret) {
                res?.status(400).send("Invalid client ID or secret");

                return;
            }

            if (!session.me) {
                const a = await spotifyApi.authorizationCodeGrant(code);

                const data = {
                    accessToken: a.body.access_token,
                    refreshToken: a.body.refresh_token,
                    expires: new Date(Date.now() + a.body.expires_in * 1e3),
                    scope: a.body.scope,
                    tokenType: a.body.token_type,
                };

                spotifyApi.setAccessToken(data.accessToken);

                const me = await spotifyApi.getMe();

                session.me = me;
            }

            const me = session.me;

            session.remove();

            console.log("Enrolling user with ID", me.body.id, clientId, clientSecret);

            const payload: SpotifyUser = {
                data: {
                    expires: -1,
                    scope: "",
                    tokenType: "",
                },
                me: { id: "", displayName: me.body.display_name },
                serverCreds: {
                    clientId: clientId,
                    clientSecret: clientSecret,
                },
                meta: {
                    serviceId: me.body.id,
                    state: "unauth",
                },
            };

            if (!existsSync("./auth/"))
                mkdirSync("./auth/");

            writeFileSync(`./auth/${me.body.id}_auth.json`, JSON.stringify(payload, undefined, 4));

            try {
                const redirUrl = await authNewUser(payload);

                res?.redirect(redirUrl);
            } catch {
                res?.status(500).send("ERROR")
            }
        }, true);

        resolve(`${BASE_URL}/spotify/auth/cb/${state}`);
    });
}

app.listen(2246, () => {
    console.log("Listening on port 2246");

    // const spotifyUser = new User();

    // spotifyUser.init();

    scanAuthorisedUsers();
});