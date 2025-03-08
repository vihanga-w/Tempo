import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { EmbeddingOutput } from "./autoencoder";
import { combinedSimilarity } from "./similarity";
import { randomBytes } from "crypto";
import { DataStore, EmbeddingDocType, TasteDocType } from "./db";

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
    // [songId]: UserSongData
    songData: { [key: string]: UserSongData };
    history: {
        songId: string;
        sessionDuration: number;
        skipped: boolean;
        replayed: boolean;
        timestamp: number;
    }[];
    // Keep the last 4 weeks of data aggregate
    hourlyListenershipAggregate: [
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
        [UserListenership, number],
    ];
}

async function loadUserTasteDB(db: DataStore, userId: string) {
    if (!(await db.exists("tastes", userId))) {
        throw new Error(`User ${userId} does not exist in the tastes database`);
    }

    // await db.db.query("tastes/$userId")
    // .filter("$userId", "==", userId)
    // .get();

    const data = await db.get<TasteDocType>("tastes", userId);
    
    if (!data) {
        throw new Error("No data was available for user " + userId);
    }

    // Ensure loaded history has a valid timestamp
    data.history = data.history.filter(v => v.timestamp);

    return data;
}

function createUserEmbedding(userData: UserTaste, songEmbeddings: {[key: string]: number[]}) {
    const weights: {[key: string]: number} = {
        rating: 1.75,
        skipCount: -0.25,
        playbackCount: 0.5,
        replayCount: 2,
        // Large weight since sessionDuration between 0 and 1
        sessionDuration: 5,
        skipped: -0.2,
    };

    const dataWeightSum: {[key: string]: number} = {};

    // Calculate weighted average sum for individual song data
    Object.entries(userData.songData).forEach(([songId, songData]) => {
        Object.entries(songData).forEach(([key, value]) => {
            let weight = weights[key];

            // If song has a -ve rating, increase -ve weighting
            if (key == "rating" && value < 0)
                weight *= 2.5;

            if (key in weights) {
                // Ensure that the value is not negative
                dataWeightSum[songId] = (dataWeightSum[songId] || 0) + (value * weight);
            }
        });
    });

    // Calculate weighted average sum for history
    Object.entries(userData.history).forEach(([_, songData]) => {
        Object.entries(songData).forEach(([key, value]) => {
            if (key == "songId")
                return;

            const data = value as number;

            let weight = weights[key];

            // If song was skipped but user listened to a lot of it, reduce weighting of skip
            if (key == "skipped" && songData.skipped && songData.sessionDuration > 0.65)
                weight /= 1.75;

            if (key in weights) {
                dataWeightSum[songData.songId] = (dataWeightSum[songData.songId] || 0) + (data * weight);
            }
        });
    });

    let weightedEmbeddingsSum: number[] = [];

    const songIdsRaw = Object.keys(userData.songData);

    const songIds = songIdsRaw.filter(songId => songId in songEmbeddings);
    const unknownSongIds = songIdsRaw.filter(songId => !(songId in songEmbeddings));

    if (unknownSongIds.length > 0) {
        // console.warn(`User has listened to ${unknownSongIds.length} unknown song${unknownSongIds.length > 1 ? "s" : ""}: ${unknownSongIds.join(", ")}`);
        writeFileSync(`${randomBytes(6).toString("hex")}_unknown_songs.json`, JSON.stringify(unknownSongIds));
    }

    for (const songId of songIds) {
        const embedding = songEmbeddings[songId];

        const dataWeight = dataWeightSum[songId];
        const weightedEmbedding = embedding.map(val => {
            const stage = val * dataWeight;

            return (stage < 0 ? 0 : stage);
        });
        
        if (weightedEmbeddingsSum.length === 0) {
            weightedEmbeddingsSum = weightedEmbedding;
        } else {
            weightedEmbeddingsSum = weightedEmbeddingsSum.map((val, idx) => val + weightedEmbedding[idx]);
        }
    }

    const avgWeightedEmbedding = weightedEmbeddingsSum.map(val => val / (songIds.length + userData.history.length));

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

async function loadSongEmbeddings(db: DataStore) {
    const currentTime = Date.now();
    if (Object.keys(songEmbeddings).length === 0 || (currentTime - lastEmbeddingsLoadTime) > EMBEDDINGS_CACHE_EXPIRY_TIME) {
        const res = await db.query("embeddings").take(await db.ref("embeddings").count()).get();
        const values = res.values();

        songEmbeddings = {};
        for (const k of values) {
            const v = k.val() as EmbeddingDocType;
            if (v) {
                songEmbeddings[k.key] = v.embedding;
            }
        }
        lastEmbeddingsLoadTime = currentTime;
    }
}

export class Taste {
    private userId: string;
    private db: DataStore;

    constructor(userId: string, db: DataStore) {
        this.userId = userId;
        this.db = db;
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
            taste = await loadUserTasteDB(this.db, this.userId);
            // Store in cache with timestamp
            tasteCache[this.userId] = {
                data: taste,
                timestamp: currentTime
            };
        }

        // Load song embeddings if not already loaded or expired
        await loadSongEmbeddings(this.db);

        // These are songs user has not listened to
        const musicPool = Object.keys(songEmbeddings).filter(songId => data.includeListenedMusic || !(songId in taste.songData));

        const query = this.db.query("tastes/" + this.userId + "/history");

        // Songs user has listened to within given time period
        if (data.timePeriod) {
            query
            .filter("timestamp", ">=", data.timePeriod.start)
            .filter("timestamp", "<=", data.timePeriod.end);
        } else {
            query.take(await this.db.ref("tastes/" + this.userId + "/history").count());
        }

        const res = await query.get();

        let inPeriod: {
            songId: string;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
            timestamp: number;
        }[] = [];
        
        for (const v of res.values()) {
            const data = v.val() as UserTaste["history"][0];

            if (data)
                inPeriod.push(data);
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

        const userEmbedding = createUserEmbedding({
            ...taste,
            history: taste.history.filter(v => musicPool.includes(v.songId)),
        }, songEmbeddings);

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