import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Embedding, EmbeddingsIndex } from "./user-taste";
import { combinedSimilarity } from "./similarity";

let songEmbeddings: {
    [key: string]: number[];
} = {};
let lastEmbeddingsLoadTime = 0;
let embeddingIndex: EmbeddingsIndex = {
    dir: "./",
    idx: {},
    available: false,
};

const EMBEDDINGS_CACHE_EXPIRY_TIME = 24 * 3600 * 1000; // 24 hours in milliseconds

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

loadSongEmbeddingsFromFile()

const target = songEmbeddings["0ZN01wuIdn4iT8VBggkOMm"];

const similarities = Object.keys(songEmbeddings).map(songId => {
    const similarity = combinedSimilarity(target, songEmbeddings[songId]);

    return { songId, similarity };
}).sort((a, b) => b.similarity - a.similarity);

console.log(similarities)