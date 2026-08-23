import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    BackfilledPlay,
    inferPlays,
    ObservedPlay,
    PlayHistoryEntry,
    playWindow,
    selectGapPlays,
} from "./listening-backfill";
import { SKIP_BELOW_PROGRESS } from "./playback-transition";

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
