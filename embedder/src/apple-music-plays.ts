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
 * The new plays are whatever sits in front of the previous list. All of what
 * is left of the previous list has to follow them — not just its newest few
 * tracks, which a replay of an album from the top repeats in the same order,
 * and would be taken for the old list with the replay unseen.
 */
export function newPlays(previous: string[], current: string[]): NewPlays {
    if (current.length === 0)
        return { ids: [], gap: false };

    for (let start = 0; start <= current.length; start++) {
        const played = new Set(current.slice(0, start));

        // If a track played again moves to the top rather than being listed
        // twice, it has also left its old place in what follows
        const candidates = [previous, previous.filter(id => !played.has(id))];

        if (candidates.some(candidate => continues(current, start, candidate)))
            return { ids: current.slice(0, start), gap: false };
    }

    const seen = new Set(previous);

    return { ids: current.filter(id => !seen.has(id)), gap: true };
}

/**
 * Whether `current` from `start` is `previous`, for as much of it as there is
 * room for — the oldest of it falls off the end as new plays push it along.
 *
 * With nothing of `previous` left in view, everything in `current` is new:
 * that is a whole page played between two reads, and `previous` gone.
 */
function continues(current: string[], start: number, previous: string[]) {
    const length = Math.min(previous.length, current.length - start);

    if (length === 0)
        return (previous.length === 0 && start === current.length);

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
    /**
     * How much of the song it can have lasted, 0 to 1. Less than all of it only
     * when the songs add up to more than the time they were played in: somebody
     * skipping through. The history's sessionDuration.
     */
    fraction: number;
}

/**
 * What a play is taken to have lasted when Apple does not say: about a song's
 * length. Only ever used to space plays apart.
 */
const UNKNOWN_DURATION_MS = 210e3;

/**
 * How much longer than the plays themselves the time since the last read can
 * be before where in it they happened is anybody's guess.
 */
const LONG_ABSENCE_MS = 30 * 60e3;

/**
 * When each new play ended, newest first, and how much of it was played.
 *
 * Nothing says, so it is worked out from when the list changed:
 *
 * - Between two reads, the newest ends at `now`, and each older one where the
 *   one after it began, squeezed alike if need be so that none ends before
 *   `since`, when the list was last read without them.
 * - How much of each was played is judged more loosely. Whether Apple lists a
 *   play when it starts or when it ends is not documented, and either way one
 *   song can straddle a read: the oldest begun before it, or the newest still
 *   playing after. So the plays are allowed the time between reads plus the
 *   longest song's length, and count as less than whole only when they add up
 *   to more than that — somebody skipping through, not a song longer than
 *   three minutes.
 * - After a gap, or a long absence — the server down, a refused token waiting
 *   days for a new one — nothing is known but that they happened after
 *   `since`, so they are spread evenly across that time rather than piled up
 *   at its end. A token that lapsed on Monday and came back on Friday is a
 *   week of plays, not an hour of them.
 * - With no `since`, back from `now` by length.
 *
 * @param durations each play's song length in milliseconds, in the same order
 */
