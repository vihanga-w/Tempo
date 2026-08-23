import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    classifyPlaybackTransition,
    PlaybackSnapshot,
    REPLAY_PREVIOUSLY_ABOVE,
    REPLAY_RESTARTED_BELOW,
    SKIP_BELOW_PROGRESS,
} from "./playback-transition";

/** A playing snapshot, since that is what almost every case starts from. */
function playing(songId: string, progressNormal: number): PlaybackSnapshot {
    return { songId, progressNormal, isPlaying: true };
}

function paused(songId: string, progressNormal: number): PlaybackSnapshot {
    return { songId, progressNormal, isPlaying: false };
}

/**
 * Runs a sequence of polls through the classifier the way the refresh loop
 * does — each reading compared against the one before it.
 */
function poll(sequence: (PlaybackSnapshot | undefined)[]) {
    const transitions = [];

    for (let i = 1; i < sequence.length; i++)
        transitions.push(classifyPlaybackTransition(sequence[i - 1], sequence[i]));

    return transitions;
}

describe("classifyPlaybackTransition — single transitions", () => {
    it("reports a start when playback begins from nothing", () => {
        const t = classifyPlaybackTransition(undefined, playing("a", 0.01));

        assert.equal(t.started, true);
        assert.equal(t.songChanged, false);
        assert.equal(t.syncTrigger, "song-started");
        assert.deepEqual(t.actions, ["PLAYING:a"]);
    });

    it("reports a stop when nothing is playing", () => {
        const t = classifyPlaybackTransition(playing("a", 0.5), undefined);

        assert.equal(t.stopped, true);
        assert.equal(t.syncTrigger, "stopped");
        assert.deepEqual(t.actions, ["STOPPED"]);
    });

    it("reports nothing for a poll where only progress moved", () => {
        const t = classifyPlaybackTransition(playing("a", 0.2), playing("a", 0.5));

        assert.equal(t.started, false);
        assert.equal(t.songChanged, false);
        assert.equal(t.playStateChanged, false);
        assert.equal(t.replayed, false);
        assert.equal(t.syncTrigger, undefined);
        // Still announces what is playing
        assert.deepEqual(t.actions, ["PLAYING:a"]);
    });

    it("treats an abandoned track as skipped", () => {
        const t = classifyPlaybackTransition(playing("a", 0.3), playing("b", 0.01));

        assert.equal(t.songChanged, true);
        assert.equal(t.skipped, true);
        assert.equal(t.listened, false);
        assert.equal(t.syncTrigger, "song-changed");
        assert.deepEqual(t.actions, ["PLAYING:b", "SKIPPED:a"]);
    });

    it("treats a track played through as listened", () => {
        const t = classifyPlaybackTransition(playing("a", 0.98), playing("b", 0.01));

        assert.equal(t.songChanged, true);
        assert.equal(t.skipped, false);
        assert.equal(t.listened, true);
        assert.deepEqual(t.actions, ["PLAYING:b", "LISTENED:a"]);
    });

    it("counts a track two thirds played as skipped", () => {
        // Deliberately a literal rather than the constant: asserting against
        // SKIP_BELOW_PROGRESS moves the goalposts with it, so a change to the
        // threshold would go unnoticed
        const t = classifyPlaybackTransition(playing("a", 0.66), playing("b", 0));

        assert.equal(t.skipped, true);
    });

    it("counts a track four fifths played as listened", () => {
        const t = classifyPlaybackTransition(playing("a", 0.8), playing("b", 0));

        assert.equal(t.listened, true);
    });

    it("counts the skip threshold as listened at the boundary", () => {
        const skipped = classifyPlaybackTransition(
            playing("a", SKIP_BELOW_PROGRESS - 0.0001), playing("b", 0));
        const listened = classifyPlaybackTransition(
            playing("a", SKIP_BELOW_PROGRESS), playing("b", 0));

        assert.equal(skipped.skipped, true);
        assert.equal(listened.listened, true);
    });

    it("reports a pause", () => {
        const t = classifyPlaybackTransition(playing("a", 0.4), paused("a", 0.4));

        assert.equal(t.playStateChanged, true);
        assert.equal(t.syncTrigger, "play-state-changed");
        assert.deepEqual(t.actions, ["PAUSED:a"]);
    });

    it("reports a resume", () => {
        const t = classifyPlaybackTransition(paused("a", 0.4), playing("a", 0.4));

        assert.equal(t.playStateChanged, true);
        assert.equal(t.syncTrigger, "play-state-changed");
        // Announced both as the current track and as the state change
        assert.deepEqual(t.actions, ["PLAYING:a", "PLAYING:a"]);
    });

    it("reports a replay when the same track restarts from the top", () => {
        const t = classifyPlaybackTransition(playing("a", 0.9), playing("a", 0.02));

        assert.equal(t.replayed, true);
        assert.equal(t.songChanged, false);
        assert.deepEqual(t.actions, ["PLAYING:a", "REPLAYED:a"]);
    });

    it("does not call an early seek a replay", () => {
        // Restarted, but was never played far enough in to count
        const t = classifyPlaybackTransition(
            playing("a", REPLAY_PREVIOUSLY_ABOVE), playing("a", 0.01));

        assert.equal(t.replayed, false);
    });

    it("does not call a small rewind a replay", () => {
        // Was played far enough in, but did not restart near the beginning
        const t = classifyPlaybackTransition(
            playing("a", 0.9), playing("a", REPLAY_RESTARTED_BELOW));

        assert.equal(t.replayed, false);
    });

    it("ignores a paused first sighting", () => {
        const t = classifyPlaybackTransition(undefined, paused("a", 0.4));

        assert.equal(t.started, false);
        assert.equal(t.syncTrigger, undefined);
        assert.deepEqual(t.actions, []);
    });
});

