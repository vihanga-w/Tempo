import { existsSync, readdirSync, readFileSync } from "fs";
import { EmbeddingOutput } from "./autoencoder";
import { combinedSimilarity } from "./similarity";

export interface UserSongData {
    rating: number; // Must be a value between -1 and 1
    skipCount: number;
    playbackCount: number;
    replayCount: number;
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

function loadUserTasteDB(userId: string) {
    if (!existsSync(`./user-tastes/${userId}.json`)) {
        throw new Error(`User ${userId} does not exist in the database`);
    }

    const data = JSON.parse(readFileSync(`./user-tastes/${userId}.json`, "utf8")) as UserTaste;

    return data;
}

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

    if (unknownSongIds.length > 0)
        console.warn(`User has listened to ${unknownSongIds.length} unknown song${unknownSongIds.length > 1 ? "s" : ""}: ${unknownSongIds.join(", ")}`);

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

const songEmbeddings = loadSongEmbeddingsDB();

const userTaste = loadUserTasteDB("yh1q376ly901c0qk03n9kaphh");

const userEmbedding = createUserEmbedding(userTaste, songEmbeddings);

// All tracks not in the user's taste profile
const otherTracks = Object.keys(songEmbeddings).filter(songId => !(songId in userTaste.songData));

const similarities = otherTracks.map(songId => {
    const similarity = combinedSimilarity(userEmbedding, songEmbeddings[songId]);

    return { songId, similarity };
});

similarities.sort((a, b) => b.similarity - a.similarity);

console.log(similarities);