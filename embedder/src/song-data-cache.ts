import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const CACHE_DIR = "./song-data-cache/";

export interface songData {
    id: string;
    name: string;
    artists: {
        id: string;
        name: string;
        url: string;
        uri: string;
    }[];
    duration: number;
    explicit: boolean;
    album: {
        id: string;
        name: string;
        releaseDate: number;
        artUrl: string;
    }
    meta: {
        updatedAt: number;
    }
}

export class SongDataCache {
    constructor() {
        if (!existsSync(CACHE_DIR))
            mkdirSync(CACHE_DIR);
    }

    getItem(songId: string) {
        const path = `${CACHE_DIR}${songId}.json`;

        if (!existsSync(path))
            return null;

        const data = JSON.parse(readFileSync(path).toString()) as songData;

        return data;
    }

    setItemIfNotExist(data: songData) {
        const path = `${CACHE_DIR}${data.id}.json`;

        // no-op if already exists
        if (existsSync(path))
            return;

        writeFileSync(path, JSON.stringify(data));
    }
}