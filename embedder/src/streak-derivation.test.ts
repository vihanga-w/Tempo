import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { deriveStreak, playedTracksFromHistory, PlayedTrack } from "./streak-derivation";
import { STREAK_BREAK_MS } from "./streak-loss";
import { inferPlays, selectGapPlays } from "./listening-backfill";

const T0 = 1_700_000_000_000;
const THREE_MIN = 180e3;

/** A run of back to back tracks starting at `from`. */
function run(from: number, count: number, prefix = "t"): PlayedTrack[] {
    return Array.from({ length: count }, (_, i) => ({
        songId: `${prefix}${i}`,
        startedAt: from + (i * THREE_MIN),
        endedAt: from + ((i + 1) * THREE_MIN),
    }));
}

describe("deriveStreak", () => {
    it("finds nothing in an empty history", () => {
        assert.deepEqual(deriveStreak([], T0), { startedAt: null, durationMs: 0, trackCount: 0 });
    });

    it("finds nothing when the last play was long ago", () => {
        const plays = run(T0 - (60 * 60e3), 3);

        assert.equal(deriveStreak(plays, T0).startedAt, null);
    });

    it("runs from the start of an unbroken sequence", () => {
        const start = T0 - (THREE_MIN * 4);
        const plays = run(start, 4);

        const streak = deriveStreak(plays, T0);

        assert.equal(streak.startedAt, start);
        assert.equal(streak.trackCount, 4);
        assert.equal(streak.durationMs, T0 - start);
    });

    it("stops at a gap longer than the break threshold", () => {
        const older = run(T0 - (60 * 60e3), 3, "old");
        const recent = run(T0 - (THREE_MIN * 2), 2, "new");

        const streak = deriveStreak([...older, ...recent], T0);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.startedAt, recent[0].startedAt);
    });

    it("carries across a gap just under the threshold", () => {
        const first = run(T0 - (60 * 60e3), 2, "a");
        const idle = STREAK_BREAK_MS - 1000;
        const second = run(first[first.length - 1].endedAt + idle, 2, "b");

        const streak = deriveStreak([...first, ...second], second[1].endedAt);

        assert.equal(streak.trackCount, 4);
        assert.equal(streak.startedAt, first[0].startedAt);
    });

    it("breaks on a gap exactly at the threshold", () => {
        const first = run(T0 - (60 * 60e3), 2, "a");
        const second = run(first[first.length - 1].endedAt + STREAK_BREAK_MS, 2, "b");

        const streak = deriveStreak([...first, ...second], second[1].endedAt);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.startedAt, second[0].startedAt);
    });

    it("measures idle time between plays, not the interval between them", () => {
        // Two half hour tracks back to back: the timestamps are far apart but
        // there is no idle time at all, so it is one run
        const plays: PlayedTrack[] = [
            { songId: "long-a", startedAt: T0 - (60 * 60e3), endedAt: T0 - (30 * 60e3) },
            { songId: "long-b", startedAt: T0 - (30 * 60e3), endedAt: T0 },
        ];

        const streak = deriveStreak(plays, T0);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.durationMs, 60 * 60e3);
    });

    it("does not mind what order the plays arrive in", () => {
        const plays = run(T0 - (THREE_MIN * 3), 3);
        const shuffled = [plays[2], plays[0], plays[1]];

        assert.deepEqual(deriveStreak(shuffled, T0), deriveStreak(plays, T0));
    });

    it("treats overlapping plays as continuous rather than as a break", () => {
        const plays: PlayedTrack[] = [
            { songId: "a", startedAt: T0 - (THREE_MIN * 2), endedAt: T0 - THREE_MIN },
            // Starts before the previous one finished, as a duplicated import might
            { songId: "b", startedAt: T0 - THREE_MIN - 5000, endedAt: T0 },
        ];

        const streak = deriveStreak(plays, T0);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.startedAt, T0 - (THREE_MIN * 2));
    });

    it("counts a single recent play", () => {
        const streak = deriveStreak(run(T0 - THREE_MIN, 1), T0);

        assert.equal(streak.trackCount, 1);
        assert.equal(streak.durationMs, THREE_MIN);
    });
});

