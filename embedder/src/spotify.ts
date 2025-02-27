import SpotifyWebApi from "spotify-web-api-node";
import { DailyListenership, UserListenership, UserTaste } from "./user-taste";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import express, { Response } from "express";
import expressWs from "express-ws";
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
    cb: (code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean, cb?: (state: string) => void) => Promise<void>;
    enroll?: boolean;
    useServerCreds?: boolean;
    username?: string;
    rTimeout: NodeJS.Timeout;
    remove: () => void;
};

interface PlaybackState {
    songId: string;
    progressNormal: number;
    isPlaying: boolean;
    timeRemaining: number;
    imageUrl: string;
    username: string;
    explicit: boolean;
    name: string;
    artists: {
        name: string;
        url: string;
    }[];
};

let authSessions: {[key: string]: AuthSession} = {};
let userSessions: {
    u: User;
    nosies: {
        id: string;
        cb: ((data: {
            state?: PlaybackState;
            action: string;
        }) => void);
    }[];
}[] = [];

const app = expressWs(express()).app;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

    next();
});

app.get("/spotify/callback", async (req, res) => {
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
                        <script>
                            try {
                                history.replaceState({}, null, "/spotify/callback");
                            } catch { }
                        </script>
                    </body>
                </html>
            `);

            return;
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

app.get("/spotify/stalk", (_, res) => {
    const file = readFileSync("./static/basic-ui.html", "utf-8");

    res.send(file);
});

app.get("/auth", async (_, res) => {
    const redirUrl = await enrollNewUser();

    res.redirect("/spotify" + redirUrl.split("/spotify")[1]);

    // TODO: Need to actually store a client-side auth token in addition to provisioning server monitoring
});

app.get("/spotify/public/sessions", (_, res) => {
    res.json(userSessions.filter(v => v.u.user && v.u.user.me.id !== "").map(v => v.u.user?.me.id));
});

app.ws("/stream/:spotifyUserId", (ws, req, res) => {
    const userId = req.params["spotifyUserId"];

    const session = userSessions.find(v => v.u.user && v.u.user.me.id == userId);

    if (!session) {
        ws.send(JSON.stringify({
            code: 404,
            message: "Sorry, that user could not be found"
        }));

        ws.close();

        return;
    }

    let keepAliveLoop = setInterval(() => {
        if (!ws.OPEN)
            return;

        ws.send(JSON.stringify({
            code: -1
        }));
    }, 30e3);

    const cbId = randomBytes(6).toString("hex");

    const deleteCb = () => {
        const indexes: number[] = [];
        const seshs = session.nosies.filter((v, i) => {
            const valid = (v.id == cbId);

            if (valid)
                indexes.push(i);
            
            return valid;
        });

        if (seshs.length == 0)
            return;

        for (let i = 0; i < seshs.length; i++) {
            const index = indexes[i];

            session.nosies.splice(index, 1);
        }
    }

    session.nosies.push({
        id: cbId,
        cb(state) {
            if (!ws.OPEN) {
                return deleteCb();
            }

            ws.send(JSON.stringify({
                code: 200,
                data: state,
            }));
        },
    });

    ws.send(JSON.stringify({
        code: 200,
        data: {
            state: {
                ...session.u.playbackState,
                username: session.u.user ? session.u.user.me.displayName : session.u.playbackState?.username ?? "",
            },
            action: "LOAD",
        }
    }));

    ws.onclose = () => {
        clearInterval(keepAliveLoop);
        deleteCb();
    };
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
        nextRefresh: number;
    }
};

function createAuthSession(username: string, cb: (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean) => Promise<void>, isEnrollment?: boolean, useServerCreds?: boolean) {
    const state = randomBytes(4).toString("hex");

    authSessions[state] = {
        username,
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

    constructor(clientId: string, clientSecret: string) {
        super();

        this.taste = {
            songData: {},
            history: [],
            hourlyListenershipAggregate: createEmptyListenershipAggregate(),
        };

        this.spotifyApi = new SpotifyWebApi({
            clientId: clientId,
            clientSecret: clientSecret,
            redirectUri: SPOT_REDIRECT_URI
        });
    }

    async init(user: SpotifyUser) {
        this.user = await this.doAuth(user);

        if (!this.auth) {
            console.error("Authentication failed");

            return;
        }

        const me = await this.spotifyApi.getMe();
        
        this.userId = me.body.id;

        this.loadTasteProfile();

        if (!this.taste.hourlyListenershipAggregate)
            this.taste.hourlyListenershipAggregate = createEmptyListenershipAggregate();

        this.saveTasteProfile();

        this.taste = {
            songData: {},
            history: [],
            hourlyListenershipAggregate: createEmptyListenershipAggregate(),
        };

        this.loadTasteProfile();

        const listenership = this.getAverageDailyListenership(this.taste.hourlyListenershipAggregate);

        this.typicalListeningSchedule = listenership;

        console.log(`[${this.user.me.id}]`, "Average monthly user listenership:", listenership);

        if (userSessions.filter(v => v.u.user?.me && v.u.user.me.id == me.body.id).length == 0) {
            userSessions.push({
                u: this,
                nosies: [],
            });
        }
    }

    broadcastPlaybackUpdate(data: {
        state?: PlaybackState;
        action: string;
    }) {
        if (!this.user)
            return;
        
        const session = userSessions.find(v => v.u.user && v.u.user.me.id == this.user?.me.id)

        if (!session)
            return;

        const cbs = session.nosies;

        for (const cb of cbs) {
            try { cb.cb(data); } catch { }
        }
    }

    getAverageDailyListenership(listenershipAggregate: UserTaste["hourlyListenershipAggregate"]) {
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
        
        return avgMonthlyListenership;
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
        
                    this.spotifyApi.setRefreshToken(data.refreshToken);
                    this.spotifyApi.setAccessToken(data.accessToken);
                    this.auth = data;
        
                    const me = await this.spotifyApi.getMe();

                    session.me = me;
        
                    if (!existsSync("./auth/"))
                        mkdirSync("./auth/");
        
                    const prevConf = JSON.parse(readFileSync(`./auth/${user.meta.serviceId}_auth.json`, "utf8")) as SpotifyUser;
        
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

            if (!this.user?.meta.serviceId)
                return;

            const prevConf = JSON.parse(readFileSync(`./auth/${this.user.meta.serviceId}_auth.json`, "utf8")) as SpotifyUser;

            prevConf.data = {
                accessToken: auth.body.access_token,
                refreshToken: auth.body.refresh_token || prevConf.data.refreshToken,
                expires: new Date().getTime() + (auth.body.expires_in * 1e3),
                scope: auth.body.scope,
                tokenType: auth.body.token_type,
            };

            if (this.user)
                this.user.data = prevConf.data;

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
            // Refresh token if about to expire
            if (!this.user || this.user.data.expires < new Date().getTime() + (120 * 1e3))
                await this.refreshSpotifyToken();

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
                const timeRemaining = (data.body.item ? item.duration_ms - (data.body.progress_ms ?? 0) : -1);
                
                let imageUrl = "";
                let explicit = false;
                let name = "";
                let artists: {
                    name: string;
                    url: string;
                }[] = [];

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
                }

                resolve({
                    songId,
                    progressNormal,
                    isPlaying,
                    timeRemaining,
                    imageUrl,
                    username: this.user?.me.displayName ?? "",
                    explicit,
                    name,
                    artists,
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

        const state = createAuthSession("", async (session: AuthSession, code: string, clientId?: string, clientSecret?: string, res?: Response, storeMe?: boolean, cb?: (state: string) => void) => {
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

            if (userSessions.find(v => v.u.user?.me.id == me.body.id && v.u.user?.meta.state == "authvalid")) {
                res?.status(200).send(`
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
                                <p>You have already setup Tempo.<br>You are logged in as ${me.body.display_name}.</p>
                            </div>
                            <script>
                                try {
                                    history.replaceState({}, null, "/spotify/callback");
                                } catch { }
                            </script>
                        </body>
                    </html>    
                `);

                return;
            }

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
                    nextRefresh: new Date().getTime() + 1e3,
                },
            };

            if (!existsSync("./auth/"))
                mkdirSync("./auth/");

            writeFileSync(`./auth/${me.body.id}_auth.json`, JSON.stringify(payload, undefined, 4));

            try {
                const redirUrl = await authNewUser(payload);

                if (res)
                    res.redirect(redirUrl);
                else if (cb)
                    cb(redirUrl.split("/")[redirUrl.split("/").length - 1]);
            } catch {
                res?.status(500).send("ERROR")
            }
        }, true, true);

        resolve(`${BASE_URL}/spotify/auth/cb/${state}`);
    });
}

function getWeekStartDate() {
    const currentDate = new Date();
    const currentDay = currentDate.getDay();
    const todayDayBeginTime = new Date(currentDate.getTime() - ((currentDate.getHours() * 3600e3 + currentDate.getMinutes() * 60e3 + currentDate.getSeconds() * 1e3 + currentDate.getMilliseconds()))).getTime();
    const weekStartDay = todayDayBeginTime - (3600e3 * 24 * currentDay);

    return weekStartDay;
}

getWeekStartDate();

async function wait(timeout: number) {
    await new Promise(resolve => setTimeout(resolve, timeout));
}

const BASE_REFRESH_RATE = 200;
const MIN_REFRESH_RATE = 1e3;
const MAX_REFRESH_RATE = 100e3;

async function userStateRefreshLoop() {
    const currentDate = new Date();
    const todayDayBeginTime = new Date(currentDate.getTime() - ((currentDate.getHours() * 3600e3 + currentDate.getMinutes() * 60e3 + currentDate.getSeconds() * 1e3 + currentDate.getMilliseconds()))).getTime();

    let nextUserAvgListenershipRefreshTime = todayDayBeginTime;
    
    while (true) {
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
                
                v.u.typicalListeningSchedule = v.u.getAverageDailyListenership(v.u.taste.hourlyListenershipAggregate);
                refreshCount++;
            });

            nextUserAvgListenershipRefreshTime += (3600e3 * 24);

            console.log("Refreshed", refreshCount, "user weekly average listenership metric" + (refreshCount !== 1 ? "s" : "") + ", next refresh at", new Date(nextUserAvgListenershipRefreshTime).toString());
        }

        const states = await Promise.all(refreshableUsers.map(v => v.u.updateState().catch(() => undefined)));

        states.forEach((v, i) => {
            const user = refreshableUsers[i];

            if (!user.u.user)
                return;

            const schedule = user.u.typicalListeningSchedule || (new Array<DailyListenership>(7) as UserListenership).fill((new Array<number>(24) as DailyListenership).fill(0));

            const todaySchedule = schedule[new Date().getDay()];
            const currentHourPlayCount = user.u.taste.hourlyListenershipAggregate[0][0][new Date().getDay()][new Date().getHours()];

            let hourlySchedule = todaySchedule[new Date().getHours()];

            // If we exceed the expected hourly count, use current value in our calculation
            if (currentHourPlayCount > hourlySchedule * 1.25)
                hourlySchedule = currentHourPlayCount;

            console.log(`[${user.u.user?.me.id}]`, "Hourly schedule:", hourlySchedule)

            // Refresh time == 2 min if not available, or proportion of hour listened to music
            // (3600e3 / (hourlySchedule * 160)) == 60 min / (# of songs in this hour typically * 160)
            // 210 == average duration of a song in sec => 190s gives some leeway (for skipping)
            let nextRefreshTimeout = (hourlySchedule == 0 ? MAX_REFRESH_RATE : (3600e3 / (hourlySchedule * 160)));

            if (nextRefreshTimeout < MIN_REFRESH_RATE)
                nextRefreshTimeout = MIN_REFRESH_RATE;

            user.u.user.meta.nextRefresh = (new Date().getTime() + nextRefreshTimeout);

            if (!v) {
                user.u.user.meta.nextRefresh = (new Date().getTime() + 60e3);

                user.u.broadcastPlaybackUpdate({
                    state: undefined,
                    action: "STOPPED"
                });

                return;
            }

            const prevState = user.u.playbackState;

            if (v.timeRemaining !== -1) {
                // We want to refresh slightly before we mark song skipped in case user has skipped, then we can mark as appropriate
                // This means we refresh before and after song finishes
                const offset = (v.progressNormal <= 0.725 ? (v.timeRemaining / (1 - v.progressNormal)) * 0.75 : (v.timeRemaining / (1 - v.progressNormal)) + 1500);
                const nextTargetRefresh = (new Date().getTime() + offset);

                // If our calculated ideal refresh time is before then use calculated time
                if (offset < nextRefreshTimeout)
                    user.u.user.meta.nextRefresh = nextTargetRefresh;
            }

            if (v.isPlaying) {
                if (!prevState) {
                    // Song started playing
                    console.log(`[${user.u.user?.me.id}]`, "Song started playing", v.songId);

                    user.u.incrementSongPlaybackCount(v.songId);
                }

                user.u.broadcastPlaybackUpdate({
                    state: v,
                    action: "PLAYING:" + v.songId,
                });
            }

            if (prevState && v) {
                if (prevState.songId !== v.songId) {
                    // Song changed
                    console.log(`[${user.u.user?.me.id}]`, "Song changed", prevState.songId, "-->", v.songId);

                    user.u.incrementSongPlaybackCount(v.songId);

                    // Check if we have skipped the song
                    if (prevState.progressNormal < 0.75) {
                        console.log(`[${user.u.user?.me.id}]`, "Skipped song:", prevState.songId);

                        user.u.incrementSongSkipCount(prevState.songId);
                        user.u.addHistoryItem(prevState.songId, prevState.progressNormal, true);

                        // Refresh again quickly incase user is spamming skip button
                        if (nextRefreshTimeout <= 1750)
                            user.u.user.meta.nextRefresh = (new Date().getTime() + 250);
                        else
                            user.u.user.meta.nextRefresh = (new Date().getTime() + 1500)

                        user.u.broadcastPlaybackUpdate({
                            state: v,
                            action: "SKIPPED:" + prevState.songId,
                        });
                    } else  {
                        user.u.addHistoryItem(prevState.songId, 1, false);

                        user.u.broadcastPlaybackUpdate({
                            state: v,
                            action: "LISTENED:" + prevState.songId,
                        });
                    }
                }

                if (prevState.isPlaying !== v.isPlaying) {
                    // Play state changed
                    console.log(`[${user.u.user?.me.id}]`, "Play state changed, isPlaying:", prevState.isPlaying, "-->", v.isPlaying);
                    
                    if (!v.isPlaying)
                        user.u.addHistoryItem(v.songId, v.progressNormal, false);

                    user.u.broadcastPlaybackUpdate({
                        state: v,
                        action: `${v.isPlaying ? "PLAYING" : "PAUSED"}:${v.songId ?? prevState.songId}`,
                    });
                }

                // Detect if the song is replayed
                if (prevState.songId === v.songId && v.progressNormal < 0.05 && prevState.progressNormal > 0.05) {
                    console.log(`[${user.u.user?.me.id}]`, "Song replayed:", v.songId);

                    user.u.addHistoryItem(prevState.songId, 1, false);
                    user.u.incrementSongReplayCount(prevState.songId);
                    user.u.broadcastPlaybackUpdate({
                        state: v,
                        action: "REPLAYED:" + prevState.songId,
                    });
                }
            }

            console.log(`[${user.u.user?.me.id}]`, "Next refresh in", user.u.user.meta.nextRefresh - new Date().getTime(), "ms")

            user.u.playbackState = v;
            user.u.saveTasteProfile();
        });

        await wait(BASE_REFRESH_RATE);
    }
}

app.listen(2246, () => {
    console.log("Listening on port 2246");

    scanAuthorisedUsers();
    userStateRefreshLoop();
});