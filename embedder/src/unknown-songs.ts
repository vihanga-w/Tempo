import { read, readdirSync, readFileSync, writeFileSync } from "fs";

let unknownSongs: string[] = [];

const knownSongs = Object.keys(JSON.parse(readFileSync("./songs.json").toString()));
const files = readdirSync("./unknown-songs/");

for (const f of files) {
    console.log("Processing file:", f);

    const data = JSON.parse(readFileSync("./unknown-songs/" + f).toString()) as string[];

    data.forEach(v => {
        if (!unknownSongs.includes(v) && !knownSongs.includes(v))
            unknownSongs.push(v);
    })
}

writeFileSync("unknown-songs.json", JSON.stringify(unknownSongs));

console.log("Discovered", unknownSongs.length, "unknown songs");