import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { reconcileSyncPair, SyncLatch, SYNC_DIVERGENCE_GRACE_MS } from "./listening-sync";

const NOW = 1_700_000_000_000;
const SONG = "spotify:track:a";
const OTHER = "spotify:track:b";

/** A pair in sync on SONG, last seen together `agoMs` ago. */
function latched(overrides: Partial<SyncLatch> = {}): SyncLatch {
    return { songId: SONG, matchedAt: NOW - 30e3, ...overrides };
}

describe("reconcileSyncPair — coming into sync", () => {
    it("notifies a pair seen together for the first time", () => {
        const result = reconcileSyncPair(undefined, SONG, NOW);

        assert.equal(result.outcome, "matched");
        assert.equal(result.notify, true);
        assert.equal(result.inSync, true);
        assert.deepEqual(result.latch, { songId: SONG, matchedAt: NOW });
    });

    it("does not notify a pair that is already in sync", () => {
        const result = reconcileSyncPair(latched(), SONG, NOW);

        assert.equal(result.outcome, "together");
        assert.equal(result.notify, false);
        assert.equal(result.inSync, true);
    });

    it("does not notify when the pair move to a new song together", () => {
        // The whole point: a Jam walks a group through a playlist, and that is
        // one stretch of listening together, not one per track
        const result = reconcileSyncPair(latched(), OTHER, NOW);

        assert.equal(result.outcome, "together");
        assert.equal(result.notify, false);
        assert.equal(result.latch?.songId, OTHER);
    });

    it("notifies again once a dead latch is past the grace", () => {
        // Nothing is guaranteed to evaluate a pair after they part — both may
        // have stopped — so an expired latch can still be sitting there when
        // they next line up, and it must not swallow the notification
        const result = reconcileSyncPair(
            latched({ divergedSince: NOW - SYNC_DIVERGENCE_GRACE_MS - 1 }),
            SONG,
            NOW,
        );

        assert.equal(result.outcome, "matched");
        assert.equal(result.notify, true);
    });

    it("does not re-announce a pair whose gap was the whole grace", () => {
        // The worst case the window is sized for — the slowest poll a friend
        // can be on — and it must still land inside it
        const result = reconcileSyncPair(
            latched({ divergedSince: NOW - SYNC_DIVERGENCE_GRACE_MS }),
            SONG,
            NOW,
        );

        assert.equal(result.outcome, "together");
        assert.equal(result.notify, false);
    });

    it("clears the divergence clock when the pair are seen together again", () => {
        const result = reconcileSyncPair(latched({ divergedSince: NOW - 10e3 }), SONG, NOW);

        assert.equal(result.outcome, "together");
        assert.equal(result.latch?.divergedSince, undefined);
        assert.equal(result.latch?.matchedAt, NOW);
    });
});

describe("reconcileSyncPair — holding a sync through a gap", () => {
    it("keeps the sync on the first sighting apart", () => {
        const result = reconcileSyncPair(latched(), undefined, NOW);

        assert.equal(result.outcome, "waiting");
        assert.equal(result.inSync, true);
        assert.equal(result.notify, false);
        assert.equal(result.latch?.divergedSince, NOW);
        assert.equal(result.graceRemainingMs, SYNC_DIVERGENCE_GRACE_MS);
    });

    it("does not restart the clock on a later sighting apart", () => {
        // Otherwise a pair polled often enough while apart would never time out
        const divergedSince = NOW - 60e3;

        const result = reconcileSyncPair(latched({ divergedSince }), undefined, NOW);

        assert.equal(result.outcome, "waiting");
        assert.equal(result.latch?.divergedSince, divergedSince);
        assert.equal(result.graceRemainingMs, SYNC_DIVERGENCE_GRACE_MS - 60e3);
    });

    it("still holds a pair apart for exactly the grace", () => {
        const result = reconcileSyncPair(
            latched({ divergedSince: NOW - SYNC_DIVERGENCE_GRACE_MS }),
            undefined,
            NOW,
        );

        assert.equal(result.outcome, "waiting");
        assert.equal(result.inSync, true);
        assert.equal(result.graceRemainingMs, 0);
    });

    it("ends the sync one tick past the grace", () => {
        const result = reconcileSyncPair(
            latched({ divergedSince: NOW - SYNC_DIVERGENCE_GRACE_MS - 1 }),
            undefined,
            NOW,
        );

        assert.equal(result.outcome, "ended");
        assert.equal(result.inSync, false);
        assert.equal(result.latch, undefined);
    });

    it("ends the sync when the pair have been apart far longer", () => {
        const result = reconcileSyncPair(
            latched({ divergedSince: NOW - (10 * SYNC_DIVERGENCE_GRACE_MS) }),
            undefined,
            NOW,
        );

        assert.equal(result.outcome, "ended");
        assert.equal(result.latch, undefined);
    });

    it("leaves a pair that was never in sync alone", () => {
        const result = reconcileSyncPair(undefined, undefined, NOW);

        assert.equal(result.outcome, "apart");
        assert.equal(result.inSync, false);
        assert.equal(result.notify, false);
        assert.equal(result.latch, undefined);
    });

    it("honours a grace passed in by the caller", () => {
        const result = reconcileSyncPair(latched({ divergedSince: NOW - 5e3 }), undefined, NOW, 1e3);

        assert.equal(result.outcome, "ended");
    });
});

/**
 * The reported bug, played out as the sequence of evaluations it produced.
 *
 * Each side of a pair is polled on its own schedule, so a track change inside a
 * Jam is seen by one of them first. Driving the latch through those readings in
 * order is the only way to show that the second reading no longer notifies.
 */
describe("reconcileSyncPair — two friends in a Spotify Jam", () => {
    /** Reads a pair repeatedly, returning how many times they were notified. */
    function play(readings: {songId?: string, atMs: number}[]) {
        let latch: SyncLatch | undefined;
        let notifications = 0;

        for (const reading of readings) {
            const result = reconcileSyncPair(latch, reading.songId, NOW + reading.atMs);

            latch = result.latch;

            if (result.notify)
                notifications++;
        }

        return { notifications, latch };
    }

    it("announces the Jam once across a run of tracks", () => {
        // A's poll finds them together, then each track change is seen by one
        // side before the other — the reading in between is the pair looking
        // apart purely because only one of them has been asked recently
        const { notifications } = play([
            { songId: SONG, atMs: 0 },
            { songId: undefined, atMs: 20e3 },
            { songId: OTHER, atMs: 35e3 },
            { songId: undefined, atMs: 190e3 },
            { songId: SONG, atMs: 200e3 },
            { songId: SONG, atMs: 260e3 },
        ]);

        assert.equal(notifications, 1);
    });

    it("announces a pair afresh when they genuinely part and meet again later", () => {
        const { notifications } = play([
            { songId: SONG, atMs: 0 },
            { songId: undefined, atMs: 60e3 },
            { songId: undefined, atMs: 60e3 + SYNC_DIVERGENCE_GRACE_MS + 1 },
            { songId: SONG, atMs: 600e3 },
        ]);

        assert.equal(notifications, 2);
    });

    it("survives a pause shorter than the grace without re-announcing", () => {
        const { notifications } = play([
            { songId: SONG, atMs: 0 },
            // Paused: unmatchable on one side
            { songId: undefined, atMs: 10e3 },
            // Resumed onto the song the friend never left
            { songId: SONG, atMs: 45e3 },
        ]);

        assert.equal(notifications, 1);
    });
});
