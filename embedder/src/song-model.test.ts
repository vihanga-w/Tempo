import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SongModel, similarity, loadSongModel } from "./song-model";
import {
    GENRE_VOCABULARY, dimensionNames, songVector, SongFeatures,
    parseDeezerTrack, parseDeezerAlbum, parseDeezerArtist,
} from "./song-features";

/**
 * The tower, with weights small enough to work out by hand.
 *
 * Hidden unit 0 reads "genre:present" and hidden unit 1 reads "duration_log";
 * the output is the hidden layer unchanged. So a song with a genre and a
 * length comes out as [1, duration_log], normalised — which is checkable
 * without trusting any of the code under test.
 */

const DIMS = dimensionNames();

function bundle(over: Record<string, unknown> = {}) {
    const W1 = DIMS.map(() => [0, 0]);

    W1[DIMS.indexOf("genre:present")][0] = 1;
    W1[DIMS.indexOf("duration_log")][1] = 1;

    return {
        version: "test-1",
        vocabulary: [...GENRE_VOCABULARY],
        nowYear: 2026,
        rankTable: [100, 1000, 10000],
        maxFans: 1000,
        dims: DIMS,
        tower: { W1, b1: [0, 0], W2: [[1, 0], [0, 1]], b2: [0, 0] },
        ...over,
    };
}

function features(over: Partial<SongFeatures["track"]> = {}): SongFeatures {
    return {
        track: {
            id: 1, isrc: null, duration: 245, rank: 1000, release_date: "2026-09-04",
            explicit_lyrics: false, explicit_content_lyrics: 0, gain: -8, bpm: 0,
            contributor_count: 1, album_id: 2, artist_id: 3, ...over,
        },
        album: { id: 2, genres: ["Pop"], release_date: "2026-09-04" },
        artist: { id: 3, nb_fan: 500 },
    };
}

describe("SongModel", () => {
    it("runs the tower: relu(x W1 + b1) W2 + b2, normalised", () => {
        const model = SongModel.fromBundle(bundle());
        const durationLog = Math.log1p(245) / Math.log1p(600);
        const norm = Math.sqrt(1 + durationLog * durationLog) + 1e-8;

        const [a, b] = model.embed(features());

        assert.ok(Math.abs(a - 1 / norm) < 1e-12);
        assert.ok(Math.abs(b - durationLog / norm) < 1e-12);
    });

    it("builds the vector against the bundle's own corpus, not some other", () => {
        const model = SongModel.fromBundle(bundle());
        const rankPct = songVector(features({ rank: 1000 }), model.context)[DIMS.indexOf("rank_pct")];

        // 1000 is the second of three ranks in the bundle's table
        assert.ok(Math.abs(rankPct - 1 / 3) < 1e-12);
    });

    it("gives unit-length embeddings, so a song agrees with itself completely", () => {
        const model = SongModel.fromBundle(bundle());
        const e = model.embed(features());

        // Not exactly 1: the norm carries the research's +1e-8, which shortens every embedding by about that much
        assert.ok(Math.abs(similarity(e, e) - 1) < 1e-7);
    });

    it("refuses a bundle trained on other dimensions", () => {
        assert.throws(() => SongModel.fromBundle(bundle({ dims: [...DIMS].reverse() })), /dimensions/);
        assert.throws(() => SongModel.fromBundle(bundle({ vocabulary: GENRE_VOCABULARY.slice(1) })), /dimensions/);
    });

    it("refuses a tower of the wrong shape", () => {
        const W1 = DIMS.slice(1).map(() => [0, 0]);

        assert.throws(() => SongModel.fromBundle(bundle({ tower: { W1, b1: [0, 0], W2: [[1, 0], [0, 1]], b2: [0, 0] } })), /tower/);
    });

    it("refuses a rank table out of order, which would misplace every percentile", () => {
        assert.throws(() => SongModel.fromBundle(bundle({ rankTable: [1000, 100] })), /rank table/);
    });

    it("loads nothing, rather than throwing, when there is no bundle", () => {
        assert.equal(loadSongModel("/nonexistent/song-vector.json"), null);
    });
});

/**
 * The shipped model against the code that trained it.
 *
 * train_bundle.py writes songs into the bundle with the vector and embedding it
 * computed for each. What the server builds for the same songs has to agree, or
 * Discover would be ranking with a model other than the one that was measured.
 */
const SHIPPED = join(__dirname, "..", "models", "song-vector-1.json");

describe("the shipped song model", { skip: !existsSync(SHIPPED) && "no bundle committed yet" }, () => {
    it("loads", () => {
        assert.ok(loadSongModel(SHIPPED));
    });

    it("agrees with train_bundle.py on every parity sample", () => {
        const bundle = JSON.parse(readFileSync(SHIPPED, "utf8"));
        const model = SongModel.fromBundle(bundle);

        assert.ok(bundle.parity.length > 0);

        for (const sample of bundle.parity) {
            const features: SongFeatures = {
                track: parseDeezerTrack(sample.track)!,
                album: sample.album ? parseDeezerAlbum(sample.album) : null,
                artist: sample.artist ? parseDeezerArtist(sample.artist) : null,
            };

            // Python computed both in float32, so agreement is to about 1e-7, not exact
            songVector(features, model.context).forEach((value, i) =>
                assert.ok(Math.abs(value - sample.vector[i]) < 1e-6, `${sample.track.id} ${bundle.dims[i]}: ${value} against ${sample.vector[i]}`));

            model.embed(features).forEach((value, i) =>
                assert.ok(Math.abs(value - sample.embedding[i]) < 1e-5, `${sample.track.id} embedding[${i}]: ${value} against ${sample.embedding[i]}`));
        }
    });
});
