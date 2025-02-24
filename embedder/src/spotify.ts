import SpotifyWebApi from "spotify-web-api-node";
import { UserTaste } from "./user-taste";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import express from "express";
import { randomBytes } from "crypto";

const SPOT_CLIENT_ID = "931970aea8e840b0b9678ea890fa4cea";
const SPOT_CLIENT_SECRET = "7a11cc8f2f324bf9b43aaba3f48e49e5";
const SPOT_REDIRECT_URI = "http://localhost:2246/spotify/callback";

const app = express();

let authSessions: {[key: string]: {
    cb: (code: string) => void;
}} = {};


app.get("/spotify/callback", (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!authSessions[state]) {
        res.status(400).send("Invalid state");

        return;
    }

    authSessions[state].cb(code);

    res.send("Authenticated");
});

app.get("/spotify/auth/:state", (req, res) => {
    const state = req.params.state;

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOT_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(SPOT_REDIRECT_URI)}&scope=user-read-playback-state%20user-read-currently-playing&state=${state}`;

    res.redirect(authUrl);
});
// const authUrl = spotifyApi.createAuthorizeURL(["user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state"], "state", false);

// console.log("Auth spotify at", authUrl);

// spotifyApi.authorizationCodeGrant("AQDwKEss5XcDU9HxLe2cWKfgJkhQ0ysldDAIQhtWa6YALKbpF6Zm2746u0q0GsYIH45E2F6XuiYqJP3JJpdKzYgqUr8llDUbiPTthwvOfmN0vFD_7NdbVBt2k1lQ8C22YR2onaHzE1j4tHOrygOgX7eK7IvIFPQssKW3N1jBhBoEXwQy39BIdvLQBdTJgre5WNu3NyGf2FA7rVsrFhNgOVGL0h8BLuUJnZCK2QikEVXO38DaCnhBax-2hjJLvO73Ka2KiITH1VRCi4gKqZ1XZQMV1GnXJ99EjqlAkw8")
// .then(console.log)

class User {
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
        expires: Date;
        scope: string;
        tokenType: string;
    };

    constructor() {
        this.taste = {
            songData: {},
            history: [],
        };

        this.spotifyApi = new SpotifyWebApi({
            clientId: SPOT_CLIENT_ID,
            clientSecret: SPOT_CLIENT_SECRET,
            redirectUri: SPOT_REDIRECT_URI
        });

        // this.spotifyApi.setRefreshToken(access.refresh_token);
        // this.spotifyApi.refreshAccessToken().then(console.log)

        // const authUrl = this.spotifyApi.createAuthorizeURL(["user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state"], "state", false);

        // console.log("Auth spotify at", authUrl);

        // this.spotifyApi.authorizationCodeGrant("AQBSMtucqQwl2M7O5oK0N0pNBSsIEOLNIwdkkd0Uo2MrjJdzVhCWdd4D0_aKa9vP_KupZp8Nad1L5gPdh2-9XRS6bAMRrhAL-c3GqTUtOH03O4LmdalO9r7smub2CDGOuS32PVulynxc9qw9pNYP1-mxqNkA179Bv-vd-Mmz4GyCQpHbaBstYqBMZ79I_3DTVClR-a5I-bSl6gZp2TRPbIwTyN5_IgyMDivBjSNrhq7hAo10F7pfO0P50xRKnwCDwsT0tq9NwDvPa6gH-2tmE9Wup7ctA4w766QBs1M")
    }

    async init() {
        this.auth = await this.doAuth();

        this.spotifyApi.setAccessToken(this.auth.accessToken);

        const me = await this.spotifyApi.getMe()
        
        this.userId = me.body.id;

        this.loadTasteProfile();

        // Actual loop
        while (true) {
            if (this.auth.expires < new Date(Date.now() + 60 * 1e3)) {
                console.log("Refreshing token");

                await this.spotifyApi.refreshAccessToken();
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

                if (prevState.progressNormal !== currentState.progressNormal) {
                    // Progress changed
                    console.log("Progress changed:", prevState.progressNormal, "-->", currentState.progressNormal);
                }

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

    doAuth() {
        return new Promise<{
            accessToken: string;
            refreshToken: string;
            expires: Date;
            scope: string;
            tokenType: string;
        }>((resolve) => {
            if (existsSync("./auth.json")) {
                const data = JSON.parse(readFileSync("./auth.json", "utf8"));

                resolve(data);

                return;
            }

            const state = randomBytes(4).toString("hex");

            authSessions[state] = {
                cb: async (code: string) => {
                    const a = await this.spotifyApi.authorizationCodeGrant(code);

                    const data = {
                        accessToken: a.body.access_token,
                        refreshToken: a.body.refresh_token,
                        expires: new Date(Date.now() + a.body.expires_in * 1e3),
                        scope: a.body.scope,
                        tokenType: a.body.token_type,
                    };

                    writeFileSync("./auth.json", JSON.stringify(data, undefined, 4));

                    resolve(data);
                }
            };

            console.log("Login with Spotify at http://localhost:2246/spotify/auth/" + state);
        });
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

app.listen(2246, () => {
    console.log("Listening on port 2246");

    const spotifyUser = new User();

    spotifyUser.init();
});