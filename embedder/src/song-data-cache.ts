import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const CACHE_DIR = "/tempodb/song-data-cache/";

export interface SongData {
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
    isrc?: string;
    previewUrl?: string;
    type: "track" | "episode";
    meta: {
        updatedAt: number;
    }
    ver?: number;
}

// Keep cache for 2 days
const SDC_MAX_AGE = 3600e3 * 48;
const EXPECTED_CACHE_VER = 2;

export class SongDataCache {
    private cacheDir: string;

    constructor(cacheDir?: string) {
        this.cacheDir = (cacheDir ?? CACHE_DIR);

        if (!existsSync(this.cacheDir))
            mkdirSync(this.cacheDir);
    }

    private _getRawItem(songId: string): SongData | null {
        const path = `${this.cacheDir}${songId}.json`;

        if (!existsSync(path))
            return null;

        const data = JSON.parse(readFileSync(path).toString()) as SongData;

        return data;
    }

    // Wrapper for _getItem, includes backward compatibility fixes and additional processing
    getItem(songId: string): SongData | null {
        const d = this._getRawItem(songId);

        if (!d)
            return null;

        return {
            ...d,
            // Backwards compatibility as type property was added later
            type: d.type ?? "track",
        };
    }

    setItemIfNotExist(data: SongData) {
        const path = `${this.cacheDir}${data.id}.json`;

        // no-op if already exists and not expired
        if (existsSync(path)) {
            const d = this._getRawItem(data.id);

            // Check d.type as well as if its an old file which doesnt have the property, refresh regardless of expiry
            if (d && d.type && d.ver == EXPECTED_CACHE_VER && Date.now() - d.meta.updatedAt <= SDC_MAX_AGE)
                return;
        }

        data.ver = EXPECTED_CACHE_VER;

        writeFileSync(path, JSON.stringify(data));
    }
}