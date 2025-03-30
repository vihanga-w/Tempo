import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { EmbeddingOutput } from "./autoencoder";
import { combinedSimilarity } from "./similarity";
import { randomBytes } from "crypto";
import { join } from "path";

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
    hourlyListenershipAggregate: [
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
    ];
}

function loadUserTasteFromFile(userId: string, timePeriod?: { start: number; end: number }): UserTaste {
    const filePath = `./data/tastes/${userId}.json`;
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

    return data;
}

function createUserEmbedding(userData: UserTaste, songEmbeddings: { [key: string]: number[] }, backdateHours?: number) {
    const weights: { [key: string]: number } = {
        rating: 1.75,
        skipCount: -0.25,
        playbackCount: 0.5,
        replayCount: 2,
        sessionDuration: 5,
        skipped: -0.2,
    };

    console.log(userData.history)

    const dataWeightSum: { [key: string]: number } = {};

    // Filter history to only include entries from the past backdateHours hours
    const timePeriodStart = Date.now() - ((backdateHours ?? 0) * 60 * 60 * 1000);
    const recentHistory = userData.history.filter(entry => {
        console.log(entry.timestamp, timePeriodStart, entry.timestamp >= timePeriodStart)
        return entry.timestamp >= timePeriodStart;
    });

    // Calculate weighted average sum for individual song data
    Object.entries(userData.songData).forEach(([songId, songData]) => {
        if (recentHistory.some(v => v.songId == songId))
            return;
        
        Object.entries(songData).forEach(([key, value]) => {
            let weight = weights[key];

            // If song has a -ve rating, increase -ve weighting
            if (key == "rating" && value < 0)
                weight *= (1 + (Math.log1p(-value) * 2.5));

            if (key in weights) {
                // Ensure that the value is not negative
                dataWeightSum[songId] = (dataWeightSum[songId] || 0) + (value * weight);
            }
        });
    });

    console.log(recentHistory)

    // Calculate weighted average sum for history
    recentHistory.forEach(songData => {
        console.log("SongId:", songData.songId)
        Object.entries(songData).forEach(([key, value]) => {
            if (key == "songId")
                return;

            const data = value as number;

            let weight = weights[key];

            // If song was skipped but user listened to a lot of it, reduce weighting of skip
            if (key == "skipped" && songData.skipped)
                weight *= Math.max(0.2, 1 - songData.sessionDuration);            

            if (key in weights) {
                dataWeightSum[songData.songId] = (dataWeightSum[songData.songId] || 0) + (data * weight);
            }
        });
    });

    let weightedEmbeddingsSum: number[] = [];

    const songIdsRaw = Object.keys(userData.songData);

    const songIds = songIdsRaw.filter(songId => songId in songEmbeddings);

    if (songIds.length === 0) return Array(songEmbeddings[Object.keys(songEmbeddings)[0]].length).fill(-1);

    const unknownSongIds = songIdsRaw.filter(songId => !(songId in songEmbeddings));

    if (unknownSongIds.length > 0) {
        writeFileSync(`${randomBytes(6).toString("hex")}_unknown_songs.json`, JSON.stringify(unknownSongIds));
    }

    for (const songId of songIds) {
        const embedding = songEmbeddings[songId];

        const dataWeight = dataWeightSum[songId] ?? 0;
        // const weightedEmbedding = embedding.map(val => {
        //     const stage = val * dataWeight;

        //     return (stage < 0 ? 0 : stage);
        // });
        const weightedEmbedding = embedding.map(val => val * Math.max(0.1, dataWeight));
        
        if (weightedEmbeddingsSum.length === 0) {
            weightedEmbeddingsSum = weightedEmbedding;
        } else {
            weightedEmbeddingsSum = weightedEmbeddingsSum.map((val, idx) => val + weightedEmbedding[idx]);
        }
    }

    const divisor = Math.max(1, weightedEmbeddingsSum.length || songIds.length || recentHistory.length);

    const avgWeightedEmbedding = weightedEmbeddingsSum.map(val => val / divisor);

    return avgWeightedEmbedding;
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
        console.warn("No embeddingas index was found, unable to load song embeddings");

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

export class Taste {
    private userId: string;

    constructor(userId: string) {
        this.userId = userId;
    }

    async getUserEmbedding() {
        let taste: UserTaste;

        // Check cache first
        const cachedData = tasteCache[this.userId];
        const currentTime = Date.now();

        if (cachedData && (currentTime - cachedData.timestamp) < CACHE_EXPIRY_TIME) {
            taste = cachedData.data;
        } else {
            taste = loadUserTasteFromFile(this.userId);
            // Store in cache with timestamp
            tasteCache[this.userId] = {
                data: taste,
                timestamp: currentTime
            };
        }

        // Load song embeddings if not already loaded or expired
        loadSongEmbeddingsFromFile();

        // These are songs user has not listened to
        const musicPool = Object.keys(songEmbeddings).filter(songId => !(songId in taste.songData));

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

        const userEmbedding1h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 1);

        const userEmbedding4h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 4);

        const userEmbedding6h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 6);

        const userEmbedding12h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 12);

        const userEmbedding24h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 24);

        const userEmbeddingAllTime = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings);

        // Average the embeddings with 4h with highest weight
        const userEmbedding = userEmbeddingAllTime.map((val, idx) => {
            return (
                (val + userEmbedding1h[idx] * 10 + userEmbedding4h[idx] * 5 + userEmbedding6h[idx] * 3 + userEmbedding12h[idx] * 1 + userEmbedding24h[idx] * 0.2) / 19.2
            );
        });

        return userEmbedding;
    }

    async generateTasteProfile(data: Partial<{
        includeListenedMusic: boolean;
        timePeriod: {
            start: number;
            end: number;
        }
        includeSongDataOutOfPeriod: boolean;
        // emphasiseSongsWithinCurrentTime: boolean;
    }>) {
        let taste: UserTaste;

        // Check cache first
        const cachedData = tasteCache[this.userId];
        const currentTime = Date.now();

        if (cachedData && (currentTime - cachedData.timestamp) < CACHE_EXPIRY_TIME) {
            taste = cachedData.data;
        } else {
            taste = loadUserTasteFromFile(this.userId, data.timePeriod);
            // Store in cache with timestamp
            tasteCache[this.userId] = {
                data: taste,
                timestamp: currentTime
            };
        }

        // Load song embeddings if not already loaded or expired
        loadSongEmbeddingsFromFile();

        // These are songs user has not listened to
        const musicPool = Object.keys(songEmbeddings).filter(songId => data.includeListenedMusic || !(songId in taste.songData));

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

        const userEmbedding1h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 1);

        const userEmbedding4h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 4);

        const userEmbedding6h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 6);

        const userEmbedding12h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 12);

        const userEmbedding24h = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings, 24);

        const userEmbeddingAllTime = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings);

        // Average the embeddings with 4h with highest weight
        const userEmbedding = userEmbeddingAllTime.map((val, idx) => {
            return (
                (val + userEmbedding1h[idx] * 10 + userEmbedding4h[idx] * 5 + userEmbedding6h[idx] * 3 + userEmbedding12h[idx] * 1 + userEmbedding24h[idx] * 0.2) / 19.2
            );
        });

        const similarities = musicPool.map(songId => {
            if (!songEmbeddings[songId])
                return { songId, similarity: -1 };

            const similarity = combinedSimilarity(userEmbedding, songEmbeddings[songId]);
        
            return { songId, similarity };
        });

        similarities.sort((a, b) => b.similarity - a.similarity);

        return similarities;
    }
}