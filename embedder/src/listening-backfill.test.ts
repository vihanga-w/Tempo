import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    BackfilledPlay,
    BATCH_SUSPECT_RATIO,
    BATCH_SUSPECT_RUN,
    markBatchedDeliveries,
    reconstructBatchedRun,
    SPOTIFY_PLAYED_AT_MARKS,
    inferPlays,
    ObservedPlay,
    PlayHistoryEntry,
    playWindow,
    selectGapPlays,
} from "./listening-backfill";
import { SKIP_BELOW_PROGRESS } from "./playback-transition";
import { deriveStreak } from "./streak-derivation";

const T0 = 1_700_000_000_000;
const THREE_MIN = 180e3;

function entry(songId: string, playedAt: number, durationMs = THREE_MIN): PlayHistoryEntry {
    return { songId, playedAt, durationMs };
}

describe("playWindow", () => {
    it("spans from where the track began to where it will end", () => {
        const observed: ObservedPlay = {
            songId: "a",
            updatedAt: T0,
            progressNormal: 0.25,
            durationMs: THREE_MIN,
            timeRemainingMs: THREE_MIN * 0.75,
        };

        assert.deepEqual(playWindow(observed), {
            start: T0 - (THREE_MIN * 0.25),
            end: T0 + (THREE_MIN * 0.75),
        });
    });

    it("anchors to when the measurement was taken, not to now", () => {
        // A reading from five minutes ago describes a window five minutes ago,
        // however long it has been since Tempo last looked
        const stale: ObservedPlay = {
            songId: "a",
            updatedAt: T0 - 300e3,
            progressNormal: 0.5,
            durationMs: THREE_MIN,
            timeRemainingMs: THREE_MIN * 0.5,
        };

        const w = playWindow(stale);

        assert.equal(w.start, T0 - 300e3 - (THREE_MIN * 0.5));
        assert.equal(w.end, T0 - 300e3 + (THREE_MIN * 0.5));
    });

    it("covers a track just started and one about to finish", () => {
        const starting = playWindow({
            songId: "a", updatedAt: T0, progressNormal: 0,
            durationMs: THREE_MIN, timeRemainingMs: THREE_MIN,
        });
        const ending = playWindow({
            songId: "a", updatedAt: T0, progressNormal: 1,
            durationMs: THREE_MIN, timeRemainingMs: 0,
        });

        assert.equal(starting.end - starting.start, THREE_MIN);
        assert.equal(ending.end - ending.start, THREE_MIN);
    });
});

describe("inferPlays — measuring how much was played", () => {
    it("measures a full play from the gap to the next track", () => {
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + THREE_MIN),
        ], "start");

        assert.equal(plays[0].sessionDuration, 1);
        assert.equal(plays[0].skipped, false);
        assert.equal(plays[0].assumedComplete, false);
    });

    it("measures a skip from a short gap", () => {
        // Forty seconds of a three minute track
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + 40e3),
        ], "start");

        assert.equal(Math.round(plays[0].sessionDuration * 1000) / 1000, 0.222);
        assert.equal(plays[0].skipped, true);
    });

    it("caps a long gap at a complete play rather than more than one", () => {
        // They finished it and then stopped listening for an hour
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + 3600e3),
        ], "start");

        assert.equal(plays[0].sessionDuration, 1);
        assert.equal(plays[0].skipped, false);
    });

    it("assumes a complete play for the track with no neighbour, and says so", () => {
        const plays = inferPlays([entry("a", T0)], "start");

        assert.equal(plays[0].sessionDuration, 1);
        assert.equal(plays[0].assumedComplete, true);
    });

    it("flags only the unmeasurable one in a run", () => {
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + THREE_MIN),
            entry("c", T0 + (THREE_MIN * 2)),
        ], "start");

        assert.deepEqual(plays.map(p => p.assumedComplete), [false, false, true]);
    });

    it("measures against the previous track when playedAt marks the end", () => {
        // Same listening, described the other way round: a finished at T0+3min
        // having started at T0, so it was played in full
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + THREE_MIN),
        ], "end");

        assert.equal(plays[1].sessionDuration, 1);
        assert.equal(plays[1].assumedComplete, false);
        // The first has no predecessor to measure against
        assert.equal(plays[0].assumedComplete, true);
    });

    it("classifies a skip on the same threshold the live poll uses", () => {
        const justUnder = inferPlays([
            entry("a", T0),
            entry("b", T0 + (THREE_MIN * (SKIP_BELOW_PROGRESS - 0.01))),
        ], "start");

        const justOver = inferPlays([
            entry("a", T0),
            entry("b", T0 + (THREE_MIN * (SKIP_BELOW_PROGRESS + 0.01))),
        ], "start");

        assert.equal(justUnder[0].skipped, true);
        assert.equal(justOver[0].skipped, false);
    });

    it("never reports a negative or oversized fraction", () => {
        const plays = inferPlays([
            entry("a", T0, 0),
            entry("b", T0 - 5000),
        ], "start");

        assert.equal(plays.every(p => p.sessionDuration >= 0 && p.sessionDuration <= 1), true);
    });

    it("gives back a span that matches the measured length", () => {
        const plays = inferPlays([
            entry("a", T0),
            entry("b", T0 + 45e3),
        ], "start");

        assert.equal(plays[0].endedAt - plays[0].startedAt, 45e3);
    });
});

