import { read, readdirSync, readFileSync } from "fs";

let unknownSongs: string[] = [];

const files = readdirSync("./unknown-songs/");

for (const f of files) {
    const data = JSON.parse(readFileSync("./unknown-songs/" + f).toString()) as string[];

    data.forEach(v => {
        if (!unknownSongs.includes(v))
            unknownSongs.push(v);
    })
}

console.log("Discovered", unknownSongs.length, "unknown songs");