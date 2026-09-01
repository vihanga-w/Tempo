/**
 * Ranking friends by how much they have listened.
 *
 * The measure matches the one the weekly stats endpoint already reports —
 * session duration against each track's length, skips excluded — so a listener's
 * position and their own weekly figure cannot disagree. Two definitions of "time
 * listened" in one app is one too many.
 */

export interface LeaderboardHistoryItem {
    songId: string;
    sessionDuration: number;
    skipped: boolean;
    timestamp: number;
}

export interface Period {
    start: number;
    end: number;
}

export interface LeaderboardCandidate {
    userId: string;
    displayName: string;
    imageUrl?: string;
    /** Their picture reduced to sixteen colours; see profile-blob.ts. */
    imageColourBlob?: string;
    history: LeaderboardHistoryItem[];
    /** False when this listener has activity sharing switched off. */
    sharing: boolean;
    /** The person reading the board, who appears whatever their settings say. */
    isViewer?: boolean;
}

export interface LeaderboardEntry {
    userId: string;
    displayName: string;
    imageUrl?: string;
    /**
     * Drawn until the picture arrives.
     *
     * A board is a column of faces that all load at once, which is the worst
     * case for the hole-then-pop the blob exists to avoid — and it was the one
     * list not being sent one.
     */
    imageColourBlob?: string;
    listeningMs: number;
    uniqueSongs: number;
    /** Shared by equal totals, so two in second place are followed by fourth. */
    position: number;
    isViewer: boolean;
}

export interface ListeningTotal {
    listeningMs: number;
    uniqueSongs: number;
}

/**
 * How long someone spent listening over a period.
 *
 * A skipped track contributes nothing. It was played, but counting the seconds
 * before it was abandoned would let someone climb by rejecting music quickly,
 * which is the opposite of what the board is measuring.
 *
 * A track with no cached metadata is left out rather than guessed at: its length
 * is what turns a fraction into a duration, and without it there is no figure to
 * add.
 */
export function listeningTimeMs(
    history: LeaderboardHistoryItem[],
    durationFor: (songId: string) => number | undefined,
    period: Period,
): ListeningTotal {
    const songs = new Set<string>();

    let listeningMs = 0;

    for (const item of history) {
        if (item.timestamp < period.start || item.timestamp > period.end)
            continue;

        if (item.skipped)
            continue;

        const duration = durationFor(item.songId);

        if (duration === undefined || duration <= 0)
            continue;

        listeningMs += Math.min(1, Math.max(0, item.sessionDuration)) * duration;
        songs.add(item.songId);
    }

    return { listeningMs, uniqueSongs: songs.size };
}

/**
 * Builds the board.
 *
 * Someone who has switched activity sharing off is left out entirely rather than
 * shown without a figure: a total is exactly the kind of thing that setting
 * exists to withhold, and a name with a blank beside it still discloses that
 * they were listening. The reader is always present, since their own listening
 * is theirs to see.
 *
 * Friends with nothing this period are kept, at the bottom. Dropping them would
 * make the board quietly shrink over a quiet week and leave people wondering
 * where everyone went.
 */
export function buildLeaderboard(
    candidates: LeaderboardCandidate[],
    durationFor: (songId: string) => number | undefined,
    period: Period,
): LeaderboardEntry[] {
    const totals = candidates
        .filter(c => c.sharing || c.isViewer)
        .map(c => ({
            userId: c.userId,
            displayName: c.displayName,
            imageUrl: c.imageUrl,
            imageColourBlob: c.imageColourBlob,
            isViewer: (c.isViewer === true),
            ...listeningTimeMs(c.history, durationFor, period),
        }));

    // Name breaks a tie, so the order is the same on every request rather than
    // whatever order the profiles happened to load in
    totals.sort((a, b) => (
        b.listeningMs - a.listeningMs ||
        a.displayName.localeCompare(b.displayName) ||
        a.userId.localeCompare(b.userId)
    ));

    let position = 0;
    let previousMs: number | undefined;

    return totals.map((entry, index) => {
        if (previousMs === undefined || entry.listeningMs !== previousMs) {
            position = index + 1;
            previousMs = entry.listeningMs;
        }

        return { ...entry, position };
    });
}
