import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { combinedSimilarity } from "./similarity";
import { randomBytes } from "crypto";
import { join } from "path";
import { SongDataCache } from "./song-data-cache";

interface EmbeddingOutput {
    songId: string;
    embedding: number[];
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
        return weightedEmbedding.map(val => val / norm);
    }

    async getUserEmbedding(tasteOverride?: UserTaste) {
        let taste: UserTaste;

        // Check cache first
        const cachedData = tasteCache[this.userId];
        const currentTime = Date.now();

        if (!tasteOverride && cachedData && (currentTime - cachedData.timestamp) < CACHE_EXPIRY_TIME) {
            taste = cachedData.data;
        } else if (tasteOverride) {
            taste = tasteOverride;
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
        const cachedData = tasteCache[this.userId];
        const currentTime = Date.now();

        if (!data.taste && cachedData && (currentTime - cachedData.timestamp) < CACHE_EXPIRY_TIME) {
            taste = cachedData.data;
        } if (data.taste) {
            taste = data.taste;
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

        const similarities = musicPool.map(songId => {
            if (!songEmbeddings[songId])
                return { songId, similarity: -1 };

            const similarity = combinedSimilarity(userEmbedding, songEmbeddings[songId]);
        
            return { songId, similarity };
        }).filter(v => v.similarity !== -1);

        similarities.sort((a, b) => b.similarity - a.similarity);

        return similarities;
    }
}