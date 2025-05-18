import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { combinedSimilarity } from "./similarity";
import { randomBytes } from "crypto";
import { join } from "path";
import { SongDataCache } from "./song-data-cache";

interface EmbeddingOutput {
    songId: string;
    embedding: number[];
}

interface AlbumEmbeddingCacheObject {
    updatedAt: number;
    albumId: string;
    data: number[];
    v: number;
}

export interface EmbeddingsIndex {
    dir: string;
    idx: {
        // [songId]: path
        [key: string]: string;
    };
    available: boolean;
}

export interface Embedding {
    songId: string;
    embedding: number[];
}

export interface UserSongData {
    rating: number; // Must be a value between -1 and 1
    skipCount: number;
    playbackCount: number;
    replayCount: number;
}

export type DailyListenership = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
export type UserListenership = [
    DailyListenership,
    DailyListenership,
    DailyListenership,
    DailyListenership,
    DailyListenership,
    DailyListenership,
    DailyListenership,
];

export interface UserTaste {
    songData: { [key: string]: UserSongData };
    history: {
        songId: string;
        sessionDuration: number;
        skipped: boolean;
        replayed: boolean;
        timestamp: number;
    }[];
    streakHistory: {
        duration: number;
        timestamp: number;
    }[];
    affinityHistory: {
        songId: string;
        affinity: number;
        timestamp: number;
    }[];
    // TODO: tasteEvolution not yet implemented
    // TODO: It will record the evolution of the user's taste over time
    // TODO: Will be updated every 2 weeks
    // TODO: Used to calculate tasteDelta --> tasteRateOfChange
    // TODO: Metrics used to personalise future taste calculations
    tasteEvolution: {
        timestamp: number;
        embedding: number[];
    }[];
    hourlyListenershipAggregate: [
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
    ];
}

const albumEmbeddingsCache: { [key: string]: AlbumEmbeddingCacheObject["data"] } = {};

export function loadUserTasteFromFile(userId: string, timePeriod?: { start: number; end: number }): UserTaste {
    const filePath = `/tempodb/data/tastes/${userId}.json`;
    if (!existsSync(filePath)) {
        throw new Error(`User ${userId} does not exist in the tastes database`);
    }

    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as UserTaste;

    // Ensure loaded history has a valid timestamp
    data.history = data.history.filter(v => v.timestamp);

    // Filter history based on the requested time period
    if (timePeriod) {
        data.history = data.history.filter(v => v.timestamp >= timePeriod.start && v.timestamp <= timePeriod.end);
    }

    // Store in cache with timestamp
    tasteCache[userId] = {
        data: data,
        timestamp: Date.now(),
    };

    return data;
}

