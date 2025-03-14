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
    type: "track" | "episode";
    meta: {
        updatedAt: number;
    }
}

// Keep cache for 2 days
const SDC_MAX_AGE = 3600e3 * 48;

export class SongDataCache {
    constructor() {
        if (!existsSync(CACHE_DIR))
            mkdirSync(CACHE_DIR);
    }

    private _getRawItem(songId: string): songData | null {
        const path = `${CACHE_DIR}${songId}.json`;

        if (!existsSync(path))
            return null;

        const data = JSON.parse(readFileSync(path).toString()) as songData;

        return data;
    }

    // Wrapper for _getItem, includes backward compatibility fixes and additiona processing
    getItem(songId: string): songData | null {
        const d = this._getRawItem(songId);

        if (!d)
            return null;

        return {
            ...d,
            // Backwards compatibility as type property was added later
            type: d.type ?? "track",
        };
    }

    setItemIfNotExist(data: songData) {
        const path = `${CACHE_DIR}${data.id}.json`;

        // no-op if already exists and not expired
        if (existsSync(path)) {
            const d = this._getRawItem(data.id);

            // Check d.type as well as if its an old file which doesnt have the property, refresh regardless of expiry
            if (d && d.type && Date.now() - d.meta.updatedAt <= SDC_MAX_AGE)
                return;
        }

        writeFileSync(path, JSON.stringify(data));
    }
}