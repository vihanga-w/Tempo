import type { HistoryEntry } from "./user-taste";

/**
 * Turning Apple Music's recently played list into plays.
 *
 * Apple offers no feed of plays. GET /v1/me/recent/played/tracks answers with
 * the last 30 tracks, newest first, and nothing else: no time a track was
 * played, no id for the play itself. So a play is recognised by the list
 * changing, and its time is worked out from when the change was seen.
 *
 * Two things about the list are not documented, and this is written to be
 * right either way:
 *
 * - Whether a track played again appears twice, or moves to the top. Both
 *   leave the new play in front of what the list held last time.
 * - How far back it goes past 30. Only the first page is read.
 *
 * Under the second behaviour, replaying the newest track changes nothing, and
 * cannot be seen.
 */

/** How much of the previous list has to line up for it to be found again. */
const ANCHOR_LENGTH = 3;

export interface NewPlays {
    /** The new plays' track ids, newest first. */
    ids: string[];
    /**
     * Whether the list was found again at all. When it was not, more than a
     * page was played between two reads, or the list was rearranged, and plays
     * may have been missed. Only tracks the previous list did not hold at all
     * are counted then: a rearranged list would otherwise count its every
     * track again, at the cost of a replay played during the gap.
     */
    gap: boolean;
}

/**
 * What was played between two reads of the recently played list.
 *
 * @param previous the list as last read, newest first
 * @param current the list as read now, newest first
 *
 * The new plays are whatever sits in front of the previous list's newest
 * tracks. Looking for a run of them rather than the newest alone is what keeps
 * a replay from hiding: a track played again is at the top of both lists, and
 * only what follows it says whether that is the same play or a new one.
 */
export function newPlays(previous: string[], current: string[]): NewPlays {
    if (current.length === 0)
        return { ids: [], gap: false };

    if (previous.length === 0)
        return { ids: [...current], gap: true };

    for (let start = 0; start < current.length; start++) {
        const played = new Set(current.slice(0, start));

        // If a track played again moves to the top rather than being listed
        // twice, it has also left its old place, which may be in the run being
        // looked for
        const candidates = [previous, previous.filter(id => !played.has(id))];

        if (candidates.some(candidate => startsAt(current, start, candidate)))
            return { ids: current.slice(0, start), gap: false };
    }

    const seen = new Set(previous);

    return { ids: current.filter(id => !seen.has(id)), gap: true };
}

/**
 * Whether `current` from `start` begins the way `previous` does.
 *
 * A run of ANCHOR_LENGTH has to line up, or all that is left of either list.
 * A single matching track is a coincidence often enough not to count unless
 * nothing longer could possibly match.
 */
function startsAt(current: string[], start: number, previous: string[]) {
    const length = Math.min(ANCHOR_LENGTH, previous.length, current.length - start);

    if (length === 0)
        return false;

    const reachesEnd = (start + length === current.length || length === previous.length);

    if (length < ANCHOR_LENGTH && !reachesEnd)
        return false;

    for (let i = 0; i < length; i++) {
        if (current[start + i] !== previous[i])
            return false;
    }

    return true;
}

export interface TimedPlay {
    id: string;
    /** When the play ended, as best as can be told. */
    endedAt: number;
}

/**
 * When each new play ended, newest first.
 *
 * Nothing says, so the newest is put at `now` and each older one ends where the
 * one after it began. Plays between two reads happened after the first read,
 * so none is put before `since` — they are squeezed up against it instead,
 * since a listener who skipped through them took less time than the songs'
 * lengths. After a gap there is no such floor.
 *
 * @param durations each play's song length in milliseconds, in the same order
 */
export function timePlays(ids: string[], durations: number[], now: number, since: number | undefined): TimedPlay[] {
    const plays: TimedPlay[] = [];
    let end = now;

    for (let i = 0; i < ids.length; i++) {
        const endedAt = (since !== undefined ? Math.max(end, since + (ids.length - i)) : end);

        plays.push({ id: ids[i], endedAt: Math.min(endedAt, now) });

        end = endedAt - Math.max(0, durations[i] ?? 0);
    }

    return plays;
}

/**
 * `history` with an imported play in its place, or `history` itself when the
 * play is already there.
 *
 * History is newest first, and a live play is always the newest thing in it.
 * An imported one arrives after the fact, so it goes where its time puts it.
 *
 * Already there means the same song ending within `overlapMs`: somebody with
 * both services linked playing one song on both, or on a device each service
 * reports, is one play.
 */
export function withImportedPlay(history: HistoryEntry[], play: HistoryEntry, overlapMs: number): HistoryEntry[] {
    const duplicate = history.some(entry =>
        entry.songId === play.songId && Math.abs(entry.timestamp - play.timestamp) <= overlapMs);

    if (duplicate)
        return history;

    let index = history.findIndex(entry => entry.timestamp <= play.timestamp);

    if (index === -1)
        index = history.length;

    return [...history.slice(0, index), play, ...history.slice(index)];
}
