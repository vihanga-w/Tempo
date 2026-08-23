/**
 * Deciding when a listening streak has ended, and how long it was.
 *
 * Kept apart from spotify.ts so it can be exercised directly: importing that
 * module starts the server.
 */

/** A gap of this long since the last activity ends a streak. */
export const STREAK_BREAK_MS = 600e3;

export interface StreakLossInput {
    /** When the current run began, or -1 when no run is in progress. */
    lastPlaySessionStart: number;
    /** Timestamp of the newest history item, or -2 when there is no history. */
    prevItemTimestamp: number;
    /** When something interesting last happened for this user. */
    interestingEventTimestamp: number;
    /** The poll interval this user is currently on. */
    nextRefreshTimeout: number;
    /** When this user is next due to be polled. */
    nextRefresh: number;
    now: number;
}

export interface StreakLossResult {
    /** The run has ended: record it and clear the bookkeeping. */
    lost: boolean;
    /** How long the run actually lasted. Zero when there is nothing to record. */
    durationMs: number;
}

/**
 * Whether a streak has ended, and its true length.
 *
 * The decision is made against a padded timestamp — the last activity plus the
 * interval this user is polled at — because playback is only observed when the
 * poll runs. Without that tolerance a streak would be declared lost merely
 * because nobody had looked recently.
 *
 * The duration is deliberately *not* measured from that padded timestamp. The
 * padding is an allowance for when we looked, not time the user spent
 * listening, and folding it into the recorded length overstated every streak by
 * up to one poll interval. It showed up as fractional milliseconds in the
 * recorded values, since nextRefreshTimeout is a division while every timestamp
 * involved is an integer.
 */
export function evaluateStreakLoss(input: StreakLossInput): StreakLossResult {
    const lastActivity = Math.max(input.prevItemTimestamp, input.interestingEventTimestamp);
    const refreshOffset = Math.max(input.nextRefreshTimeout, input.nextRefresh - input.now);
    const checkTime = lastActivity + Math.max(refreshOffset, 0);

    const lost = (
        input.lastPlaySessionStart !== -1 &&
        checkTime > 0 &&
        input.now - checkTime >= STREAK_BREAK_MS &&
        checkTime > input.lastPlaySessionStart
    );

    if (!lost)
        return { lost: false, durationMs: 0 };

    // Clamped: a run whose last activity precedes its start has no length worth
    // recording, but its bookkeeping still needs clearing.
    return { lost: true, durationMs: Math.max(0, lastActivity - input.lastPlaySessionStart) };
}
