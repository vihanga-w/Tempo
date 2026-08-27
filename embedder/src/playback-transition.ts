/**
 * Reading one playback poll against the last, and deciding what changed.
 *
 * The decisions live here rather than inline in the poll loop so they can be
 * exercised without starting a server, and so the ordering between them — which
 * is what a single poll observing several changes at once depends on — is
 * stated in one place.
 */

/** Below this much of a track played, moving on counts as a skip. */
export const SKIP_BELOW_PROGRESS = 0.75;

/** A replay is the same track restarting from near the beginning... */
export const REPLAY_RESTARTED_BELOW = 0.2;
/** ...having previously been played at least this far through. */
export const REPLAY_PREVIOUSLY_ABOVE = 0.65;

/**
 * How far the wall clock may disagree with "the playhead went round" and still
 * be read that way.
 *
 * The two things being told apart differ by a whole track, so the window only
 * has to cover the ways the two numbers fail to line up exactly: Spotify
 * reports a position that is a moment stale by the time the poll is stamped,
 * the two polls are stale by different amounts, and there is a beat of silence
 * or a crossfade between one track and the next. Simulated against the real
 * track lengths out of two accounts' histories, detection is still climbing at
 * a second, level from two and a half, and flat out to ten:
 *
 *      +/- 1s   70%      +/- 3s   86%      +/- 10s  86%
 *      +/- 2s   85%      +/- 5s   86%      +/- 45s  89%
 *
 * Five seconds sits in the flat part with about twice the headroom the noise
 * needs. Past ten the only thing a wider window buys is tolerating a pause
 * between the two plays, and it starts costing precision on fast polling.
 */
export const REPLAY_CLOCK_TOLERANCE_MS = 5000;

/**
 * Below this the wrap and the no-wrap readings are not far enough apart to tell
 * apart at all: they are a track's length apart, so a track has to be several
 * tolerances long before the answer means anything.
 */
export const REPLAY_CLOCK_MIN_DURATION_MS = REPLAY_CLOCK_TOLERANCE_MS * 4;

export type SyncTrigger = "song-started" | "song-changed" | "play-state-changed" | "stopped";

/** Only the fields the transition decisions actually read. */
export interface PlaybackSnapshot {
    songId: string;
    isPlaying: boolean;
    progressNormal: number;
    /**
     * The furthest through this track the current play has been seen, which is
     * not the same as where it was last seen.
     *
     * Polls are spaced by how much the listener usually plays in an hour, up to
     * MAX_REFRESH_RATE — a hundred seconds. On a three minute track that is over
     * half its length per sample, so the last poll before a restart lands
     * wherever it lands. Judging "was this played far enough to count" on that
     * one sample throws away everything already known about the play.
     *
     * Optional so a caller that does not track it keeps the previous behaviour:
     * absent, the last sampled position is used, which is what this compared
     * against before.
     */
    maxProgressNormal?: number;
    /** When this poll ran, epoch ms. Only used with durationMs. */
    sampledAt?: number;
    /** The track's length in ms. Only used with sampledAt. */
    durationMs?: number;
}

export interface PlaybackTransition {
    /** Nothing is playing any more. Everything else is skipped in this case. */
    stopped: boolean;
    /** Playback began where there was no previous state. */
    started: boolean;
    /** A different track to last time. */
    songChanged: boolean;
    /** The previous track was abandoned early. Implies songChanged. */
    skipped: boolean;
    /** The previous track was seen through. Implies songChanged. */
    listened: boolean;
    /** Play/pause toggled. */
    playStateChanged: boolean;
    /** The same track restarted from the top after being played most of the way. */
    replayed: boolean;
    /** Which listening-sync evaluation this poll should run, if any. */
    syncTrigger?: SyncTrigger;
    /** Broadcasts this poll emits, in order. */
    actions: string[];
}

/**
 * What changed between two polls.
 *
 * A single poll can see more than one change — a track can change and pause in
 * the same interval — so these are not exclusive. Where several would each ask
 * for a sync evaluation, the last one wins, matching the order the poll loop
 * applies them in: started, then changed, then play state.
 */