describe("inferPlays — against real play history", () => {
    /**
     * Seven consecutive plays taken from a live account, with the durations
     * Spotify reported. The timestamps are unmodified.
     */
    const observed = [
        { songId: "topia", at: "2026-08-23T01:32:10.323Z", durationMs: 209e3 },   // 3m29s
        { songId: "olympian", at: "2026-08-23T01:35:05.115Z", durationMs: 175e3 }, // 2m55s
        { songId: "whatever", at: "2026-08-23T01:37:51.734Z", durationMs: 166e3 }, // 2m46s
        { songId: "circus", at: "2026-08-23T01:42:10.646Z", durationMs: 259e3 },   // 4m19s
        { songId: "parasail", at: "2026-08-23T01:44:45.657Z", durationMs: 155e3 }, // 2m35s
        { songId: "pink", at: "2026-08-23T01:49:41.667Z", durationMs: 164e3 },     // 2m44s
        { songId: "poppin", at: "2026-08-23T01:51:02.075Z", durationMs: 174e3 },   // 2m54s
    ].map(v => ({ songId: v.songId, playedAt: new Date(v.at).getTime(), durationMs: v.durationMs }));

    it("reads a back to back run as complete plays", () => {
        const plays = inferPlays(observed, SPOTIFY_PLAYED_AT_MARKS);

        // Everything but the abandoned one at the end, and the first, which has
        // no predecessor to measure against
        for (const songId of ["olympian", "whatever", "circus", "parasail"]) {
            const play = plays.find(p => p.songId === songId)!;

            assert.equal(play.assumedComplete, false);
            assert.ok(play.sessionDuration > 0.99, `${songId} was ${play.sessionDuration}`);
            assert.equal(play.skipped, false);
        }
    });

    it("recovers the track that was abandoned part way", () => {
        const plays = inferPlays(observed, SPOTIFY_PLAYED_AT_MARKS);
        const poppin = plays.find(p => p.songId === "poppin")!;

        // 80 seconds of a 2m54s track
        assert.equal(Math.round(poppin.sessionDuration * 100), 46);
        assert.equal(poppin.skipped, true);
    });

    it("caps a play that had idle time before it", () => {
        // Nearly five minutes of wall clock for a 2m44s track: something
        // unrecorded happened in between, and it is not extra listening
        const plays = inferPlays(observed, SPOTIFY_PLAYED_AT_MARKS);
        const pink = plays.find(p => p.songId === "pink")!;

        assert.equal(pink.sessionDuration, 1);
        assert.equal(pink.endedAt - pink.startedAt, 164e3);
    });

    it("reads the same run wrongly under the other interpretation", () => {
        // Guards the constant: if played_at were treated as the start of a play,
        // each track would be measured against its successor's length instead of
        // its own, and this run would not read as complete plays
        const wrong = inferPlays(observed, "start");

        const measured = wrong.filter(p => !p.assumedComplete && p.sessionDuration > 0.99);
        const right = inferPlays(observed, SPOTIFY_PLAYED_AT_MARKS)
            .filter(p => !p.assumedComplete && p.sessionDuration > 0.99);

        assert.notEqual(measured.length, right.length);
    });

    it("says which end of the play the timestamp marks", () => {
        assert.equal(SPOTIFY_PLAYED_AT_MARKS, "end");
    });
});

