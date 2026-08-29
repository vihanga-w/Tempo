/**
 * How long a song a listener rejected stays out of their recommendations.
 *
 * Taken from the taste-profile half of Discover, which has had this since it
 * shipped: the friend half had nothing, so a listener could swipe a friend's
 * pick away and meet it again on the next page — and because the friend kept
 * playing it, its recency score kept it near the top. The dislike button did
 * nothing at all for a friend-sourced card.
 *
 * The thresholds are graded rather than absolute so that one bad swipe is not a
 * life sentence. A single negative rating clears a song for the day. Getting rid
 * of it for a week takes several, and for a month it takes a great many — a
 * listener who keeps saying no is answered proportionately, and one who taps the
 * wrong thing once sees it again tomorrow.
 */
export const AFFINITY_WINDOWS = [
    { name: "day", within: 24 * 3600e3, rejectBelow: 0 },
    { name: "week", within: 7 * 24 * 3600e3, rejectBelow: -3 },
    { name: "month", within: 30 * 24 * 3600e3, rejectBelow: -12 },
] as const;

export interface AffinityEntry {
    songId: string;
    affinity: number;
    timestamp: number;
}

/**
 * A test for songs the listener has said no to, built once per request.
 *
 * One pass over the history rather than one scan per candidate: the pool is
 * thousands of songs and the history grows without bound, so the naive form is
 * a product of the two.
 */
export function rejectedSongs(history: AffinityEntry[], now = Date.now()): (songId: string) => boolean {
    const totals = AFFINITY_WINDOWS.map(() => new Map<string, number>());

    for (const entry of history) {
        const age = now - entry.timestamp;

        // A rating from the future is a clock disagreement, not a rating.
        if (age < 0)
            continue;

        for (const [i, window] of AFFINITY_WINDOWS.entries()) {
            if (age <= window.within)
                totals[i].set(entry.songId, (totals[i].get(entry.songId) ?? 0) + entry.affinity);
        }
    }

    return (songId: string) => AFFINITY_WINDOWS.some(
        (window, i) => (totals[i].get(songId) ?? 0) < window.rejectBelow);
}
