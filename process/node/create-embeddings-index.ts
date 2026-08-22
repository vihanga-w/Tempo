import { readdirSync, readFileSync, writeFileSync } from "fs";
import { Embedding, EmbeddingsIndex } from "../../embedder/src/user-taste";

let index: EmbeddingsIndex = {
    dir: "./embeddings",
    idx: {},
    available: false,
}

const files = readdirSync("./embeddings/").filter(v => v.endsWith("_embedding.json"));

/**
 * Expected dimensionality, taken from the first embedding read rather than
 * hardcoded. The previous literal (480) had drifted from the model's encodingDim
 * (512), which meant a freshly trained model produced embeddings the indexer
 * discarded with nothing but a warning. Deriving it means a genuine mismatch
 * shows up as a mixed corpus rather than an empty index.
 */
let expectedDimensions: number | null = null;
let skipped = 0;

for (const f of files) {
    try {
        const data = JSON.parse(readFileSync("./embeddings/" + f).toString()) as Embedding;

        if (index.idx[data.songId] !== undefined) {
            console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to the index already containing an embedding with song id", data.songId, "(check for clashes)");

            skipped++;
            continue;
        }

        if (expectedDimensions === null) {
            expectedDimensions = data.embedding.length;

            console.log("Embedding dimensionality for this corpus:", expectedDimensions);
        }

        if (data.embedding.length !== expectedDimensions) {
            console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to inconsistent vector dimensions", `(corpus: ${expectedDimensions}, got: ${data.embedding.length})`, "- this file was produced by a different model revision and must be regenerated");

            skipped++;
            continue;
        }

        index.idx[data.songId] = f;
    } catch (ex) {
        console.warn("Failed to process embedding at \"./embeddings/" + f + "\" due to error:", ex);

        skipped++;
    }
}

if (skipped > 0)
    console.warn("Skipped", skipped, "of", files.length, "embedding files - see warnings above");

index.available = true;

writeFileSync("./embeddings-index.json", JSON.stringify(index));

if (Object.keys(index.idx).length == 0)
    console.warn("Index length is 0");

console.log("Created embeddings index at \"./embeddings-index.json\"");