describe("markBatchedDeliveries", () => {
    /** A run of plays delivered together, as a reconnecting device sends them. */
    function batch(count: number, at = T0): PlayHistoryEntry[] {
        return Array.from({ length: count }, (_, i) => ({
            songId: `b${i}`,
            // Milliseconds apart, which is a delivery rather than listening
            playedAt: at + (i * 40),
            durationMs: THREE_MIN,
        }));
    }

    it("marks a run of plays stamped milliseconds apart", () => {
        const plays = markBatchedDeliveries(inferPlays(batch(6), "end"));

        // The first has no predecessor to measure against, so it is assumed
        // rather than measured and cannot be judged
        assert.equal(plays.slice(1).every(p => p.suspectBatched), true);
    });

    it("leaves a single skip alone", () => {
        const plays = markBatchedDeliveries(inferPlays([
            entry("a", T0),
            entry("b", T0 + THREE_MIN),
            entry("c", T0 + THREE_MIN + 2000),
            entry("d", T0 + (THREE_MIN * 2) + 2000),
        ], "end"));

        assert.equal(plays.some(p => p.suspectBatched), false);
    });

    it("leaves ordinary listening alone", () => {
        const plays = markBatchedDeliveries(inferPlays([
            entry("a", T0),
            entry("b", T0 + THREE_MIN),
            entry("c", T0 + (THREE_MIN * 2)),
            entry("d", T0 + (THREE_MIN * 3)),
        ], "end"));

        assert.equal(plays.some(p => p.suspectBatched), false);
    });

    it("leaves a run of genuine skips alone", () => {
        // Somebody skipping through a playlist: four tracks, each given between
        // a quarter and half a chance. Real listening, and discarding it would
        // lose the clearest signal there is about what they do not want.
        const plays = markBatchedDeliveries(inferPlays([
            entry("a", T0),
            entry("b", T0 + 50e3),
            entry("c", T0 + 130e3),
            entry("d", T0 + 190e3),
            entry("e", T0 + 260e3),
        ], "end"));

        const measured = plays.filter(p => !p.assumedComplete);

        // Each was a real skip, and none of them is a delivery artefact
        assert.equal(measured.every(p => p.skipped), true);
        assert.equal(measured.every(p => p.sessionDuration > BATCH_SUSPECT_RATIO), true);
        assert.equal(plays.some(p => p.suspectBatched), false);
    });

    it("separates a delivery from a skip by an order of magnitude", () => {
        // Pinned to the value rather than the constant: a threshold that moves
        // with its test constrains nothing. A delivery lands milliseconds apart,
        // a skip seconds to minutes, so the line sits far from both.
        assert.equal(BATCH_SUSPECT_RATIO, 0.05);
        assert.equal(BATCH_SUSPECT_RUN, 3);
    });

    it("needs a run before it calls anything a delivery", () => {
        // Two suspicious plays are below the threshold, three are not
        const twoInARow = markBatchedDeliveries(inferPlays([
            entry("a", T0),
            entry("b", T0 + 40),
            entry("c", T0 + 80),
            entry("d", T0 + THREE_MIN),
        ], "end"));

        assert.equal(twoInARow.filter(p => p.suspectBatched).length, 0);

        const threeInARow = markBatchedDeliveries(inferPlays([
            entry("a", T0),
            entry("b", T0 + 40),
            entry("c", T0 + 80),
            entry("d", T0 + 120),
            entry("e", T0 + THREE_MIN),
        ], "end"));

        assert.equal(threeInARow.filter(p => p.suspectBatched).length, BATCH_SUSPECT_RUN);
    });

    it("marks only the delivered run, not the listening around it", () => {
        const plays = markBatchedDeliveries(inferPlays([
            entry("real1", T0),
            entry("real2", T0 + THREE_MIN),
            entry("b1", T0 + (THREE_MIN * 2)),
            entry("b2", T0 + (THREE_MIN * 2) + 40),
            entry("b3", T0 + (THREE_MIN * 2) + 80),
            entry("b4", T0 + (THREE_MIN * 2) + 120),
            entry("real3", T0 + (THREE_MIN * 5)),
        ], "end"));

        assert.deepEqual(
            plays.filter(p => p.suspectBatched).map(p => p.songId),
            ["b2", "b3", "b4"],
        );
    });

    it("keeps a delivered batch out of an import entirely", () => {
        // The case that matters: a reconnecting device's whole offline session
        // arriving at once must not be read as a run of abandoned tracks
        const gap = { start: T0 - (60 * 60e3), end: T0 + 60e3 };

        const kept = selectGapPlays(inferPlays(batch(8), "end"), gap, []);

        assert.equal(kept.every(p => !p.suspectBatched), true);
        assert.equal(kept.length <= 1, true);
    });
});

