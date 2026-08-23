/**
 * Working out a listening run from the history it left behind.
 *
 * The live poll tracks a streak incrementally: it notes when one began and
 * watches for a gap that ends it. That works while Tempo is watching, and only
 * then — a run that continued offline looks broken, and once broken there is
 * nothing to reverse, because the incremental record keeps no reason for its
 * answer.
 *
 * Deriving the run from timestamped history instead makes it a function of the
 * data. Filling a hole in the history and recomputing gives the right answer
 * without anything having to be undone, and the same code answers for observed
 * and recovered listening alike.
 */

import { STREAK_BREAK_MS } from "./streak-loss";

/**
 * One played track. `endedAt` rather than a bare timestamp because stored
 * history is stamped when a track finished, and the idle gap between two plays
 * is only visible once each play's own length is taken out of the interval.
 */
export interface PlayedTrack {
    songId: string;
    startedAt: number;
    endedAt: number;
}

export interface DerivedStreak {
    /** When the current unbroken run began, or null when there is none. */
    startedAt: number | null;
    /** How long it has been running as of `now`. */
    durationMs: number;
    /** How many plays it covers. */
    trackCount: number;
}

/**
 * The unbroken run of listening ending at `now`, if there is one.
 *
 * Walks back from the newest play while each successive gap stays under the
 * break threshold. The gap that matters is idle time — the space between one
 * track finishing and the next starting — not the interval between timestamps,
 * which mostly consists of the tracks themselves.
 *
 * `plays` may be in any order; it is sorted here rather than trusting callers,
 * since backfilled and observed plays arrive from different directions.
 */
export function deriveStreak(plays: PlayedTrack[], now: number): DerivedStreak {
    const none: DerivedStreak = { startedAt: null, durationMs: 0, trackCount: 0 };

    if (plays.length === 0)
        return none;

    const ordered = [...plays].sort((a, b) => a.endedAt - b.endedAt);
    const newest = ordered[ordered.length - 1];

    // Silence since the last thing they played ends the run, however long it was
    if (now - newest.endedAt >= STREAK_BREAK_MS)
        return none;

    let startedAt = newest.startedAt;
    let trackCount = 1;

    for (let i = ordered.length - 1; i > 0; i--) {
        const current = ordered[i];
        const previous = ordered[i - 1];

        // Overlapping or touching plays leave no idle time between them, and a
        // negative gap must not read as a break
        const idle = Math.max(0, current.startedAt - previous.endedAt);

        if (idle >= STREAK_BREAK_MS)
            break;

        startedAt = Math.min(startedAt, previous.startedAt);
        trackCount++;
    }

    return {
        startedAt,
        durationMs: now - startedAt,
        trackCount,
    };
}
