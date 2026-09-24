import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    settle, scheduleAfter, isDue, SongFeatureRecord, LookupOutcome, FEATURE_STRATEGY,
    RETRY_AFTER_MS, RETRY_SLOW_MS, REFRESH_COMPLETE_MS, RETRY_WEEKLY_ATTEMPTS,
    isValidSongId,
} from "./song-feature-store";
import type { DeezerTrackFields, DeezerAlbumFields, DeezerArtistFields } from "./song-features";

const T0 = Date.UTC(2026, 8, 11, 12);
const KEY = { songId: "spotify1", isrc: "GBAAA2600001" };

function track(over: Partial<DeezerTrackFields> = {}): DeezerTrackFields {
    return {
        id: 1001, isrc: KEY.isrc, duration: 245, rank: 600000, release_date: "2026-09-04",
        explicit_lyrics: false, explicit_content_lyrics: 0, gain: -8.2, bpm: 0,
        contributor_count: 1, album_id: 501, artist_id: 301, ...over,
    };
}

const album = (over: Partial<DeezerAlbumFields> = {}): DeezerAlbumFields =>
    ({ id: 501, genres: ["Pop"], release_date: "2026-09-04", ...over });

const artist = (over: Partial<DeezerArtistFields> = {}): DeezerArtistFields =>
    ({ id: 301, nb_fan: 12000, ...over });

const found = <T>(value: T) => ({ kind: "found" as const, value });
const missing = { kind: "missing" as const };
const failed = { kind: "failed" as const };

function complete(): LookupOutcome {
    return { track: found(track()), album: found(album()), artist: found(artist()) };
}

describe("scheduleAfter", () => {
    it("leaves a complete song for three months", () => {
        assert.equal(scheduleAfter(T0, [], 0), T0 + REFRESH_COMPLETE_MS);
    });

    it("comes back in a week while something is missing", () => {
        for (let attempts = 1; attempts <= RETRY_WEEKLY_ATTEMPTS; attempts++)
            assert.equal(scheduleAfter(T0, ["genre"], attempts), T0 + RETRY_AFTER_MS);
    });

    it("slows to monthly after two months of weekly retries, but never stops", () => {
        assert.equal(scheduleAfter(T0, ["track"], RETRY_WEEKLY_ATTEMPTS + 1), T0 + RETRY_SLOW_MS);
        assert.equal(scheduleAfter(T0, ["track"], 50), T0 + RETRY_SLOW_MS);
    });
});

describe("isDue", () => {
    it("is due when never looked up", () => {
        assert.equal(isDue(null, T0), true);
    });

    it("waits until its next attempt", () => {
        const record = settle(null, { track: missing }, KEY, T0)!;

        assert.equal(isDue(record, T0 + RETRY_AFTER_MS - 1), false);
        assert.equal(isDue(record, T0 + RETRY_AFTER_MS), true);
    });

    it("is due at once when an older fetcher wrote it", () => {
        const record = { ...settle(null, complete(), KEY, T0)!, strategy: FEATURE_STRATEGY - 1 };

        assert.equal(isDue(record, T0 + 1), true);
    });
});