describe("playedTracksFromHistory", () => {
    const durations: { [songId: string]: number } = { a: THREE_MIN, b: THREE_MIN };
    const durationFor = (songId: string) => durations[songId];

    it("reconstructs a full play from its end and its length", () => {
        const plays = playedTracksFromHistory(
            [{ songId: "a", sessionDuration: 1, timestamp: T0 }], durationFor);

        assert.deepEqual(plays, [{ songId: "a", startedAt: T0 - THREE_MIN, endedAt: T0 }]);
    });

    it("reconstructs a partial play as the fraction that was heard", () => {
        const plays = playedTracksFromHistory(
            [{ songId: "a", sessionDuration: 0.25, timestamp: T0 }], durationFor);

        assert.equal(plays[0].startedAt, T0 - (THREE_MIN * 0.25));
    });

    it("drops entries whose track length is unknown", () => {
        // Inventing a length would either create idle time or hide it, and both
        // move where the run appears to break
        const plays = playedTracksFromHistory([
            { songId: "a", sessionDuration: 1, timestamp: T0 },
            { songId: "missing", sessionDuration: 1, timestamp: T0 + THREE_MIN },
        ], durationFor);

        assert.deepEqual(plays.map(p => p.songId), ["a"]);
    });

    it("clamps a nonsensical fraction rather than propagating it", () => {
        const plays = playedTracksFromHistory([
            { songId: "a", sessionDuration: 4, timestamp: T0 },
            { songId: "b", sessionDuration: -1, timestamp: T0 + THREE_MIN },
        ], durationFor);

        assert.equal(plays[0].startedAt, T0 - THREE_MIN);
        assert.equal(plays[1].startedAt, T0 + THREE_MIN);
    });

    it("feeds a run straight into deriveStreak", () => {
        const history = [
            { songId: "a", sessionDuration: 1, timestamp: T0 - THREE_MIN },
            { songId: "b", sessionDuration: 1, timestamp: T0 },
        ];

        const streak = deriveStreak(playedTracksFromHistory(history, durationFor), T0);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.startedAt, T0 - (THREE_MIN * 2));
    });

    it("does not let a dropped entry stitch a broken run together", () => {
        // The unknown track sat in the middle of a twenty minute silence
        const history = [
            { songId: "a", sessionDuration: 1, timestamp: T0 - (25 * 60e3) },
            { songId: "missing", sessionDuration: 1, timestamp: T0 - (12 * 60e3) },
            { songId: "b", sessionDuration: 1, timestamp: T0 },
        ];

        const streak = deriveStreak(playedTracksFromHistory(history, durationFor), T0);

        assert.equal(streak.trackCount, 1);
        assert.equal(streak.startedAt, T0 - THREE_MIN);
    });
});

describe("backfill and streaks together", () => {
    /**
     * The case the whole thing exists for: listening continued offline, so
     * Tempo saw a run, then nothing, then another run.
     */
    const beforeGap = run(T0, 3, "before");
    const gapStart = beforeGap[beforeGap.length - 1].endedAt;
    const afterGap = run(gapStart + (40 * 60e3), 2, "after");
    const now = afterGap[afterGap.length - 1].endedAt;

    it("reads as two broken runs without the missing plays", () => {
        const streak = deriveStreak([...beforeGap, ...afterGap], now);

        assert.equal(streak.trackCount, 2);
        assert.equal(streak.startedAt, afterGap[0].startedAt);
    });

    it("reads as one continuous run once the gap is filled", () => {
        // Spotify's history for the offline stretch: back to back tracks
        const offline = inferPlays(
            Array.from({ length: 13 }, (_, i) => ({
                songId: `offline${i}`,
                playedAt: gapStart + (i * THREE_MIN),
                durationMs: THREE_MIN,
            })),
            "start",
        );

        const imported = selectGapPlays(offline, { start: gapStart, end: afterGap[0].startedAt }, [])
            .map(p => ({ songId: p.songId, startedAt: p.startedAt, endedAt: p.endedAt }));

        const streak = deriveStreak([...beforeGap, ...imported, ...afterGap], now);

        assert.equal(streak.startedAt, beforeGap[0].startedAt);
        assert.equal(streak.trackCount, 3 + imported.length + 2);
        assert.equal(streak.durationMs, now - beforeGap[0].startedAt);
    });

    it("still breaks when the offline listening had a real gap in it", () => {
        // Offline they played two tracks, stopped for twenty minutes, then
        // played one more and kept going straight into what Tempo saw. The
        // twenty minutes is the only silence, so it has to be the break.
        const silence = 20 * 60e3;
        const resumedAt = gapStart + (THREE_MIN * 2) + silence;

        const offline = inferPlays([
            { songId: "o1", playedAt: gapStart, durationMs: THREE_MIN },
            { songId: "o2", playedAt: gapStart + THREE_MIN, durationMs: THREE_MIN },
            { songId: "o3", playedAt: resumedAt, durationMs: THREE_MIN },
        ], "start");

        const imported = offline.map(p => ({ songId: p.songId, startedAt: p.startedAt, endedAt: p.endedAt }));

        // Picked up again the moment the last offline track finished
        const watched = run(resumedAt + THREE_MIN, 2, "after");
        const end = watched[watched.length - 1].endedAt;

        const streak = deriveStreak([...beforeGap, ...imported, ...watched], end);

        // The run cannot reach back past the twenty minute silence
        assert.notEqual(streak.startedAt, beforeGap[0].startedAt);
        assert.equal(streak.startedAt, imported[2].startedAt);
        assert.equal(streak.trackCount, 3);
    });

    it("is unchanged by a play that dedupe would have dropped", () => {
        const observed = {
            songId: "before2",
            updatedAt: gapStart - 60e3,
            progressNormal: (THREE_MIN - 60e3) / THREE_MIN,
            durationMs: THREE_MIN,
            timeRemainingMs: 60e3,
        };

        const offline = inferPlays([
            // The track Tempo was already watching when it lost sight of them
            { songId: "before2", playedAt: gapStart - THREE_MIN, durationMs: THREE_MIN },
            { songId: "o1", playedAt: gapStart, durationMs: THREE_MIN },
        ], "start");

        const withDedupe = selectGapPlays(offline, { start: gapStart - THREE_MIN, end: afterGap[0].startedAt }, [observed]);

        assert.deepEqual(withDedupe.map(p => p.songId), ["o1"]);
    });
});
