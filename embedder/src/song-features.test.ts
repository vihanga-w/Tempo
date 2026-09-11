import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    GENRE_VOCABULARY, dimensionNames, contextFromCorpus, songVector, gapsIn,
    parseDeezerTrack, parseDeezerAlbum, parseDeezerArtist, SongFeatures,
    durationsAgree, DURATION_TOLERANCE_MS,
} from "./song-features";
import { PARITY_FIXTURE, PARITY_EXPECTED } from "./song-features.fixture";

/**
 * The port against the reference.
 *
 * songvec.py is what the model was trained on, so the only acceptable answer is
 * its answer. Every expected vector here came out of songvec.py itself (see
 * song-features.fixture.ts); nothing is worked out by hand.
 */

function featuresFor(key: string): SongFeatures {
    const raw = PARITY_FIXTURE.tracks[key];
    const album = PARITY_FIXTURE.albums[String(raw.album.id)];
    const artist = PARITY_FIXTURE.artists[String(raw.artist.id)];

    return {
        track: parseDeezerTrack(raw)!,
        album: album ? parseDeezerAlbum(album) : null,
        artist: artist ? parseDeezerArtist(artist) : null,
    };
}

/** The corpus songvec.py measured: every truthy rank and fan count among the fixtures. */
function fixtureContext() {
    const tracks = Object.keys(PARITY_FIXTURE.tracks).map(k => PARITY_FIXTURE.tracks[k]);
    const artists = Object.keys(PARITY_FIXTURE.artists).map(k => PARITY_FIXTURE.artists[k]);

    return contextFromCorpus({
        ranks: tracks.map(t => t.rank ?? 0),
        fans: artists.map(a => a.nb_fan ?? 0),
    });
}

describe("songVector", () => {
    it("names its dimensions exactly as songvec.py does, in the same order", () => {
        assert.deepEqual(dimensionNames(), PARITY_EXPECTED.dims);
    });

    it("is pinned to the committed genre vocabulary", () => {
        // A vector is only comparable to another built against the same list.
        const committed = JSON.parse(readFileSync(
            join(__dirname, "..", "research", "song-vector", "genre-vocab.json"), "utf8",
        )).genres;

        assert.deepEqual([...GENRE_VOCABULARY], committed);
    });

    for (const key of Object.keys(PARITY_EXPECTED.vectors)) {
        it(`matches songvec.py on "${key}"`, () => {
            const expected = PARITY_EXPECTED.vectors[key];
            const actual = songVector(featuresFor(key), fixtureContext());

            assert.equal(actual.length, expected.length);

            actual.forEach((value, i) => {
                assert.ok(
                    Math.abs(value - expected[i]) < 1e-6,
                    `${PARITY_EXPECTED.dims[i]}: ${value} against songvec.py's ${expected[i]}`,
                );
            });
        });
    }
});

describe("parsing Deezer's answers", () => {
    it("refuses an error body, which Deezer sends with a 200", () => {
        const body = { error: { type: "DataException", message: "no data", code: 800 } };

        assert.equal(parseDeezerTrack(body), null);
        assert.equal(parseDeezerAlbum(body), null);
        assert.equal(parseDeezerArtist(body), null);
    });

    it("keeps a gain of zero as a reading, and an absent one as absent", () => {
        assert.equal(parseDeezerTrack({ id: 1, gain: 0 })!.gain, 0);
        assert.equal(parseDeezerTrack({ id: 1 })!.gain, null);
    });
});

describe("gapsIn", () => {
    it("calls a track Deezer does not have a gap, not an answer", () => {
        assert.deepEqual(gapsIn(null), ["track"]);
    });

    it("finds nothing missing in a fully described song", () => {
        assert.deepEqual(gapsIn(featuresFor("full")), []);
    });

    it("never waits on BPM, which Deezer reports as 0 for almost everything", () => {
        // "full" has a BPM of 0 and is still complete.
        assert.equal(featuresFor("full").track.bpm, 0);
        assert.ok(!gapsIn(featuresFor("full")).includes("bpm" as any));
    });

    it("lists what could still arrive for a thin release", () => {
        // No album read, an artist with no fans counted, no rank, no gain. The
        // track's own date stands in for the album's, so that is not a gap.
        assert.deepEqual(gapsIn(featuresFor("no_album")), ["genre", "fans", "rank", "gain"]);
    });

    it("treats a year on its own as no release date, as the vector does", () => {
        assert.deepEqual(gapsIn(featuresFor("year_only")), ["genre", "release", "fans"]);
    });
});

describe("durationsAgree", () => {
    it("accepts the same master, which differs by a second or so", () => {
        // Deezer counts whole seconds; Spotify counts milliseconds
        assert.equal(durationsAgree(245, 245400), true);
        assert.equal(durationsAgree(245, 244000), true);
    });

    it("draws the line at the tolerance", () => {
        assert.equal(durationsAgree(200, 200000 + DURATION_TOLERANCE_MS), true);
        assert.equal(durationsAgree(200, 200000 + DURATION_TOLERANCE_MS + 1), false);
    });

    it("refuses a placeholder ISRC's match, which is some other song entirely", () => {
        // ZZZZZ9999999 is a real 166-second track on Deezer
        assert.equal(durationsAgree(166, 245000), false);
    });

    it("lets a match stand when either length is unknown", () => {
        assert.equal(durationsAgree(166, 0), true);
        assert.equal(durationsAgree(166, undefined), true);
        assert.equal(durationsAgree(0, 245000), true);
    });
});