describe("settle", () => {
    it("writes nothing down when any part of the lookup got no answer", () => {
        // A timeout says nothing about the song, and must not park it for a week.
        assert.equal(settle(null, { track: failed }, KEY, T0), null);
        assert.equal(settle(null, { track: found(track()), album: failed }, KEY, T0), null);
        assert.equal(settle(null, { track: found(track()), album: found(album()), artist: failed }, KEY, T0), null);
    });

    it("records a song Deezer does not have yet, and asks again in a week", () => {
        const record = settle(null, { track: missing }, KEY, T0)!;

        assert.equal(record.features, null);
        assert.deepEqual(record.gaps, ["track"]);
        assert.equal(record.attempts, 1);
        assert.equal(record.nextAttemptAt, T0 + RETRY_AFTER_MS);
    });

    it("records a complete song and resets the retries", () => {
        const before = { ...settle(null, { track: missing }, KEY, T0)!, attempts: 5 };
        const record = settle(before, complete(), KEY, T0 + RETRY_AFTER_MS)!;

        assert.deepEqual(record.gaps, []);
        assert.equal(record.attempts, 0);
        assert.equal(record.nextAttemptAt, T0 + RETRY_AFTER_MS + REFRESH_COMPLETE_MS);
    });

    it("counts consecutive gappy lookups, which is what slows the retries", () => {
        const thin: LookupOutcome = { track: found(track()), album: found(album({ genres: [] })), artist: found(artist()) };

        let record = settle(null, thin, KEY, T0)!;

        for (let i = 0; i < RETRY_WEEKLY_ATTEMPTS; i++)
            record = settle(record, thin, KEY, record.nextAttemptAt)!;

        assert.deepEqual(record.gaps, ["genre"]);
        assert.equal(record.attempts, RETRY_WEEKLY_ATTEMPTS + 1);
        assert.equal(record.nextAttemptAt - record.updatedAt, RETRY_SLOW_MS);
    });

    it("keeps what it knew when a retry comes back emptier", () => {
        const before = settle(null, complete(), KEY, T0)!;

        // The album and artist lookups found nothing this time
        const record = settle(before, { track: found(track()), album: missing, artist: missing }, KEY, T0 + 1)!;

        assert.deepEqual(record.features!.album, album());
        assert.deepEqual(record.features!.artist, artist());
        assert.deepEqual(record.gaps, []);
    });

    it("keeps the song when Deezer stops having the track", () => {
        const before = settle(null, complete(), KEY, T0)!;
        const record = settle(before, { track: missing }, KEY, T0 + 1)!;

        assert.deepEqual(record.features, before.features);
    });

    it("does not keep an old album once the track says it is on another", () => {
        const before = settle(null, complete(), KEY, T0)!;
        const moved: LookupOutcome = { track: found(track({ album_id: 999 })), album: missing, artist: found(artist()) };

        const record = settle(before, moved, KEY, T0 + 1)!;

        assert.equal(record.features!.album, null);
        assert.ok(record.gaps.includes("genre"));
    });
});

describe("settle, with a refused match", () => {
    const REFUSED = { deezerTrackId: 1526717692, deezerDurationMs: 166000, spotifyDurationMs: 245000 };

    it("records why the song has no description, and keeps retrying", () => {
        const record = settle(null, { track: missing, rejected: REFUSED }, { ...KEY, durationMs: 245000 }, T0)!;

        assert.equal(record.features, null);
        assert.deepEqual(record.gaps, ["track"]);
        assert.deepEqual(record.rejected, REFUSED);
        assert.equal(record.nextAttemptAt, T0 + RETRY_AFTER_MS);
    });

    it("keeps Spotify's length for retries, and clears the refusal once a match is accepted", () => {
        const refused = settle(null, { track: missing, rejected: REFUSED }, { ...KEY, durationMs: 245000 }, T0)!;

        // A retry from the sweep has no song in hand, so no length of its own
        const accepted = settle(refused, complete(), KEY, T0 + RETRY_AFTER_MS)!;

        assert.equal(accepted.durationMs, 245000);
        assert.equal(accepted.rejected, null);
        assert.deepEqual(accepted.gaps, []);
    });

    it("drops what it knew when a refresh is refused, and goes back to weekly", () => {
        // The ISRC now finds another recording, so the old description is no
        // longer trusted; kept, it would have counted as complete for 90 days.
        const before = settle(null, complete(), { ...KEY, durationMs: 245000 }, T0)!;
        const record = settle(before, { track: missing, rejected: REFUSED }, KEY, T0 + 1)!;

        assert.equal(record.features, null);
        assert.deepEqual(record.gaps, ["track"]);
        assert.equal(record.nextAttemptAt, T0 + 1 + RETRY_AFTER_MS);
    });
});

// The type is exported for readers of the store; this only checks it lines up with settle's output.
const _typed: SongFeatureRecord | null = settle(null, complete(), KEY, T0);
void _typed;

describe("isValidSongId", () => {
    it("accepts a song first heard on Apple Music, so its features are looked up", () => {
        assert.equal(isValidSongId("am:1440833098"), true);
    });

    it("still refuses what would address part of a document", () => {
        assert.equal(isValidSongId("a.b"), false);
        assert.equal(isValidSongId("a/b"), false);
    });
});