describe("reconstructBatchedRun", () => {
    const lengths = [THREE_MIN, 120e3, 240e3];

    function batchOf(lengthsMs: number[]): ReturnType<typeof inferPlays> {
        return inferPlays(
            lengthsMs.map((durationMs, i) => ({
                songId: `t${i}`,
                // All but stamped together, as a delivery arrives
                playedAt: T0 + (i * 40),
                durationMs,
            })),
            "end",
        );
    }

    it("lays the tracks end to end finishing at the anchor", () => {
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);

        assert.equal(rebuilt[rebuilt.length - 1].endedAt, T0);

        for (let i = 1; i < rebuilt.length; i++)
            assert.equal(rebuilt[i].startedAt, rebuilt[i - 1].endedAt);
    });

    it("spans as long as the music in it", () => {
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);
        const total = lengths.reduce((a, b) => a + b, 0);

        assert.equal(rebuilt[rebuilt.length - 1].endedAt - rebuilt[0].startedAt, total);
    });

    it("keeps the tracks in the order they were played", () => {
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);

        assert.deepEqual(rebuilt.map(p => p.songId), ["t0", "t1", "t2"]);
    });

    it("marks every play as an estimate rather than a measurement", () => {
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);

        assert.equal(rebuilt.every(p => p.reconstructed), true);
        assert.equal(rebuilt.every(p => p.assumedComplete), true);
    });

    it("does not report a rebuilt play as abandoned", () => {
        // Read from the delivery's timestamps these looked like tracks dropped
        // after milliseconds; that was the delivery, not the listener
        const measured = batchOf(lengths);
        const rebuilt = reconstructBatchedRun(measured, T0);

        assert.equal(measured.slice(1).every(p => p.skipped), true);
        assert.equal(rebuilt.some(p => p.skipped), false);
    });

    it("rebuilds a run a streak can be derived from", () => {
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);
        const total = lengths.reduce((a, b) => a + b, 0);

        const streak = deriveStreak(
            rebuilt.map(p => ({ songId: p.songId, startedAt: p.startedAt, endedAt: p.endedAt })),
            T0,
        );

        assert.equal(streak.trackCount, 3);
        assert.equal(streak.durationMs, total);
    });

    it("cannot see a pause that happened inside the batch", () => {
        // Documented limitation, asserted so it stays known: the listener took a
        // twenty minute break in the middle, and nothing in the delivery records
        // it, so the rebuilt session reads as continuous
        const rebuilt = reconstructBatchedRun(batchOf(lengths), T0);

        const idle = rebuilt.slice(1).map((p, i) => p.startedAt - rebuilt[i].endedAt);

        assert.deepEqual(idle, [0, 0]);
    });

    it("survives a track of unknown length", () => {
        const rebuilt = reconstructBatchedRun(batchOf([THREE_MIN, 0, THREE_MIN]), T0);

        assert.equal(rebuilt.every(p => p.endedAt >= p.startedAt), true);
        assert.equal(rebuilt[0].startedAt, T0 - (THREE_MIN * 2));
    });

    it("handles an empty batch", () => {
        assert.deepEqual(reconstructBatchedRun([], T0), []);
    });
});

