import { readdirSync, readFileSync } from "fs";
import { EmbeddingOutput } from "./autoencoder";
import { combinedSimilarity } from "./similarity";

export interface UserSongData {
    rating: number; // Must be a value between -1 and 1
    skipCount: number;
    playbackCount: number;
}

export interface UserTaste {
    // [songId]: UserSongData
    songData: { [key: string]: UserSongData };
    history: {
        songId: string;
        sessionDuration: number;
        skipped: boolean;
    }[];
}

// Testing
const exampleUserTaste: UserTaste = {
    songData: {
        "982b5439-0bd1-445e-9a54-e26d5939009a": {
            rating: 0.5,
            skipCount: 2,
            playbackCount: 10,
        },
        "52ad4fee-1f4e-4f0d-ab24-cc2691517d93": {
            rating: 0.6,
            skipCount: 4,
            playbackCount: 24,
        },
        "02abe60f-e06d-44e1-bbc7-fd1f7f248611": {
            rating: 0.8,
            skipCount: 1,
            playbackCount: 12,
        },
        "d1a604db-5760-48ad-a823-944b90d8a222": {
            rating: -0.2,
            skipCount: 3,
            playbackCount: 8,
        },
        "b9762909-720b-4a6f-9f1a-053cd7ea24cb": {
            rating: 0.85,
            skipCount: 1,
            playbackCount: 32,
        }
    },
    history: [] // Will be populated below.
};

/*
  To generate a believable history, we:
  1. Assume each song has a “base” full duration (in seconds).
  2. For each song, create a number of playbacks equal to its playbackCount.
  3. Mark the first N playbacks as skipped, where N equals skipCount.
  4. For variety, simulate a pause (i.e. two consecutive history entries instead of one)
     on every 3rd non-skipped playback.
*/

const baseDurations: { [songId: string]: number } = {
    "982b5439-0bd1-445e-9a54-e26d5939009a": 240,  // e.g. 4 minutes
    "52ad4fee-1f4e-4f0d-ab24-cc2691517d93": 250,
    "02abe60f-e06d-44e1-bbc7-fd1f7f248611": 230,
    "d1a604db-5760-48ad-a823-944b90d8a222": 220,
    "b9762909-720b-4a6f-9f1a-053cd7ea24cb": 260,
};

Object.entries(exampleUserTaste.songData).forEach(([songId, data]) => {
    const fullDuration = baseDurations[songId];
    // Loop from 1 to playbackCount, treating each iteration as one playback event.
    for (let i = 1; i <= data.playbackCount; i++) {
        // For simplicity, we mark the first "skipCount" playbacks as skipped.
        const skipped = i <= data.skipCount;
        // Let’s simulate that every 3rd non-skipped playback was paused (split into two sessions)
        if (!skipped && i % 3 === 0) {
            // Split the duration arbitrarily (here 60% then 40%).
            const part1 = Math.floor(fullDuration * 0.6);
            const part2 = fullDuration - part1;
            exampleUserTaste.history.push({ songId, sessionDuration: part1, skipped });
            exampleUserTaste.history.push({ songId, sessionDuration: part2, skipped });
        } else {
            exampleUserTaste.history.push({ songId, sessionDuration: fullDuration, skipped });
        }
    }
});







function loadSongEmbeddingsDB() {
    // Load song embeddings from disk
    const data = readdirSync("./embeddings").map(file => {
        const embedding = JSON.parse(readFileSync(`./embeddings/${file}`, "utf8")) as EmbeddingOutput;

        return { songId: file.replace("_embedding.json", ""), embedding: embedding.embedding };
    });

    let songEmbeddings: {[key: string]: number[]} = {};

    data.forEach(({ songId, embedding }) => {
        songEmbeddings[songId] = embedding;
    });

    return songEmbeddings;
}

function createUserEmbedding(userData: UserTaste, songEmbeddings: {[key: string]: number[]}) {
    const weights: {[key: string]: number} = {
        rating: 1,
        skipCount: -1,
        playbackCount: 0.5,
        sessionDuration: 0.1,
        skipped: -0.5,
    };

    const dataWeightSum: {[key: string]: number} = {};

    Object.entries(userData.songData).forEach(([songId, songData]) => {
        Object.entries(songData).forEach(([key, value]) => {
            if (key in weights) {
                dataWeightSum[songId] = (dataWeightSum[songId] || 0) + (value * weights[key]);
            }
        });
    });
    
    let weightedEmbeddingsSum: number[] = [];

    const songIds = Object.keys(userData.songData);

    for (const songId of songIds) {
        const embedding = songEmbeddings[songId];

        const dataWeight = dataWeightSum[songId];
        const weightedEmbedding = embedding.map(val => val * dataWeight);
        
        if (weightedEmbeddingsSum.length === 0) {
            weightedEmbeddingsSum = weightedEmbedding;
        } else {
            weightedEmbeddingsSum = weightedEmbeddingsSum.map((val, idx) => val + weightedEmbedding[idx]);
        }
    }

    const avgWeightedEmbedding = weightedEmbeddingsSum.map(val => val / songIds.length);

    return avgWeightedEmbedding;
}

const songEmbeddings = loadSongEmbeddingsDB();

const u1Embedding = createUserEmbedding(exampleUserTaste, songEmbeddings);

console.log(combinedSimilarity(u1Embedding, songEmbeddings["b3b6b3d5-4c0e-481a-b849-e4afda2d72c7"]));