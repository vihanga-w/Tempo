/**
 * Reconstructing listening that happened while Tempo was not watching.
 *
 * Offline playback is invisible to the poll: Spotify reports nothing playing, so
 * the session looks stopped and the history has a hole in it. Spotify's own
 * play history can fill that hole once the device syncs, but it is a thinner
 * record than an observed play — no progress, no skips, nothing under about
 * thirty seconds — so what can be recovered has to be inferred rather than read.
 *
 * Everything here is pure so the inference can be tested against known
 * sequences; fetching and storing live elsewhere.
 */

import { SKIP_BELOW_PROGRESS } from "./playback-transition";

/**
 * Whether Spotify's `played_at` marks the beginning or the end of a play.
 *
 * The docs do not say plainly and it decides which neighbour a play's length is
 * measured against, so it is a parameter until it has been checked against real
 * data rather than a constant someone guessed.
 */
export type PlayedAtMarks = "start" | "end";

/** One entry from Spotify's play history. */
export interface PlayHistoryEntry {
    songId: string;
    playedAt: number;
    /** The track's own length, which bounds how long it can have been played. */
    durationMs: number;
}

/** A play Tempo saw for itself, used to avoid importing it twice. */
export interface ObservedPlay {
    songId: string;
    /** When the measurement below was taken. */
    updatedAt: number;
    progressNormal: number;
    durationMs: number;
    timeRemainingMs: number;
}

export interface BackfilledPlay {
    songId: string;
    /** When the play began, whichever end `playedAt` marks. */
    startedAt: number;
    /** When it stopped. */
    endedAt: number;
    /** How much of the track was played, 0 to 1. */
    sessionDuration: number;
    skipped: boolean;
    /**
     * True when sessionDuration could not be measured and a full play was
     * assumed — the last entry in a run has no neighbour to measure against.
     * Kept so taste weighting can tell a measurement from a guess.
     */
    assumedComplete: boolean;
}

export interface Window {
    start: number;
    end: number;
}

/**
 * The span a play occupied, from a single observation of it.
 *
 * Derived from `updatedAt` rather than the current time: the measurement is only
 * true as of when it was taken, and polls can be minutes apart, so anchoring to
 * "now" would drift the window by however long ago Tempo last looked.
 */
export function playWindow(observed: ObservedPlay): Window {
    return {
        start: observed.updatedAt - (observed.progressNormal * observed.durationMs),
        end: observed.updatedAt + observed.timeRemainingMs,
    };
}

/**
 * Works out how much of each track was actually played.
 *
 * Consecutive timestamps carry the answer: a track followed forty seconds later
 * was played for forty seconds, however long it happens to be. That turns the
 * length of a play from an assumption into a measurement for every entry except
 * the one at the end of a run, which has no neighbour to measure against.
 *
 * A gap longer than the track means the listener finished it and then stopped,
 * so the fraction is capped at 1 rather than allowed to imply more listening
 * than the track can hold.
 *
 * `entries` must be ordered oldest first.
 */
export function inferPlays(entries: PlayHistoryEntry[], marks: PlayedAtMarks): BackfilledPlay[] {
    return entries.map((entry, i) => {
        // Under "start" a play runs until the next one begins; under "end" it
        // runs from when the previous one finished.
        const neighbour = (marks === "start" ? entries[i + 1]?.playedAt : entries[i - 1]?.playedAt);

        const startedAt = (marks === "start" ? entry.playedAt : entry.playedAt - entry.durationMs);
        const endedAt = (marks === "start" ? entry.playedAt + entry.durationMs : entry.playedAt);

        if (neighbour === undefined || entry.durationMs <= 0) {
            return {
                songId: entry.songId,
                startedAt,
                endedAt,
                sessionDuration: 1,
                skipped: false,
                assumedComplete: true,
            };
        }

        const elapsed = Math.abs(neighbour - entry.playedAt);
        const sessionDuration = Math.min(1, Math.max(0, elapsed / entry.durationMs));

        return {
            songId: entry.songId,
            startedAt: (marks === "start" ? entry.playedAt : entry.playedAt - (sessionDuration * entry.durationMs)),
            endedAt: (marks === "start" ? entry.playedAt + (sessionDuration * entry.durationMs) : entry.playedAt),
            sessionDuration,
            // The same threshold the live poll uses, so a track abandoned early
            // is called a skip whether Tempo watched it happen or not
            skipped: sessionDuration < SKIP_BELOW_PROGRESS,
            assumedComplete: false,
        };
    });
}

/** Whether two spans overlap at all. */
function overlaps(a: Window, b: Window): boolean {
    return (a.start <= b.end && b.start <= a.end);
}

/**
 * Narrows imported plays to the stretch Tempo could not see.
 *
 * Scanning a fixed window instead would re-read plays that were watched at the
 * time, which then have to be matched against stored history by timestamp — and
 * stored history is stamped when a track ended, not when Spotify says it played,
 * so the two never line up exactly. Importing only the blind stretch removes the
 * question: nothing inside it was ever observed.
 *
 * The only plays that can be ambiguous are the two at the edges — whatever was
 * playing when Tempo lost sight of the listener, and whatever was playing when
 * it picked them up again. Those are dropped when they overlap the span of a
 * play that was observed, since a play cannot happen twice at once.
 */
export function selectGapPlays(
    plays: BackfilledPlay[],
    gap: Window,
    observed: ObservedPlay[],
): BackfilledPlay[] {
    const observedWindows = observed.map(o => ({ songId: o.songId, window: playWindow(o) }));

    return plays.filter(play => {
        const playWindowSpan = { start: play.startedAt, end: play.endedAt };

        if (!overlaps(playWindowSpan, gap))
            return false;

        // Same track, overlapping spans: this is the play Tempo already has.
        // A genuine repeat starts after the first finished, so it falls outside.
        return !observedWindows.some(o => o.songId === play.songId && overlaps(playWindowSpan, o.window));
    });
}
