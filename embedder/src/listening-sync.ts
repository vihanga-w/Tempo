/**
 * Whether a pair of friends count as listening together, and when they stop.
 *
 * Kept apart from spotify.ts so it can be exercised directly: importing that
 * module starts the server.
 */

/**
 * How long a pair may be observed apart before they stop counting as in sync.
 *
 * Nothing observes two people at once. Each side's playback is read by its own
 * poll, on its own schedule, and a pair is compared using whichever snapshots
 * happen to be current — so a listener who has just moved on is compared
 * against a friend who has not been looked at since before they moved. Between
 * those two polls the pair look apart, and they are not: what changed is who
 * has been asked recently, not what anybody is playing.
 *
 * A poll of one user is deferred by at most MAX_REFRESH_RATE (spotify.ts —
 * a hundred seconds), so a snapshot is never more than that far behind. Waiting
 * that long before believing a divergence covers every ordering of the two
 * polls; anything still apart afterwards has been looked at since and really is.
 *
 * The two costs are not symmetric. Believing a divergence too early ends the
 * sync, and the pair re-announce themselves the moment the slower poll catches
 * up — which is the notification-per-track a Spotify Jam produced. Believing it
 * too late only delays a *fresh* sync being announced, for a pair who separated
 * and found each other again inside the same window.
 */
export const SYNC_DIVERGENCE_GRACE_MS = 100e3;

/**
 * What is remembered about a pair already known to be in sync.
 *
 * The song is carried for the log and for anyone reading the latch, and
 * deliberately not for the decision: a pair moving through a Jam together are
 * continuously in sync, and re-announcing them on each track is the same
 * mistake as re-announcing them on each poll.
 */
export interface SyncLatch {
    /** The song the pair were last seen sharing. */
    songId: string;
    /** When they were last seen on it. */
    matchedAt: number;
    /** When they were first seen apart since then. Absent while together. */
    divergedSince?: number;
}

export type SyncPairOutcome =
    /** They were not in sync and now are. This is the only one that notifies. */
    | "matched"
    /** In sync already, and seen together again. */
    | "together"
    /** In sync already, seen apart, but not for long enough to believe it. */
    | "waiting"
    /** Apart for longer than the grace allows: the sync has ended. */
    | "ended"
    /** Not in sync before, and no reason to think they are now. */
    | "apart";

export interface SyncPairResult {
    outcome: SyncPairOutcome;
    /** The latch to store, or undefined when there should not be one. */
    latch?: SyncLatch;
    /** Whether the pair count as in sync after this observation. */
    inSync: boolean;
    /** Whether this observation is what put them in sync, and so notifies. */
    notify: boolean;
    /** How much longer a held pair have before the grace runs out. */
    graceRemainingMs?: number;
}

/**
 * One pair, read against what was last known about them.
 *
 * `songId` is the song both sides were just observed playing, or undefined for
 * every other case — a different song each, one of them stopped, sharing
 * switched off, no session. Which of those it was does not change the decision,
 * only the log, so the caller keeps the reason and this takes the verdict.
 *
 * The grace is applied on the way in as well as on the way out. A latch left
 * behind by a pair who drifted apart is only cleared when something evaluates
 * them again, and nothing is guaranteed to: both may simply have stopped. So an
 * expired latch found at a match is not a match being suppressed — it is a dead
 * latch, and the pair are newly in sync.
 */
export function reconcileSyncPair(
    latch: SyncLatch | undefined,
    songId: string | undefined,
    now: number,
    graceMs: number = SYNC_DIVERGENCE_GRACE_MS,
): SyncPairResult {
    const expired = (latch?.divergedSince !== undefined && now - latch.divergedSince >= graceMs);
    const held = (latch !== undefined && !expired);

    if (songId !== undefined) {
        // Seen together: the divergence clock is dropped rather than paused,
        // since the gap it was measuring has been closed by an observation.
        return {
            outcome: (held ? "together" : "matched"),
            latch: { songId, matchedAt: now },
            inSync: true,
            notify: !held,
        };
    }

    if (latch === undefined)
        return { outcome: "apart", latch: undefined, inSync: false, notify: false };

    if (expired)
        return { outcome: "ended", latch: undefined, inSync: false, notify: false };

    // Started at the first sighting rather than reset on each one, so a pair
    // polled repeatedly while apart still time out at the same moment.
    const divergedSince = latch.divergedSince ?? now;

    return {
        outcome: "waiting",
        latch: { ...latch, divergedSince },
        inSync: true,
        notify: false,
        graceRemainingMs: Math.max(0, graceMs - (now - divergedSince)),
    };
}
