import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { SongFeatureService } from "./song-feature-service";
import { RETRY_AFTER_MS, REFRESH_COMPLETE_MS, TRANSIENT_RETRY_MS, FEATURE_STRATEGY, SongFeatureRecord } from "./song-feature-store";
import type { Lookup, DeezerTrackFields, DeezerAlbumFields, DeezerArtistFields } from "./song-features";

/**
 * The fetcher, with Deezer and the database faked.
 *
 * The behaviour worth pinning is the part that only exists because a new
 * release is thinner than it will be: a song Deezer has not got yet is written
 * down and asked about again a week later, a glitch is not mistaken for that,
 * and a song somebody is playing now does not wait behind the backfill.
 */

const T0 = Date.UTC(2026, 8, 11, 12);

const found = <T>(value: T): Lookup<T> => ({ kind: "found", value });
const missing = { kind: "missing" as const };
const failed = { kind: "failed" as const };

function trackFor(isrc: string, albumId = 501, artistId = 301): DeezerTrackFields {
    return {
        id: 1000, isrc, duration: 200, rank: 500000, release_date: "2026-09-04",
        explicit_lyrics: false, explicit_content_lyrics: 0, gain: -8, bpm: 0,
        contributor_count: 1, album_id: albumId, artist_id: artistId,
    };
}

const ALBUM: DeezerAlbumFields = { id: 501, genres: ["Pop"], release_date: "2026-09-04" };
const ARTIST: DeezerArtistFields = { id: 301, nb_fan: 12000 };

/** 200 seconds by default, the length trackFor gives Deezer's side, so the two agree. */
function song(id: string, isrc?: string, type: "track" | "episode" = "track", durationMs = 200000) {
    return { id, name: id, artists: [], duration: durationMs, explicit: false, album: {} as any, isrc, type, meta: { updatedAt: 0 } } as any;
}

function setup(opts: {
    tracks?: { [isrc: string]: Lookup<DeezerTrackFields> };
    known?: any[];
    records?: SongFeatureRecord[];
} = {}) {
    const clock = { now: T0 };
    const stored = new Map<string, SongFeatureRecord>();
    const asked = { track: [] as string[], album: 0, artist: 0 };
    const tracks = { ...(opts.tracks ?? {}) };

    const deezer = {
        trackByIsrc: async (isrc: string) => {
            asked.track.push(isrc);

            return tracks[isrc] ?? missing;
        },
        album: async () => { asked.album++; return found(ALBUM); },
        artist: async () => { asked.artist++; return found(ARTIST); },
    };

    const store = {
        set: async (id: string, record: SongFeatureRecord) => { stored.set(id, record); return true; },
        all: async () => opts.records ?? [],
    };

    const service = new SongFeatureService(store, deezer, { listSongs: () => opts.known ?? [] }, () => clock.now);

    return { service, stored, asked, clock, tracks };
}

