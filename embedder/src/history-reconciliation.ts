/**
 * Deciding when to go and look at Spotify's play history.
 *
 * Listening Tempo could not see has to be fetched rather than observed, and the
 * obvious moment — the first song after a silence — is not enough on its own.
 * Play history is stamped when Spotify receives it, and a device that was
 * offline may not report for some time after it reconnects, so a check made the
 * instant someone starts playing again can easily run before the thing it is
 * looking for has arrived.
 *
 * Checking periodically as they listen catches those late deliveries. Checking
 * too often spends Spotify quota on nothing, which is the same budget the
 * playback poll is already rationing, so the two conditions here are a count of
 * songs played and a floor on how often a check may happen at all.
 */

/** Songs played between checks, when nothing more urgent has happened. */
export const RECONCILE_EVERY_EVENTS = 5;

/** No user is checked more often than this, whatever else is true. */
export const RECONCILE_MIN_INTERVAL_MS = 5 * 60e3;

/** Per user, what has happened since the last check. */
export interface ReconciliationState {
    /** Song changes seen since the last check. */
    eventsSinceLastRun: number;
    /** When the last check ran, or 0 if never. */
    lastRunAt: number;
    /**
     * The newest play already accounted for. Everything at or before this has
     * been seen, so a later check can ignore it however many times it reappears.
     */
    lastImportedPlayedAt: number;
}

export type ReconcileReason =
    | "no-scope"
    | "too-soon"
    | "waiting-for-events"
    | "enough-events"
    | "returned-from-silence";

export interface ReconcileDecision {
    run: boolean;
    reason: ReconcileReason;
}

export function newReconciliationState(): ReconciliationState {
    return { eventsSinceLastRun: 0, lastRunAt: 0, lastImportedPlayedAt: 0 };
}

/** Counts a song change towards the next check. */
export function recordSongEvent(state: ReconciliationState): ReconciliationState {
    return { ...state, eventsSinceLastRun: state.eventsSinceLastRun + 1 };
}

/**
 * Whether to check this user's play history now.
 *
 * `returnedFromSilence` marks the first song after a gap long enough that
 * listening could have happened unseen. It is the reason to check at all, so it
 * does not wait for a count — but it still respects the interval floor, because
 * someone toggling playback repeatedly would otherwise trigger a check each
 * time.
 */
export function shouldReconcile(
    state: ReconciliationState,
    context: { now: number; hasScope: boolean; returnedFromSilence?: boolean },
): ReconcileDecision {
    // Without the scope the request can only be refused, so it is not worth
    // making. An account authorised before Tempo asked for it will never have it
    // until it authorises again.
    if (!context.hasScope)
        return { run: false, reason: "no-scope" };

    if (context.now - state.lastRunAt < RECONCILE_MIN_INTERVAL_MS)
        return { run: false, reason: "too-soon" };

    if (context.returnedFromSilence)
        return { run: true, reason: "returned-from-silence" };

    if (state.eventsSinceLastRun >= RECONCILE_EVERY_EVENTS)
        return { run: true, reason: "enough-events" };

    return { run: false, reason: "waiting-for-events" };
}

/**
 * Records that a check happened.
 *
 * The watermark only ever moves forward. A check that found nothing new, or that
 * returned an older page than the last one, must not walk it backwards and
 * cause everything after it to be imported a second time.
 */
export function recordReconciliation(
    state: ReconciliationState,
    context: { now: number; importedThrough?: number },
): ReconciliationState {
    return {
        eventsSinceLastRun: 0,
        lastRunAt: context.now,
        lastImportedPlayedAt: Math.max(state.lastImportedPlayedAt, context.importedThrough ?? 0),
    };
}

/** Whether a play has already been accounted for by an earlier check. */
export function alreadyAccountedFor(state: ReconciliationState, playedAt: number): boolean {
    return playedAt <= state.lastImportedPlayedAt;
}
