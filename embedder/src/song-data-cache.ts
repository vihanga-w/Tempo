import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { DATA_DIR } from "./env";

const CACHE_DIR = `${DATA_DIR}/song-data-cache/`;

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

/**
 * Markers Spotify (and labels) append to music-video and alternate-format
 * entries. Stripped when building a title key so the video and the audio release
 * of one recording collapse to the same identity.
 */
const VERSION_MARKERS = /\s*[\(\[\-]\s*(official\s+)?(music\s+)?(video|visualizer|visualiser|lyric[s]?\s+video|audio|clip)\s*[\)\]]?\s*$/gi;

function normaliseTitle(name: string) {
    return name
        .replace(VERSION_MARKERS, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .trim();
}

/**
 * Spotify namespaces its image ids by asset type, and album covers live under
 * ab67616d. A music video entry carries artwork from a different namespace
 * (ab6742d3 in the cases observed), which is what makes the same song show up
 * with the wrong art.
 */
const ALBUM_ART_PREFIX = "ab67616d";

function hasAlbumArtwork(song: SongData) {
    const url = song.album?.artUrl ?? "";
    const imageId = url.split("/image/")[1] ?? "";

    return imageId.startsWith(ALBUM_ART_PREFIX);
}

/** True when a title carries an explicit video marker. */
function titleLooksLikeVideo(name: string) {
    return /\b(official\s+)?(music\s+)?video\b|\bvisuali[sz]er\b/i.test(name);
}

/**
 * Whether `candidate` is a better canonical entry than `current`.
 *
 * Title markers alone are not enough: Spotify frequently gives the video entry
 * exactly the same title as the audio release (observed on "wokeuplikethis*",
 * identical names, differing only by id, ISRC, album and artwork namespace).
 * Real album artwork is the dependable signal, with the title marker kept as a
 * secondary tie-breaker.
 */
function isBetterCanonical(candidate: SongData, current: SongData) {
    const candidateArt = hasAlbumArtwork(candidate);
    const currentArt = hasAlbumArtwork(current);

    if (candidateArt !== currentArt)
        return candidateArt;

    const candidateVideo = titleLooksLikeVideo(candidate.name ?? "");
    const currentVideo = titleLooksLikeVideo(current.name ?? "");

    if (candidateVideo !== currentVideo)
        return currentVideo;

    return false;
}

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
    /**
     * Maps an identity key to the canonical song id for that recording.
     *
     * Spotify reports a music video as a distinct track: different id, different
     * artwork, and often its own ISRC. Without this the same song shows up twice
     * — once per format — across history, top songs and the friends feed.
     */
    private identityIndex: {[key: string]: string} = {};

    constructor(cacheDir?: string) {
        this.cacheDir = (cacheDir ?? CACHE_DIR);
        this.songsListingCache = {
            updatedAt: -1,
            data: [],
        }
        this.songMetaCache = {};

        if (!existsSync(this.cacheDir))
            mkdirSync(this.cacheDir);

        this._loadIdentityIndex();
    }

    /**
     * Deliberately not a .json file: listSongs() parses every .json in this
     * directory as a SongData, so an index stored with that extension is read
     * back as a malformed song and crashes the load.
     */
    private get _identityIndexPath() {
        return `${this.cacheDir}.identity-index`;
    }

    private _loadIdentityIndex() {
        try {
            if (existsSync(this._identityIndexPath))
                this.identityIndex = JSON.parse(readFileSync(this._identityIndexPath).toString());
        } catch (ex) {
            console.warn("Failed to load song identity index, starting empty. Error:", ex);

            this.identityIndex = {};
        }
    }

    private _saveIdentityIndex() {
        try {
            writeFileSync(this._identityIndexPath, JSON.stringify(this.identityIndex));
        } catch (ex) {
            console.warn("Failed to save song identity index, error:", ex);
        }
    }

    private _identityKeys(song: SongData) {
        const keys: string[] = [];

        if (song.isrc)
            keys.push("isrc:" + song.isrc);

        // Video releases frequently carry their own ISRC, so also key on the
        // title stripped of format markers plus the primary artist
        const primaryArtist = song.artists?.[0]?.id;
        const title = normaliseTitle(song.name ?? "");

        if (primaryArtist && title)
            keys.push(`ta:${title}:${primaryArtist}`);

        return keys;
    }

    /**
     * Returns the canonical id for a recording, registering it if unseen.
     *
     * When both a video and an audio entry are known, the audio one wins: it is
     * the version with the album artwork and metadata users expect to see.
     */
    public resolveCanonicalId(song: SongData): string {
        const keys = this._identityKeys(song);

        if (keys.length === 0)
            return song.id;

        let canonical: string | undefined;

        for (const key of keys) {
            if (this.identityIndex[key]) {
                canonical = this.identityIndex[key];
                break;
            }
        }

        if (!canonical) {
            for (const key of keys)
                this.identityIndex[key] = song.id;

            this._saveIdentityIndex();

            return song.id;
        }

        if (canonical === song.id) {
            // Backfill any key this recording did not previously have
            let added = false;

            for (const key of keys) {
                if (!this.identityIndex[key]) {
                    this.identityIndex[key] = canonical;
                    added = true;
                }
            }

            if (added)
                this._saveIdentityIndex();

            return canonical;
        }

        const existing = this.getItem(canonical);

        // Promote this entry if it is the better representation of the recording
        if (existing && isBetterCanonical(song, existing)) {
            // Repoint every key that referenced the demoted entry, not just this
            // recording's own keys. The demoted entry has keys of its own (its
            // distinct ISRC, for one), and leaving those behind would make it
            // resolve to itself and the merge would only work in one direction.
            for (const [key, value] of Object.entries(this.identityIndex)) {
                if (value === canonical)
                    this.identityIndex[key] = song.id;
            }

            for (const key of keys)
                this.identityIndex[key] = song.id;

            this._saveIdentityIndex();

            console.log(
                "[identity] promoted", song.id, `("${song.name}", art ${hasAlbumArtwork(song) ? "album" : "non-album"})`,
                "over", canonical, `("${existing.name}", art ${hasAlbumArtwork(existing) ? "album" : "non-album"})`
            );

            return song.id;
        }

        console.log("[identity] reconciled", song.id, `("${song.name}")`, "->", canonical, existing ? `("${existing.name}")` : "");

        return canonical;
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

            // Skip dotfiles entirely — sidecar metadata lives alongside these
            // records and must never be parsed as one
            if (v.startsWith(".") || !v.endsWith(".json"))
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