function createUserEmbedding(
    userData: UserTaste,
    songEmbeddings: { [key: string]: number[] },
    backdateHours?: number,
    historyFilterFunc?: (item: UserTaste["history"][0]) => boolean
): number[] {
    const weights: { [key: string]: number } = {
        rating: 2.0,
        skipCount: -0.5,
        playbackCount: 0.75,
        replayCount: 2.5,
        sessionDuration: 6,
        skipped: -0.5,
        affinity: 10.0,
    };

    const dataWeightSum: { [key: string]: number } = {};

    const timePeriodStart = Date.now() - ((backdateHours ?? 0) * 60 * 60 * 1000);
    const recentHistory = userData.history.filter(entry => {
        if (!historyFilterFunc) return entry.timestamp >= timePeriodStart;
        return historyFilterFunc(entry);
    });

    // Song data aggregation
    Object.entries(userData.songData).forEach(([songId, songData]) => {
        if (recentHistory.some(v => v.songId === songId)) return;
        for (const [key, value] of Object.entries(songData)) {
            if (key in weights) {
                let weight = weights[key];
                if (key === "rating" && value < 0) {
                    weight *= (1 + (Math.log1p(-value) * 3));
                }
                dataWeightSum[songId] = (dataWeightSum[songId] || 0) + (value * weight);
            }
        }
    });

    // History aggregation
    for (const songData of recentHistory) {
        for (const [key, value] of Object.entries(songData)) {
            if (key === "songId") continue;
            if (key in weights) {
                let weight = weights[key];
                if (key === "skipped" && songData.skipped) {
                    weight *= Math.max(0.1, 1 - songData.sessionDuration);
                }
                dataWeightSum[songData.songId] = (dataWeightSum[songData.songId] || 0) + (value as number) * weight;
            }
        }
    }

    const sixMonthsAgo = Date.now() - (6 * 30 * 24 * 60 * 60 * 1000); // 6 months ago (approx.)

    // 50% of the affinity is lost every 78 days
    const halfLifeDays = 78;
    const fixedDecayRatePerDay = Math.log(2) / halfLifeDays;

    userData.affinityHistory
        .filter(entry => entry.timestamp >= sixMonthsAgo)
        .forEach(entry => {
            const elapsedDays = (Date.now() - entry.timestamp) / (24 * 60 * 60 * 1000);
            const timeDecay = Math.exp(-fixedDecayRatePerDay * elapsedDays);
            const weightedAffinity = entry.affinity * weights["affinity"] * timeDecay;
            dataWeightSum[entry.songId] = (dataWeightSum[entry.songId] || 0) + weightedAffinity;
        });


    let weightedSum: number[] = [];
    const songIds = Object.keys(userData.songData).filter(id => id in songEmbeddings);

    if (songIds.length === 0) {
        return Array(songEmbeddings[Object.keys(songEmbeddings)[0]].length).fill(0);
    }

    for (const songId of songIds) {
        const embedding = songEmbeddings[songId];
        const dataWeight = dataWeightSum[songId] ?? 0;

        const sign = dataWeight >= 0 ? 1 : -1;
        const boostedWeight = Math.pow(Math.abs(dataWeight), 1.5);

        const weightedEmbedding = embedding.map(val => val * boostedWeight * sign);

        if (weightedSum.length === 0) {
            weightedSum = weightedEmbedding;
        } else {
            weightedSum = weightedSum.map((val, idx) => val + weightedEmbedding[idx]);
        }
    }

    // Normalize final user embedding
    const norm = Math.sqrt(weightedSum.reduce((sum, val) => sum + val * val, 0)) || 1;
    return weightedSum.map(val => val / norm);
}

let songEmbeddings: {
    [key: string]: number[];
} = {};

let tasteCache: {
    [userId: string]: {
        data: UserTaste;
        timestamp: number;
    };
} = {};

const CACHE_EXPIRY_TIME = 3600 * 1000; // 1 hour in milliseconds
const EMBEDDINGS_CACHE_EXPIRY_TIME = 24 * 3600 * 1000; // 24 hours in milliseconds

let lastEmbeddingsLoadTime = 0;
let embeddingIndex: EmbeddingsIndex = {
    dir: "./",
    idx: {},
    available: false,
};

function loadEmbeddingsIndex() {
    if (!existsSync("./embeddings-index.json")) {
        console.warn("No embeddings index was found, unable to load song embeddings");

        embeddingIndex = {
            dir: "./",
            idx: {},
            available: false,
        };

        return;
    }

    embeddingIndex = JSON.parse(readFileSync("./embeddings-index.json").toString()) as EmbeddingsIndex;
}

