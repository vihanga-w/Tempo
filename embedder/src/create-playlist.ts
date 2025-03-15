import { existsSync, readFileSync } from "fs";
import express from "express";
import { randomBytes } from "crypto";
import { songData } from "./song-data-cache";

console.log("Loading unknown songs...")

const rawTargetList = JSON.parse(readFileSync("unknown-songs.json").toString()) as string[];

const targetListProcessed = rawTargetList.filter((v, i) => {
    console.log("Processing", v, `[${i + 1}/${rawTargetList.length}] [${(((i+1)/rawTargetList.length) * 100).toFixed(1)}%]`)

    const path = "./song-data-cache/" + v + ".json";

    if (!existsSync(path))
        return false;

    const meta = JSON.parse(readFileSync(path).toString()) as songData;

    return (meta.type == "track");
});

const chunk = (arr: string[], size: number) =>
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
      arr.slice(i * size, i * size + size)
    );

const targetList = chunk(targetListProcessed, 100);

const CLIENT_ID = "c432b1d2c50846a1aa3c41bded12c91e";
const CLIENT_SEC = "21f3c1fcf24146c9b63f98e32cf70728";

const app = express();

async function exchangeAuthCode(code: string) {
    const authToken = Buffer.from(CLIENT_ID + ':' + CLIENT_SEC).toString("base64");

    const req = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(CLIENT_ID + ":" + CLIENT_SEC).toString("base64")}`,
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: "http://localhost:2221/cb"
        }),
    });
    const res = await req.json() as {
        error?: string;
        access_token: string;
    };

    return res;
}

async function getUserId(token: string) {
    const req = await fetch('https://api.spotify.com/v1/me', {
        headers: {
          'Authorization': 'Bearer ' + token,
        }
    });
    const res = await req.json() as {
        id: string;
    };

    return res.id;
}

async function createPlaylist(token: string, id: string) {
    const uid = await getUserId(token);
    const req = await fetch('https://api.spotify.com/v1/users/' + uid + '/playlists', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            'name': 'New Playlist ' + id,
            'description': '',
            'public': false
        }),
    });
    const res = await req.json() as {
        id: string;
    }

    return res.id;
}

async function addSongsToPlaylist(token: string, pid: string, songIds: string[]) {
    const req = await fetch('https://api.spotify.com/v1/playlists/' + pid + '/tracks', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            'uris': songIds.map(v => `spotify:track:${v}`),
            'position': 0
        })
    });
    const res = await req.json();

    console.log(res)
    
    return ('error' in res);
}

app.get("/cb", async (req, res) => {
    const code = req.query.code;

    const token = await exchangeAuthCode(code as string);

    if (token.error) {
        res.status(500).send("Failed to exchange token");

        return;
    }

    const tok = token.access_token;

    let totalAddedCounter = 0;

    for (const sec of targetList) {
        const pid = randomBytes(3).toString("hex");

        const playlistId = await createPlaylist(tok, pid);

        console.log("Created playlist with id:", playlistId);
        
        const chunks = chunk(sec, 100);

        chunks.forEach(async (v, i) => {
            console.log("Pushing chunk", i + 1 + "/" + chunks.length);

            const success = await addSongsToPlaylist(tok, playlistId, v);

            if (success)
                totalAddedCounter += v.length;
        });
    }
    
    res.status(200).send("Added " + totalAddedCounter + " songs to new playlist");
});

app.get("/auth", (_, res) => {
    res.redirect(`https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent("http://localhost:2221/cb")}&scope=playlist-modify-private`);
});

app.listen(2221, "0.0.0.0", () => {
    console.warn("----- THIS IS AN INTERNAL TOOL -----")
    console.log("Server started, loaded " + targetList.length + " playlist chunks, authorise at http://localhost:2221/auth");
});