export function classifyPlaybackTransition(
    prev: PlaybackSnapshot | undefined,
    next: PlaybackSnapshot | undefined,
): PlaybackTransition {
    const transition: PlaybackTransition = {
        stopped: false,
        started: false,
        songChanged: false,
        skipped: false,
        listened: false,
        playStateChanged: false,
        replayed: false,
        actions: [],
    };

    // Nothing playing ends the poll outright: the loop returns before any of the
    // comparisons below, so no other transition can be reported alongside it.
    if (!next) {
        transition.stopped = true;
        transition.syncTrigger = "stopped";
        transition.actions.push("STOPPED");

        return transition;
    }

    if (next.isPlaying) {
        if (!prev) {
            transition.started = true;
            transition.syncTrigger = "song-started";
        }

        // Emitted on every poll where something is playing, not only on a change
        transition.actions.push("PLAYING:" + next.songId);
    }

    if (!prev)
        return transition;

    if (prev.songId !== next.songId) {
        transition.songChanged = true;
        transition.syncTrigger = "song-changed";

        if (prev.progressNormal < SKIP_BELOW_PROGRESS) {
            transition.skipped = true;
            transition.actions.push("SKIPPED:" + prev.songId);
        } else {
            transition.listened = true;
            transition.actions.push("LISTENED:" + prev.songId);
        }
    }

    if (prev.isPlaying !== next.isPlaying) {
        transition.playStateChanged = true;
        transition.syncTrigger = "play-state-changed";

        transition.actions.push(`${next.isPlaying ? "PLAYING" : "PAUSED"}:${next.songId ?? prev.songId}`);
    }

    /*
     * Only meaningful on the same track: a different track restarting is simply
     * the next song, which the change above has already accounted for.
     *
     * There are two ways to see a replay, and they fail in different places.
     *
     * The first is to watch the progress bar. It has to land near the top, so a
     * rewind of a few seconds mid-track is not a replay; it has to have moved
     * backwards, so ordinary forward progress cannot re-fire this on every
     * poll; and the play has to have reached far enough in to be worth
     * repeating, measured against the furthest point reached rather than the
     * last one sampled. The policy is unchanged: about two thirds through.
     *
     * What it cannot do is see anything between two polls. At MAX_REFRESH_RATE
     * a poll covers a hundred seconds, over half a three minute track, so on a
     * straight play-through-then-replay there is frequently no sample near the
     * end and none near the top afterwards either. Simulated at that cadence it
     * catches under a fifth of them.
     */
    const reachedThisPlay = Math.max(prev.progressNormal, prev.maxProgressNormal ?? prev.progressNormal);

    const replayedByProgress = (
        next.progressNormal < REPLAY_RESTARTED_BELOW &&
        next.progressNormal < prev.progressNormal &&
        reachedThisPlay > REPLAY_PREVIOUSLY_ABOVE
    );

    /*
     * The second is to check the playhead against the clock, and it does not
     * care where in the track either sample landed.
     *
     * Between two polls of the same track the playhead either went straight
     * from one position to the other, or it ran off the end and came back round
     * — and those two stories take exactly one track's length of wall clock
     * more or less than each other. So the elapsed time says which happened,
     * for any pair of positions, including the ones the progress test above
     * cannot read anything into.
     *
     * Ordinary playback and a jump backwards both come out as no wrap, which is
     * what keeps a seek to the top of a track from reading as a play-through:
     * a seek takes no time, and going round takes the rest of the track.
     */
    const elapsedMs = (prev.sampledAt !== undefined && next.sampledAt !== undefined
        ? next.sampledAt - prev.sampledAt
        : undefined);

    const wentRoundOnce = (
        elapsedMs !== undefined &&
        next.durationMs !== undefined &&
        next.durationMs >= REPLAY_CLOCK_MIN_DURATION_MS &&
        Math.abs(
            elapsedMs - ((next.progressNormal - prev.progressNormal) * next.durationMs + next.durationMs),
        ) <= REPLAY_CLOCK_TOLERANCE_MS
    );

    if (prev.songId === next.songId && (replayedByProgress || wentRoundOnce)) {
        transition.replayed = true;
        transition.actions.push("REPLAYED:" + prev.songId);
    }

    return transition;
}
