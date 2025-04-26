import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { exit } from "process";
import { SongData } from "./song-data-cache";
import id3 from 'node-id3';
import PromptSync from "prompt-sync";

type TrainingSongData = {
    title: string;
    artists: string[];
    album: string;
    tempo?: number;
};

if (!existsSync("./unknown-track-import")) {
    mkdirSync("./unknown-track-import");

    console.warn("No tracks found to import, copy them to ./unknown-track-import/");
    exit(0);
}

const prompt = PromptSync();
const songDataCache: SongData[] = [];
const files = readdirSync("./unknown-track-import/").map(v => `./unknown-track-import/${v}`);

const trainingMeta = JSON.parse(readFileSync("songs.json").toString()) as {[key: string]: TrainingSongData};

console.log("Processing cached song metadata, this may take some time!");

for (const file of readdirSync("./song-data-cache/")) {
    const data = JSON.parse(readFileSync("./song-data-cache/" + file).toString()) as SongData;

    if (data.type == "track")
        songDataCache.push(data);
}

console.log("Loaded", songDataCache.length, "cached song metadata objects");

function searchName(name: string, results?: SongData[]) {
    if (!results)
        results = songDataCache;

    return results.filter(v => {
        return (v.name.toLowerCase().split(" ").join("") == name.toLowerCase().split(" ").join(""));
    });
}

function searchArtists(artists: string[], results?: SongData[]) {
    if (!results)
        results = songDataCache;

    return results.filter(v => {
        return (v.artists.map(v => v.name.toLowerCase().split(" ").join("")).sort().join("") == artists.map(v => v.toLowerCase().split(" ").join("")).sort().join(""));
    });
}

function searchAlbum(album: string, results?: SongData[]) {
    if (!results)
        results = songDataCache;

    return results.filter(v => {
        return (v.album.name.toLowerCase().split(" ").join("") == album.toLowerCase().split(" ").join(""));
    });
}

(async () => {
    if (!existsSync("./processed-new-tracks/"))
        mkdirSync("./processed-new-tracks/");

    let failedPaths: string[] = [];

    for (const path of files) {
        console.log("Processing file at", path);
    
        const f = id3.read(readFileSync(path));

        const name = f.title;
        const artist = f.artist;
        const album = f.album;

        if (!name || !artist || !album) {
            console.warn("Failed to automatically resolve track at \"" + path + "\" since there was missing metadata");
            failedPaths.push(path);
            continue;
        }

        const artists = artist.split("/");

        let res: SongData[] = [];

        res = searchName(name);

        if (res.length > 1)
            res = searchAlbum(album, res);

        if (res.length > 1)
            res = searchArtists(artists, res);

        if (res.length !== 1) {
           failedPaths.push(path);
           continue;
        }
        
        const meta = res[0];

        const payload: TrainingSongData = {
            title: meta.name,
            artists: meta.artists.map(v => v.name),
            album: meta.album.name,
        }

        trainingMeta[meta.id] = payload;

        copyFileSync(path, `./processed-new-tracks/${meta.id}.${path.split(".")[path.split(".").length-1]}`);
        unlinkSync(path);
    }

    console.log("Resolved", files.length - failedPaths.length + "/" + files.length, "tracks automatically");

    if (failedPaths.length > 0) {
        for (const path of failedPaths) {
            console.log("--------------------------\nManual track resolution:");

            const f = id3.read(readFileSync(path));

            const name = f.title;
            const artist = f.artist;
            const album = f.album;

            console.log("File Path:", path);
            console.log("META Title:", name);
            console.log("META Artists:", artist);
            console.log("META Album:", album);
            console.log("\nPlease enter spotify track id below, leave empty to skip\n");

            let id = prompt("Spotify ID (or url): ").trim();

            if (id == "")
                continue;

            if (id.startsWith("https://open.spotify.com/track/"))
                id = id.split("https://open.spotify.com/track/")[1].split("?")[0];

            if (existsSync("./song-data-cache/" + id + ".json")) {
                const data = JSON.parse(readFileSync("./song-data-cache/" + id + ".json").toString()) as SongData;

                const payload: TrainingSongData = {
                    title: data.name,
                    artists: data.artists.map(v => v.name),
                    album: data.album.name,
                }
        
                trainingMeta[data.id] = payload;

                id = data.id;
            } else {
                console.warn("Sorry, that id was not found in song metadata cache, please manually enter track details");

                const name = prompt("INPUT Title: ");
                const artists = prompt("INPUT Artists (delim: \",\"): ");
                const album = prompt("INPUT Album: ");

                const payload: TrainingSongData = {
                    title: name,
                    artists: artists.split(","),
                    album: album,
                }
        
                trainingMeta[id] = payload;
            }

            copyFileSync(path, `./processed-new-tracks/${id}.${path.split(".")[path.split(".").length-1]}`);
            unlinkSync(path);
        }
    }

    writeFileSync("songs.json", JSON.stringify(trainingMeta));

    console.log("All tracks have been processed!");
})();