function loadSongEmbeddingsFromFile() {
    if (!embeddingIndex.available)
        loadEmbeddingsIndex();

    // If embeddings index failed to load, dont try process it
    if (!embeddingIndex.available)
        return;
    
    const currentTime = Date.now();
    
    if (Object.keys(songEmbeddings).length === 0 || (currentTime - lastEmbeddingsLoadTime) > EMBEDDINGS_CACHE_EXPIRY_TIME) {
        const targets = Object.keys(embeddingIndex.idx);

        targets.forEach((v) => {
            const path = join(embeddingIndex.dir, embeddingIndex.idx[v]);

            if (!existsSync(path)) {
                console.warn("Failed to process embedding", v, "as it does not exist at \"" + path + "\"");

                return;
            }

            try {
                const data = JSON.parse(readFileSync(path).toString()) as Embedding;

                if (data.songId !== v) {
                    console.warn("Failed to process embedding", v, "as the embedding metadata does not match what is expected (songId mismatch)");

                    return;
                }

                songEmbeddings[v] = data.embedding;
            } catch (ex) {
                console.warn("Failed to process embedding", v, "due to error:", ex);
            }
        });

        console.log("Took", Date.now() - currentTime, "ms to load song embeddings");

        lastEmbeddingsLoadTime = currentTime;
    }
}

/* ------ PROCESS ALBUM EMBEDDINGS ------ */

// Make sure song embeddings have been loaded, ready for album embeddings to be processed
loadSongEmbeddingsFromFile();

const ALBUM_EMBEDDINGS_DIR = "/tempodb/album-embeddings/";
const ALBUM_EMBEDDINGS_VER = 1;

if (!existsSync(ALBUM_EMBEDDINGS_DIR))
    mkdirSync(ALBUM_EMBEDDINGS_DIR);

const albumEmbeddingFiles = readdirSync(ALBUM_EMBEDDINGS_DIR).filter(v => !v.startsWith("._") && v.endsWith(".json"));

if (albumEmbeddingFiles.length > 0)
    console.log("Importing existing album embeddings");

albumEmbeddingFiles.forEach(v => {
    const path = `${ALBUM_EMBEDDINGS_DIR}${v}`;
    const data = JSON.parse(readFileSync(path).toString()) as AlbumEmbeddingCacheObject;

    let remove = false;

    if (data.v !== ALBUM_EMBEDDINGS_VER) {
        console.warn("Skipped importing album embeddings from", path, "as it has an invalid metadata version", `(got: ${data.v}, expected: ${ALBUM_EMBEDDINGS_VER})`, "(the file will be removed)");

        remove = true;
        
    }

    // Keep calculated album embeddings for 30 days
    const expirationCutoff = 3600e3 * 24 * 7 * 30;

    if (Date.now() - data.updatedAt > expirationCutoff && !remove) {
        console.warn("Skipped importing album embeddings from", path, "as it is expired", `(updated: ${new Date(data.updatedAt).toISOString()}, cutoff is ${expirationCutoff}ms)`, "(the file will be removed)");

        remove = true;
    }

    if (remove) {
        try { unlinkSync(path); } catch (ex) {
            console.error("Failed to remove album embedding file at", path, "error:", ex);
        }

        return;
    }

    console.log("Imported album embedding for", data.albumId, "from", path);

    albumEmbeddingsCache[data.albumId] = data.data;
});

const availableAlbumEmbeddingKeys = Object.keys(albumEmbeddingsCache);

console.log(availableAlbumEmbeddingKeys.length, "album embeddings are available");

const availableEmbeddingsKeys = Object.keys(songEmbeddings);

const availableSongAlbums = ((new SongDataCache()).listSongs<{
    s: string;
    a: string;
}>(d => {
    return {
        s: d.id,
        a: d.album.id,
    };
}) as {
    s: string;
    a: string;
}[]).filter(v => availableEmbeddingsKeys.includes(v.s)).map(v => v.a);

const albums = new Set<string>();

availableSongAlbums.forEach(v => {
    if (!albums.has(v))
        albums.add(v);
});

const availableAlbumIds = Array.from(albums);

const unknownAlbumEmbeddings = availableAlbumIds.filter(v => !availableAlbumEmbeddingKeys.includes(v));

