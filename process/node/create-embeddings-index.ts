import { readdirSync, readFileSync, writeFileSync } from "fs";
import { Embedding, EmbeddingsIndex } from "../../embedder/src/user-taste";

let index: EmbeddingsIndex = {
    dir: "./embeddings",
    idx: {},
    available: false,
}

const files = readdirSync("./embeddings/").filter(v => v.endsWith("_embedding.json"));

for (const f of files) {
    try {
        const data = JSON.parse(readFileSync("./embeddings/" + f).toString()) as Embedding;

        if (Object.keys(index.idx).includes(data.songId)) {
            console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to the index already containing an embedding with song id", data.songId, "(check for clashes)");

            continue;
        }

        if (data.embedding.length !== 480) {
            console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to invalid vector dimensions", `(expected: 480, got: ${data.embedding.length})`);

            continue;
        }

        index.idx[data.songId] = f;
    } catch (ex) {
        console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to error:", ex);
    }
}

index.available = true;

writeFileSync("./embeddings-index.json", JSON.stringify(index));

if (Object.keys(index.idx).length == 0)
    console.warn("Index length is 0");

console.log("Created embeddings index at \"./embeddings-index.json\"");