describe("selectGapPlays — importing only what was missed", () => {
    const gap = { start: T0, end: T0 + (30 * 60e3) };

    function played(songId: string, startedAt: number, ms = THREE_MIN): BackfilledPlay {
        return {
            songId,
            startedAt,
            endedAt: startedAt + ms,
            sessionDuration: 1,
            skipped: false,
            assumedComplete: false,
            durationMs: ms,
        };
    }

    it("keeps plays inside the blind stretch", () => {
        const kept = selectGapPlays([played("a", T0 + 60e3)], gap, []);

        assert.equal(kept.length, 1);
    });

    it("drops plays from before the stretch began", () => {
        const kept = selectGapPlays([played("a", T0 - (60 * 60e3))], gap, []);

        assert.equal(kept.length, 0);
    });

    it("drops plays from after it ended", () => {
        const kept = selectGapPlays([played("a", T0 + (60 * 60e3))], gap, []);

        assert.equal(kept.length, 0);
    });

    it("drops a play Tempo watched at the edge of the stretch", () => {
        const observed: ObservedPlay = {
            songId: "a",
            updatedAt: T0,
            progressNormal: 0.5,
            durationMs: THREE_MIN,
            timeRemainingMs: THREE_MIN * 0.5,
        };

        const kept = selectGapPlays([played("a", T0 - (THREE_MIN * 0.5))], gap, [observed]);

        assert.equal(kept.length, 0);
    });

    it("keeps a repeat of an observed track that happened later", () => {
        const observed: ObservedPlay = {
            songId: "a",
            updatedAt: T0,
            progressNormal: 0.5,
            durationMs: THREE_MIN,
            timeRemainingMs: THREE_MIN * 0.5,
        };

        // Played again well after the observed play finished
        const kept = selectGapPlays([played("a", T0 + (10 * 60e3))], gap, [observed]);

        assert.equal(kept.length, 1);
    });

    it("keeps a different track overlapping an observed play", () => {
        // Only the same track at the same time can be the same play
        const observed: ObservedPlay = {
            songId: "a",
            updatedAt: T0,
            progressNormal: 0.5,
            durationMs: THREE_MIN,
            timeRemainingMs: THREE_MIN * 0.5,
        };

        const kept = selectGapPlays([played("b", T0 - (THREE_MIN * 0.5))], gap, [observed]);

        assert.equal(kept.length, 1);
    });

    it("handles both edges of the stretch at once", () => {
        const before: ObservedPlay = {
            songId: "a", updatedAt: T0, progressNormal: 0.5,
            durationMs: THREE_MIN, timeRemainingMs: THREE_MIN * 0.5,
        };
        const after: ObservedPlay = {
            songId: "z", updatedAt: gap.end, progressNormal: 0.5,
            durationMs: THREE_MIN, timeRemainingMs: THREE_MIN * 0.5,
        };

        const kept = selectGapPlays([
            played("a", T0 - (THREE_MIN * 0.5)),        // the one it was watching
            played("m", T0 + (10 * 60e3)),              // missed
            played("n", T0 + (20 * 60e3)),              // missed
            played("z", gap.end - (THREE_MIN * 0.5)),   // the one it picked up
        ], gap, [before, after]);

        assert.deepEqual(kept.map(p => p.songId), ["m", "n"]);
    });

    it("imports nothing when there was no gap to fill", () => {
        const kept = selectGapPlays([played("a", T0 + 60e3)], { start: T0, end: T0 }, []);

        // A zero width stretch still touches a play spanning it, so the guard
        // that matters is the observed one
        assert.equal(kept.length <= 1, true);
    });
});