if (unknownAlbumEmbeddings.length > 0) {
    console.log(unknownAlbumEmbeddings.length, "album embeddings are unknown, calculating them now...");

    unknownAlbumEmbeddings.forEach((v, i)=> {
        const embedding = getAlbumEmbedding(v);

        if (!embedding) {
            console.warn("Unable to calculate embedding for", v);
            
            return;
        }

        const cacheObj: AlbumEmbeddingCacheObject = {
            updatedAt: Date.now(),
            albumId: v,
            data: embedding,
            v: ALBUM_EMBEDDINGS_VER,
        }

        writeFileSync(`${ALBUM_EMBEDDINGS_DIR}${v}.json`, JSON.stringify(cacheObj));

        albumEmbeddingsCache[v] = embedding;

        console.log("Calculated embeddings for", v, `(${i+1}/${unknownAlbumEmbeddings.length} processed)`);
    });
}

console.log("Finished processing album embeddings")

export function getAlbumEmbedding(albumId: string) {
    const meta = new SongDataCache();

    type ResType = {
        songId: string,
        isrc?: string,
        albumId: string,
    };

    // Find all tracks we are aware of in this album
    const songsInAlbum = (meta.listSongs<ResType>(d => ({
        songId: d.id,
        albumId: d.album.id,
    })) as ResType[]).filter(v => v.albumId === albumId);

    const embeddings = songsInAlbum
        .map(v => songEmbeddings[v.songId])
        .filter((embedding): embedding is number[] => embedding !== undefined);

    if (embeddings.length === 0)
        return null;

    const embeddingLength = embeddings[0].length;

    // Calculate the sum and average
    const sumEmbedding = new Array(embeddingLength).fill(0);

    for (const embedding of embeddings) {
        for (let i = 0; i < embeddingLength; i++) {
            sumEmbedding[i] += embedding[i];
        }
    }

    return sumEmbedding.map(val => val / embeddings.length);
}

export function albumPlaybackAffinityEmbedding(taste: UserTaste) {
    const meta = new SongDataCache();

    let albumEmbeddingCache: {[key: string]: number[]} = {};
    let albumPlaybackFrequencies: {[key: string]: number} = {};

    // Process album listen counts + embeddings
    taste.history.forEach(v => {
        const item = meta.getItem(v.songId);

        if (!item)
            return;

        if (!albumEmbeddingCache[item.album.id]) {
            const albumEmbedding = getAlbumEmbedding(item.album.id);

            if (albumEmbedding)
                albumEmbeddingCache[item.album.id] = albumEmbedding;
        }

        if (!albumPlaybackFrequencies[item.album.id])
            albumPlaybackFrequencies[item.album.id] = 1;
        else
            albumPlaybackFrequencies[item.album.id] += 1;
    });

    // Sort albumPlaybackFrequencies by most frequent playback
    const sortedAlbums = Object.entries(albumPlaybackFrequencies)
        .sort((a, b) => b[1] - a[1])
        .map(([albumId]) => albumId);

    const albums = sortedAlbums.map(albumId => ({
        albumId,
        playbackCount: albumPlaybackFrequencies[albumId],
        embedding: albumEmbeddingCache[albumId] ?? null,
    }));

    // Assign weightings for each album, decreasing exponentially
    // The most played album gets weight 1, next gets e^-1, next e^-2, etc.
    const albumWeights = albums.map((album, idx) => ({
        ...album,
        weight: Math.exp(-idx),
    }));

    // Ensure all weightings are greater than 1 as we dont want to penalise any albums, only promote most listened
    const minWeight = 1;

    const normalizedAlbums = albumWeights.map(album => ({
        ...album,
        weight: Math.max(album.weight, minWeight),
    }));

    // Create an album affinity avg embedding with weightings
    const validAlbums = normalizedAlbums.filter(album => album.embedding !== null);

    if (validAlbums.length === 0)
        return null;

    // Assume each embedding is the same length (ideally should add a guard here to prevent issues with embedding length mismatch)
    const embeddingLength = validAlbums[0].embedding.length;
    const totalWeight = validAlbums.reduce((sum, album) => sum + album.weight, 0);

    const weightedSum = new Array(embeddingLength).fill(0);

    validAlbums.forEach(album => {
        for (let i = 0; i < embeddingLength; i++) {
            weightedSum[i] += album.embedding[i] * album.weight;
        }
    });

    const avgEmbedding = weightedSum.map(val => val / totalWeight);

    return avgEmbedding;
}

