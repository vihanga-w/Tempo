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

export type SyncTrigger = "song-started" | "song-changed" | "play-state-changed" | "stopped";

/** Only the fields the transition decisions actually read. */
export interface PlaybackSnapshot {
    songId: string;
    isPlaying: boolean;
    progressNormal: number;
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

    // Only meaningful on the same track: a different track restarting is simply
    // the next song, which the change above has already accounted for.
    if (
        prev.songId === next.songId &&
        next.progressNormal < REPLAY_RESTARTED_BELOW &&
        prev.progressNormal > REPLAY_PREVIOUSLY_ABOVE
    ) {
        transition.replayed = true;
        transition.actions.push("REPLAYED:" + prev.songId);
    }

    return transition;
}
