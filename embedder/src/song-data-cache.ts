import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";

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
    // Deprecated
    // previewUrl?: string;
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
    private songsListingCache: {
        updatedAt: number;
        data: SongData[];
    }
    private songMetaCache: {[key: string]: {
        updatedAt: number;
        data: SongData;
    }}

    constructor(cacheDir?: string) {
        this.cacheDir = (cacheDir ?? CACHE_DIR);
        this.songsListingCache = {
            updatedAt: -1,
            data: [],
        }
        this.songMetaCache = {};

        if (!existsSync(this.cacheDir))
            mkdirSync(this.cacheDir);
    }

    public listSongs<T>(modifier?: (song: SongData) => T) {
        const getProcessed = (data: SongData[]) => {
            return data.map(v => {
                return (modifier ? modifier(v) : v);
            });
        }

        if (this.songsListingCache.updatedAt !== -1 && Date.now() - this.songsListingCache.updatedAt <= 3600e3 * 6)
            return getProcessed(this.songsListingCache.data);

        const files = readdirSync(this.cacheDir);

        const songs = files.map(v => {
            const path = `${this.cacheDir}${v}`;

            if (v.startsWith("._") || !v.endsWith(".json"))
                return null;

            if (!existsSync(path))
                return null;

            const data = JSON.parse(readFileSync(path).toString()) as SongData;

            return data;
        }).filter(v => v !== null);

        this.songsListingCache.updatedAt = Date.now();
        this.songsListingCache.data = songs;

        return getProcessed(songs);
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
        // Cache for 24hr
        if (this.songMetaCache[songId] && Date.now() - this.songMetaCache[songId].updatedAt <= 3600e3 * 24)
            return this.songMetaCache[songId].data;
        else if (this.songMetaCache[songId])
            delete this.songMetaCache[songId]; // Cache expired

        const d = this._getRawItem(songId);

        if (!d)
            return null;

        const data = {
            ...d,
            // Backwards compatibility as type property was added later
            type: d.type ?? "track",
        };

        this.songMetaCache[songId] = {
            updatedAt: Date.now(),
            data,
        };

        return data;
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