export class Taste {
    private userId: string;

    constructor(userId: string) {
        this.userId = userId;
    }

    private _calculateDynamicWeights(userData: UserTaste): { [key: string]: number } {
        // Seed weights (lower == more important)
        const windowDurations: { [key: string]: number } = {
            "1h": 2,
            "4h": 4,
            "6h": 6,
            "12h": 12,
            "24h": 24,
            "all": 720,
            "hourlyWindow": 1,
            "nextHourlyWindow": 1.25,
        };
        
        // --- Step 1: Aggregate Listening Durations ---
        const now = Date.now();
        const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
        const oneMonthAgo = now - (30 * 24 * 60 * 60 * 1000);
        
        let recentDurationSeconds = 0;
        let longTermDurationSeconds = 0;
    
        const sMeta = new SongDataCache();
    
        const processedHistory = userData.history.map(v => {
            const songData = sMeta.getItem(v.songId);
            if (!songData)
                return null;
            return {
                ...v,
                songData,
            };
        }).filter(v => v !== null);
        
        for (const v of processedHistory) {
            if (v.skipped || !v.songData) continue;
            const durationPlayedSeconds = (v.sessionDuration * v.songData.duration / 1e3);
            if (v.timestamp >= oneWeekAgo)
                recentDurationSeconds += durationPlayedSeconds;
            if (v.timestamp >= oneMonthAgo)
                longTermDurationSeconds += durationPlayedSeconds;
        }
        
        const recentHours = recentDurationSeconds / 3600;
        const longTermHours = longTermDurationSeconds / 3600;
        
        // --- Step 2: Smooth the listening hours ---
        const smoothedHours = (recentHours * 0.65) + (longTermHours * 0.35);
        
        // --- Step 3: Map smoothed hours into an activity ratio ---
        const lowListeningHours = 28;   // Less than 28h/month = considered inactive
        const highListeningHours = 160; // 140h/month = considered very active
    
        let activityRatio = (smoothedHours - lowListeningHours) / (highListeningHours - lowListeningHours);
        activityRatio = Math.max(0, Math.min(1, activityRatio)); // Clamp between 0 and 1
        
        // --- Step 4: Compute half-life for time windows ---
        const minHalfLifeHours = 1.5;  // Very active so tiny half-life
        const maxHalfLifeHours = 14;   // Inactive so much longer half-life
        
        const windowHalfLifeHours = maxHalfLifeHours - (maxHalfLifeHours - minHalfLifeHours) * activityRatio;
        
        // --- Step 5: Assign final weights for each window ---
    
        const weights: { [key: string]: number } = {};
    
        for (const key of Object.keys(windowDurations)) {
            const hours = windowDurations[key];
            let baseWeight = Math.exp(-Math.log(2) * hours / windowHalfLifeHours);
    
            // Apply boost/fade rules:
            if (key === "1h") {
                const boost = 1 + (activityRatio * 0.5); // Up to +50% boost for 1h
                baseWeight *= boost;
            }
            if (key === "hourlyWindow") {
                const penalty = 1 - (activityRatio * 0.3); // Up to -30% penalty for hourlyWindow
                baseWeight *= Math.max(penalty, 0.7); // Clamp so hourlyWindow doesn't collapse completely
            }
    
            weights[key] = baseWeight;
        }
        
        return weights;
    }    

