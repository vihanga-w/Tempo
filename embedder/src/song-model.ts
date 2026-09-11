/**
 * The song model: what Discover will compare songs and listeners with.
 *
 * A song's metadata vector (song-features.ts) goes through a small trained
 * tower — 46 in, 48 hidden, 16 out — and comes out as a unit-length embedding,
 * so how well two songs go together is a dot product. The tower was trained on
 * co-listening in ListenBrainz by research/song-vector/train_bundle.py, which
 * writes everything needed here into one bundle: the weights, and the
 * vocabulary and corpus constants the vector has to be built against to mean
 * what the tower learned.
 *
 * A bundle is taken whole or not at all. A tower fed vectors built against
 * some other vocabulary or corpus does not fail; it quietly answers wrongly.
 */

import { readFileSync } from "fs";
import { dimensionNames, songVector, SongFeatures, VectorContext } from "./song-features";

export interface SongModelBundle {
    version: string;
    vocabulary: string[];
    nowYear: number;
    /** Every truthy rank in the training catalogue, ascending. Raw ranks, not their logs. */
    rankTable: number[];
    maxFans: number;
    dims: string[];
    tower: { W1: number[][]; b1: number[]; W2: number[][]; b2: number[] };
}

const isNumbers = (value: unknown, length?: number): value is number[] =>
    Array.isArray(value)
    && (length === undefined || value.length === length)
    && value.every(x => typeof x === "number" && Number.isFinite(x));

const isMatrix = (value: unknown, rows: number, cols: number): value is number[][] =>
    Array.isArray(value) && value.length === rows && value.every(row => isNumbers(row, cols));

export class SongModel {
    private constructor(
        readonly version: string,
        readonly context: VectorContext,
        private W1: number[][],
        private b1: number[],
        private W2: number[][],
        private b2: number[],
    ) {}

    /** Throws, naming what is wrong, when the bundle could not have come from train_bundle.py. */
    static fromBundle(value: unknown): SongModel {
        const bundle = value as SongModelBundle;
        const version = typeof bundle?.version === "string" ? bundle.version : null;

        if (!version)
            throw new Error("song model: the bundle has no version");

        if (!Array.isArray(bundle.vocabulary) || !bundle.vocabulary.every(g => typeof g === "string"))
            throw new Error(`song model ${version}: no genre vocabulary`);

        // The vector is built here from the vocabulary; the tower was trained on
        // the dimensions the bundle lists. They have to be the same, in order.
        const dims = dimensionNames(bundle.vocabulary);

        if (!Array.isArray(bundle.dims) || bundle.dims.length !== dims.length || bundle.dims.some((d, i) => d !== dims[i]))
            throw new Error(`song model ${version}: trained on dimensions this server does not build`);

        const tower = bundle.tower;
        const hidden = Array.isArray(tower?.b1) ? tower.b1.length : 0;
        const out = Array.isArray(tower?.b2) ? tower.b2.length : 0;

        if (!hidden || !out
            || !isNumbers(tower.b1, hidden) || !isNumbers(tower.b2, out)
            || !isMatrix(tower.W1, dims.length, hidden) || !isMatrix(tower.W2, hidden, out))
            throw new Error(`song model ${version}: the tower is not ${dims.length} -> hidden -> out`);

        if (!isNumbers(bundle.rankTable) || bundle.rankTable.some((r, i) => i > 0 && r < bundle.rankTable[i - 1]))
            throw new Error(`song model ${version}: the rank table is missing or out of order`);

        if (typeof bundle.maxFans !== "number" || typeof bundle.nowYear !== "number")
            throw new Error(`song model ${version}: missing its fan or year constant`);

        const context: VectorContext = {
            vocabulary: [...bundle.vocabulary],
            nowYear: bundle.nowYear,
            // Logged here, on the same side as the query, so both go through the same log1p
            rankTable: bundle.rankTable.map(rank => Math.log1p(rank)),
            maxFansLog: bundle.maxFans > 0 ? Math.log1p(bundle.maxFans) : 1.0,
        };

        return new SongModel(version, context, tower.W1, tower.b1, tower.W2, tower.b2);
    }

    /** The unit-length embedding for a song: pairmodel.Tower.forward, for one row. */
    embed(features: SongFeatures): number[] {
        const x = songVector(features, this.context);

        const h = this.b1.map((bias, j) => {
            let sum = bias;

            for (let i = 0; i < x.length; i++)
                sum += x[i] * this.W1[i][j];

            return sum > 0 ? sum : 0;
        });

        const z = this.b2.map((bias, k) => {
            let sum = bias;

            for (let j = 0; j < h.length; j++)
                sum += h[j] * this.W2[j][k];

            return sum;
        });

        // The same 1e-8 as the research, so an all-zero output stays zero rather than dividing by it
        const norm = Math.sqrt(z.reduce((sum, v) => sum + v * v, 0)) + 1e-8;

        return z.map(v => v / norm);
    }
}

/** How well two embeddings agree. Both are unit length, so this is their cosine. */
export function similarity(a: readonly number[], b: readonly number[]): number {
    let sum = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++)
        sum += a[i] * b[i];

    return sum;
}

/** The model at `path`, or null — with the reason logged — when there is none to use. */
export function loadSongModel(path: string): SongModel | null {
    try {
        return SongModel.fromBundle(JSON.parse(readFileSync(path, "utf8")));
    } catch (ex) {
        console.warn("[songmodel] Could not load", path, "-", ex instanceof Error ? ex.message : ex);

        return null;
    }
}