describe("classifyPlaybackTransition — the thresholds themselves", () => {
    // Pinned to their values, so moving one is a deliberate act rather than a
    // silent change every other test quietly follows
    it("skips below three quarters played", () => {
        assert.equal(SKIP_BELOW_PROGRESS, 0.75);
    });

    it("treats a restart under a fifth in as a replay", () => {
        assert.equal(REPLAY_RESTARTED_BELOW, 0.2);
    });

    it("requires a replayed track to have been about two thirds played", () => {
        assert.equal(REPLAY_PREVIOUSLY_ABOVE, 0.65);
    });
});

describe("classifyPlaybackTransition — several changes in one poll", () => {
    it("reports a track change and a pause together, with the pause deciding the sync", () => {
        const t = classifyPlaybackTransition(playing("a", 0.9), paused("b", 0.05));

        assert.equal(t.songChanged, true);
        assert.equal(t.listened, true);
        assert.equal(t.playStateChanged, true);
        // Last transition wins, matching the order the loop applies them
        assert.equal(t.syncTrigger, "play-state-changed");
        assert.deepEqual(t.actions, ["LISTENED:a", "PAUSED:b"]);
    });

    it("does not report a replay alongside a track change", () => {
        // Restarting on a different track is simply the next song
        const t = classifyPlaybackTransition(playing("a", 0.9), playing("b", 0.01));

        assert.equal(t.songChanged, true);
        assert.equal(t.replayed, false);
    });

    it("reports a resume onto a different track as both", () => {
        const t = classifyPlaybackTransition(paused("a", 0.3), playing("b", 0.01));

        assert.equal(t.songChanged, true);
        assert.equal(t.skipped, true);
        assert.equal(t.playStateChanged, true);
        assert.equal(t.syncTrigger, "play-state-changed");
    });

    it("stops regardless of what else looks like it changed", () => {
        const t = classifyPlaybackTransition(playing("a", 0.1), undefined);

        assert.equal(t.stopped, true);
        assert.equal(t.songChanged, false);
        assert.equal(t.playStateChanged, false);
        assert.deepEqual(t.actions, ["STOPPED"]);
    });
});

describe("classifyPlaybackTransition — a whole listening session", () => {
    it("follows a session from first play through to silence", () => {
        const transitions = poll([
            undefined,              // nothing known yet
            playing("a", 0.02),     // starts listening
            playing("a", 0.40),     // part way through
            playing("a", 0.95),     // nearly done
            playing("b", 0.01),     // moves on, having heard it
            playing("b", 0.30),     // part way
            playing("c", 0.01),     // skips
            playing("c", 0.80),     // most of the way through
            playing("c", 0.03),     // replays it
            paused("c", 0.30),      // pauses
            playing("c", 0.30),     // resumes
            undefined,              // closes Spotify
        ]);

        assert.deepEqual(
            transitions.map(t => t.syncTrigger),
            [
                "song-started",
                undefined,
                undefined,
                "song-changed",
                undefined,
                "song-changed",
                undefined,
                undefined,
                "play-state-changed",
                "play-state-changed",
                "stopped",
            ],
        );

        assert.deepEqual(
            transitions.flatMap(t => t.actions),
            [
                "PLAYING:a",
                "PLAYING:a",
                "PLAYING:a",
                "PLAYING:b", "LISTENED:a",
                "PLAYING:b",
                "PLAYING:c", "SKIPPED:b",
                "PLAYING:c",
                "PLAYING:c", "REPLAYED:c",
                "PAUSED:c",
                "PLAYING:c", "PLAYING:c",
                "STOPPED",
            ],
        );

        // One listen, one skip, one replay across the whole session
        assert.equal(transitions.filter(t => t.listened).length, 1);
        assert.equal(transitions.filter(t => t.skipped).length, 1);
        assert.equal(transitions.filter(t => t.replayed).length, 1);
        assert.equal(transitions.filter(t => t.started).length, 1);
        assert.equal(transitions.filter(t => t.stopped).length, 1);
    });

    it("treats a resumed session after silence as a fresh start", () => {
        const transitions = poll([
            playing("a", 0.5),
            undefined,              // stopped for a while
            playing("b", 0.01),     // comes back on something else
        ]);

        assert.equal(transitions[0].stopped, true);
        assert.equal(transitions[1].started, true);
        assert.equal(transitions[1].songChanged, false);
        assert.equal(transitions[1].syncTrigger, "song-started");
    });

    it("survives a run of skips without reporting anything else", () => {
        const transitions = poll([
            playing("a", 0.02),
            playing("b", 0.02),
            playing("c", 0.02),
            playing("d", 0.02),
        ]);

        assert.equal(transitions.every(t => t.songChanged && t.skipped), true);
        assert.equal(transitions.some(t => t.replayed), false);
        assert.equal(transitions.some(t => t.playStateChanged), false);
        assert.deepEqual(transitions.map(t => t.syncTrigger),
            ["song-changed", "song-changed", "song-changed"]);
    });

    it("reports every poll of a paused track as unchanged", () => {
        const transitions = poll([
            playing("a", 0.4),
            paused("a", 0.4),
            paused("a", 0.4),
            paused("a", 0.4),
        ]);

        assert.equal(transitions[0].playStateChanged, true);
        assert.equal(transitions[1].playStateChanged, false);
        assert.equal(transitions[2].playStateChanged, false);
        assert.deepEqual(transitions.slice(1).flatMap(t => t.actions), []);
        assert.deepEqual(transitions.slice(1).map(t => t.syncTrigger), [undefined, undefined]);
    });
});