describe("SongFeatureService", () => {
    it("looks up a newly seen song and stores a complete description", async () => {
        const { service, stored } = setup({ tracks: { GBAAA2600001: found(trackFor("GBAAA2600001")) } });

        assert.equal(service.noteSong(song("s1", "GBAAA2600001")), true);
        assert.equal(await service.resolveNext(), true);

        const record = stored.get("s1")!;

        assert.deepEqual(record.gaps, []);
        assert.equal(record.features!.album!.genres[0], "Pop");
        assert.equal(record.nextAttemptAt, T0 + REFRESH_COMPLETE_MS);
    });

    it("asks again a week later about a song Deezer has not got yet, and fills it in then", async () => {
        const { service, stored, clock, tracks } = setup();

        service.noteSong(song("s1", "GBAAA2600001"));
        await service.resolveNext();

        assert.equal(stored.get("s1")!.features, null);
        assert.equal(stored.get("s1")!.nextAttemptAt, T0 + RETRY_AFTER_MS);

        // Not before the week is up
        clock.now = T0 + RETRY_AFTER_MS - 1;
        assert.equal(service.sweep(), 0);
        assert.equal(service.noteSong(song("s1", "GBAAA2600001")), false);

        // A week on, Deezer has it
        tracks.GBAAA2600001 = found(trackFor("GBAAA2600001"));
        clock.now = T0 + RETRY_AFTER_MS;

        assert.equal(service.sweep(), 1);
        await service.resolveNext();

        assert.deepEqual(stored.get("s1")!.gaps, []);
        assert.equal(stored.get("s1")!.attempts, 0);
    });

    it("does not mistake a glitch for a missing song", async () => {
        const { service, stored, clock, tracks } = setup({ tracks: { GBAAA2600001: failed } });

        service.noteSong(song("s1", "GBAAA2600001"));
        await service.resolveNext();

        // Nothing written, so nothing parked for a week
        assert.equal(stored.size, 0);

        clock.now = T0 + TRANSIENT_RETRY_MS - 1;
        assert.equal(service.sweep(), 0);

        tracks.GBAAA2600001 = found(trackFor("GBAAA2600001"));
        clock.now = T0 + TRANSIENT_RETRY_MS;

        assert.equal(service.sweep(), 1);
        await service.resolveNext();

        assert.deepEqual(stored.get("s1")!.gaps, []);
    });

    it("puts a song somebody is playing now ahead of the backfill", async () => {
        const { service, asked } = setup({
            known: [song("old1", "GBAAA0000001"), song("old2", "GBAAA0000002")],
        });

        assert.equal(service.sweep(), 2);

        service.noteSong(song("new", "GBAAA2600009"));
        await service.resolveNext();

        assert.deepEqual(asked.track, ["GBAAA2600009"]);
    });

    it("skips what cannot be matched to Deezer", () => {
        const { service } = setup();

        assert.equal(service.noteSong(song("e1", "GBAAA2600001", "episode")), false);
        assert.equal(service.noteSong(song("s2")), false);
        assert.equal(service.noteSong(song("s3", "not-an-isrc")), false);
        assert.equal(service.noteSong(song("bad/id", "GBAAA2600001")), false);
        assert.equal(service.pendingCount, 0);
    });

    it("backfills every known song that has never been looked up, and only those", async () => {
        const { service } = setup({
            known: [song("s1", "GBAAA0000001"), song("s2", "GBAAA0000002")],
            records: [{
                songId: "s1", isrc: "GBAAA0000001", features: null, gaps: ["track"], attempts: 1,
                // The current fetcher's, or the record is due at once for being out of date
                strategy: FEATURE_STRATEGY, updatedAt: T0, nextAttemptAt: T0 + RETRY_AFTER_MS,
            }],
        });

        await service.load();

        assert.equal(service.sweep(), 1);
        assert.equal(service.pendingCount, 1);
    });

    it("reads a shared album once, not once per track", async () => {
        const { service, asked } = setup({
            tracks: {
                GBAAA2600001: found(trackFor("GBAAA2600001")),
                GBAAA2600002: found(trackFor("GBAAA2600002")),
            },
        });

        service.noteSong(song("s1", "GBAAA2600001"));
        service.noteSong(song("s2", "GBAAA2600002"));

        await service.resolveNext();
        await service.resolveNext();

        assert.equal(asked.album, 1);
        assert.equal(asked.artist, 1);
    });

    it("refuses a match whose length says it is another recording", async () => {
        // A placeholder ISRC: Deezer's track under it is 166 seconds, the song 245
        const { service, stored, asked } = setup({
            tracks: { ZZZZZ9999999: found({ ...trackFor("ZZZZZ9999999"), duration: 166 }) },
        });

        service.noteSong(song("s1", "ZZZZZ9999999", "track", 245000));
        await service.resolveNext();

        const record = stored.get("s1")!;

        assert.equal(record.features, null);
        assert.deepEqual(record.gaps, ["track"]);
        assert.deepEqual(record.rejected, { deezerTrackId: 1000, deezerDurationMs: 166000, spotifyDurationMs: 245000 });

        // Nothing spent describing the wrong recording
        assert.equal(asked.album, 0);
        assert.equal(asked.artist, 0);
    });

    it("checks a retry against the length the song was first seen with", async () => {
        const { service, stored, clock, tracks } = setup();

        service.noteSong(song("s1", "GBAAA2600001", "track", 245000));
        await service.resolveNext();

        // A week on the ISRC finds something, but not this song. The retry comes
        // from the sweep, with no play in hand, so only the stored length can say so.
        tracks.GBAAA2600001 = found({ ...trackFor("GBAAA2600001"), duration: 166 });
        clock.now = T0 + RETRY_AFTER_MS;

        assert.equal(service.sweep(), 1);
        await service.resolveNext();

        assert.equal(stored.get("s1")!.features, null);
        assert.equal(stored.get("s1")!.rejected!.deezerDurationMs, 166000);
    });

    it("does not start a second lookup while one is in flight", async () => {
        const { service } = setup({ tracks: { GBAAA2600001: found(trackFor("GBAAA2600001")) } });

        service.noteSong(song("s1", "GBAAA2600001"));
        service.noteSong(song("s2", "GBAAA2600002"));

        const first = service.resolveNext();

        assert.equal(await service.resolveNext(), false);
        assert.equal(await first, true);
    });
});