export function timePlays(ids: string[], durations: number[], now: number, since: number | undefined, gap = false): TimedPlay[] {
    const lengths = ids.map((_, i) => (durations[i] && durations[i] > 0 ? durations[i] : UNKNOWN_DURATION_MS));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const room = (since !== undefined ? now - since : Infinity);

    const spread = (since !== undefined && room > 0 && ids.length > 0
        && (gap || room > total + LONG_ABSENCE_MS));

    if (spread) {
        const step = room / ids.length;

        return ids.map((id, i) => ({ id, endedAt: Math.round(now - step * i), fraction: 1 }));
    }

    // The oldest play's own length does not separate it from anything
    const spacing = total - (lengths[lengths.length - 1] ?? 0);
    const placeScale = (spacing > room && spacing > 0 ? Math.max(0, room) / spacing : 1);

    const allowed = room + Math.max(0, ...lengths);
    const fraction = (total > allowed && total > 0 ? Math.max(0, allowed) / total : 1);

    const plays: TimedPlay[] = [];
    let end = now;

    for (let i = 0; i < ids.length; i++) {
        plays.push({ id: ids[i], endedAt: Math.round(end), fraction: Math.min(1, fraction) });

        end -= lengths[i] * placeScale;
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
 * Already there means the same song from the other service ending within
 * `overlapMs`: somebody with both linked playing one song on both, or on a
 * device each service reports, is one play.
 */
export function withImportedPlay(history: HistoryEntry[], play: HistoryEntry, overlapMs: number): HistoryEntry[] {
    // Only a play from another service can be this one heard twice; the same
    // service reporting the same song close together is somebody replaying it
    const duplicate = history.some(entry =>
        entry.songId === play.songId
        && (entry.source ?? "spotify") !== (play.source ?? "spotify")
        && Math.abs(entry.timestamp - play.timestamp) <= overlapMs);

    if (duplicate)
        return history;

    let index = history.findIndex(entry => entry.timestamp <= play.timestamp);

    if (index === -1)
        index = history.length;

    return [...history.slice(0, index), play, ...history.slice(index)];
}

/** What correcting an imported play did to history. */
export interface Retimed {
    history: HistoryEntry[];
    /** The play as it was, when there was one to correct. */
    before?: HistoryEntry;
    /** The play as it is now; absent when it turned out to be a duplicate and was dropped. */
    after?: HistoryEntry;
}

/**
 * Replaces an imported play's estimated time with a real one.
 *
 * For times that arrive after the poll has already recorded the play — the
 * phone seeing a song end, or its library, read when iOS next lets Tempo run.
 * The play to correct is the one from the same service, of the same song,
 * still marked estimated, nearest the real time: no more than `windowMs`
 * after it, and barely before it, since the poll only ever notices a play
 * once it has happened — except a play recorded while still going
 * (`openEnded`), whose recorded time can be up to the song's length before
 * its end. Any other play that ended well before the real time is an earlier
 * play of the song, not this one.
 *
 * `patch` carries what else is now known — how much was heard. At its real
 * time the play may turn out to be one the other service already recorded,
 * within `overlapMs`: the same play heard twice, and it is dropped.
 */
export function retimeImportedPlay(
    history: HistoryEntry[],
    songId: string,
    endedAt: number,
    windowMs: number,
    overlapMs = 0,
    patch: Partial<Pick<HistoryEntry, "sessionDuration" | "skipped">> = {},
    durationMs = 0,
): Retimed {
    let index = -1;
    let distance = Infinity;

    history.forEach((entry, i) => {
        if (entry.songId !== songId || entry.source !== "appleMusic" || !entry.estimated)
            return;

        const d = entry.timestamp - endedAt;
        const early = RETIME_EARLY_SLACK_MS + (entry.openEnded ? Math.max(durationMs, UNKNOWN_DURATION_MS) : 0);

        if (d < -early || d > windowMs)
            return;

        if (Math.abs(d) < distance) {
            index = i;
            distance = Math.abs(d);
        }
    });

    if (index === -1)
        return { history };

    const before = history[index];
    const after: HistoryEntry = { ...before, ...patch, timestamp: endedAt, estimated: false, openEnded: undefined };
    const rest = [...history.slice(0, index), ...history.slice(index + 1)];

    const duplicate = rest.some(entry => entry.songId === songId
        && (entry.source ?? "spotify") !== "appleMusic"
        && Math.abs(entry.timestamp - endedAt) <= overlapMs);

    if (duplicate)
        return { history: rest, before };

    let at = rest.findIndex(entry => entry.timestamp <= endedAt);

    if (at === -1)
        at = rest.length;

    return { history: [...rest.slice(0, at), after, ...rest.slice(at)], before, after };
}

/** How far before a real end the poll's estimate can be: its reads are timed by the server, the phone's by arrival. */
const RETIME_EARLY_SLACK_MS = 60e3;