    private _getTimeAveragedEmbedding(taste: UserTaste) {
        const embeddings = {
            "1h": createUserEmbedding(taste, songEmbeddings, 1),
            "4h": createUserEmbedding(taste, songEmbeddings, 4),
            "6h": createUserEmbedding(taste, songEmbeddings, 6),
            "12h": createUserEmbedding(taste, songEmbeddings, 12),
            "24h": createUserEmbedding(taste, songEmbeddings, 24),
            "all": createUserEmbedding(taste, songEmbeddings),
            "hourlyWindow": createUserEmbedding(taste, songEmbeddings, undefined, (item) => {
                const d = new Date(item.timestamp);
                const now = new Date();
                const hour = now.getHours();
                return Math.abs(d.getHours() - hour) <= 1;
            }),
            "nextHourlyWindow": createUserEmbedding(taste, songEmbeddings, undefined, (item) => {
                const d = new Date(item.timestamp);
                const now = new Date();
                const nextHour = (now.getHours() + 1) % 24; // Calculate the next hour
                return d.getHours() === nextHour;
            }),
        };
    
        const weights = this._calculateDynamicWeights(taste);
    
        const weightedEmbedding = embeddings["all"].map((_, idx) => {
            let sum = 0;
            let totalWeight = 0;
    
            for (const key of Object.keys(embeddings)) {
                sum += embeddings[key as keyof typeof embeddings][idx] * (weights[key as keyof typeof weights] || 0);
                totalWeight += (weights[key as keyof typeof weights] || 0);
            }
    
            return sum / totalWeight;
        });
    
        // Normalize again after averaging
        const norm = Math.sqrt(weightedEmbedding.reduce((sum, val) => sum + val * val, 0)) || 1;

        const historyEmbedding = weightedEmbedding.map(val => val / norm);
        const albumEmbedding = albumPlaybackAffinityEmbedding(taste);

        if (!albumEmbedding)
            return historyEmbedding;

        // Combine historyEmbedding and albumEmbedding
        // Weighted average: 60% history, 40% album
        const combined = historyEmbedding.map((val, idx) =>
            0.6 * val + 0.4 * albumEmbedding[idx]
        );

        // Normalize the combined embedding
        const combinedNorm = Math.sqrt(combined.reduce((sum, v) => sum + v * v, 0)) || 1;
        
        return combined.map(v => v / combinedNorm);
    }

    async getUserEmbedding(tasteOverride?: UserTaste) {
        let taste: UserTaste;

        // Check cache first
        const cachedData = tasteOverride ?? this._getCachedUserTaste(this.userId);
        const currentTime = Date.now();

        if (cachedData) {
            taste = cachedData;
        } else {
            taste = loadUserTasteFromFile(this.userId);
        }

        // Load song embeddings if not already loaded or expired
        loadSongEmbeddingsFromFile();

        let inPeriod: {
            songId: string;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
            timestamp: number;
        }[] = [];

        inPeriod = taste.history;

        const inPeriodIds = inPeriod.map(v => v.songId);

        // Remove songs from taste song data outside the given time period
        const songDataKeys = Object.keys(taste.songData);
        const invalidSongDataKeys = songDataKeys.filter(v => !inPeriodIds.includes(v));

        for (const invalidId of invalidSongDataKeys) {
            delete taste.songData[invalidId];
        }

        return this._getTimeAveragedEmbedding(taste);
    }

    private _getCachedUserTaste(userId: string): UserTaste | null {
        const cachedData = tasteCache[userId];
        const currentTime = Date.now();

        if (cachedData && (currentTime - cachedData.timestamp) < CACHE_EXPIRY_TIME) {
            return cachedData.data;
        }

        return null;
    }

    getSongAffinity(songId: string, tasteOverride?: UserTaste, periodStart?: number, periodEnd?: number): number {
        let taste: UserTaste;

        // Check cache first
        const cachedData = tasteOverride ?? this._getCachedUserTaste(this.userId);

        if (cachedData) {
            taste = cachedData;
        } else {
            taste = loadUserTasteFromFile(this.userId);
        }

        // Default time period of the past month
        const timePeriod = {
            start: periodStart ?? Date.now() - (30 * 24 * 60 * 60 * 1000),
            end: periodEnd ?? Date.now(),
        };

        // Filter affinity history based on the requested time period and songId
        const filteredAffinityHistory = taste.affinityHistory.filter(entry => {
            return (entry.timestamp >= timePeriod.start && entry.timestamp <= timePeriod.end && entry.songId === songId);
        });

        if (filteredAffinityHistory.length === 0)
            return 0;

        // Calculate the total affinity for the songId
        const totalAffinity = filteredAffinityHistory.reduce((sum, entry) => sum + entry.affinity, 0);

        return totalAffinity;
    }

    async generateTasteProfile(data: Partial<{
        includeListenedMusic: boolean;
        timePeriod: {
            start: number;
            end: number;
        }
        includeSongDataOutOfPeriod: boolean;
        taste?: UserTaste;
        // emphasiseSongsWithinCurrentTime: boolean;
    }>) {
        let taste: UserTaste;

        // Check cache first
        const cachedData = data.taste ?? this._getCachedUserTaste(this.userId);
        
        if (cachedData) {
            taste = cachedData;
        } else {
            taste = loadUserTasteFromFile(this.userId, data.timePeriod);
        }

        // Load song embeddings if not already loaded or expired
        loadSongEmbeddingsFromFile();

        // These are songs user has not listened to
        const musicPool = Object.keys(songEmbeddings).filter(songId => data.includeListenedMusic || !Object.keys(taste.songData).includes(songId));

        let inPeriod: {
            songId: string;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
            timestamp: number;
        }[] = [];

        // Songs user has listened to within given time period
        if (data.timePeriod) {
            inPeriod = taste.history.filter(v => v.timestamp >= (data.timePeriod?.start ?? -1) && v.timestamp <= (data.timePeriod?.end ?? -1));
        } else {
            inPeriod = taste.history;
        }

        const inPeriodIds = inPeriod.map(v => v.songId);

        // Remove songs from taste song data outside the given time period
        if (!data.includeSongDataOutOfPeriod) {
            const songDataKeys = Object.keys(taste.songData);
            const invalidSongDataKeys = songDataKeys.filter(v => !inPeriodIds.includes(v));

            for (const invalidId of invalidSongDataKeys) {
                delete taste.songData[invalidId];
            }
        }

        const userEmbedding = this._getTimeAveragedEmbedding(taste);

        // Filter out songs which the user has got a majority negative affinity with
        const filteredMusicPool = musicPool.filter(songId => {
            // Filter out any songs which have a negative affinity in the past 24hr
            const songAffinityDay = this.getSongAffinity(songId, taste, Date.now() - (24 * 60 * 60 * 1000), Date.now());
            
            if (songAffinityDay < 0)
                return false;

            // Filter out any songs which have a high negative affinity in the past 7 days
            const songAffinityWeek = this.getSongAffinity(songId, taste, Date.now() - (7 * 24 * 60 * 60 * 1000), Date.now());

            if (songAffinityWeek < -3)
                return false;

            // Filter out any songs which have a very high negative affinity in the past 30 days
            const songAffinityMonth = this.getSongAffinity(songId, taste, Date.now() - (30 * 24 * 60 * 60 * 1000), Date.now());

            if (songAffinityMonth < -12)
                return false;

            return true;
        });

        const similarities = filteredMusicPool.map(songId => {
            if (!songEmbeddings[songId])
                return { songId, similarity: -1 };

            const similarity = combinedSimilarity(userEmbedding, songEmbeddings[songId]);
        
            return { songId, similarity };
        }).filter(v => v.similarity !== -1);

        similarities.sort((a, b) => b.similarity - a.similarity);

        return similarities;
    }
}