/**
 * What friends who are not listening right now were playing recently.
 *
 * The friends tab shows anyone currently playing something as a card with
 * artwork, and everybody else vanished into a row of avatars - so a friend who
 * listened all morning and stopped ten minutes ago looked exactly like one who
 * has not opened Spotify in a month. This is what fills that in.
 *
 * Grouped by friend rather than listed as one long feed of songs: a feed is
 * dominated by whoever listened most, and the question being answered is "what
 * has everyone been up to", not "what was played most recently overall".
 *
 * Pure, so the rules below can be tested without a database or a live session.
 */

/** One play, as the taste profile records it. */
export interface HistoryEntry {
    songId: string;
    sessionDuration: number;
    skipped: boolean;
    replayed: boolean;
    timestamp: number;
}

/** A friend and the history being considered for them. */
export interface ActivityCandidate {
    userId: string;
    username: string;
    pfpUrl?: string;
    pfpColourBlob?: string;
    /** Whether they are playing something at this moment. */
    isListening: boolean;
    /** Whether they have chosen to share what they listen to. */
    sharesListeningActivity: boolean;
    history: HistoryEntry[];
}

export interface RecentActivityTrack {
    songId: string;
    timestamp: number;
    replayed: boolean;
}

export interface FriendRecentActivity {
    userId: string;
    username: string;
    pfpUrl?: string;
    pfpColourBlob?: string;
    /** Newest first, capped. The artwork the UI fans out. */
    tracks: RecentActivityTrack[];
    /** When they last played anything, so the UI can say "2h ago". */
    lastPlayedAt: number;
    /** How many qualifying plays there were, which can exceed tracks.length. */
    playCount: number;
    /** Set when the most recent play was one they had on repeat. */
    onRepeat: boolean;
}

export interface RecentActivityOptions {
    /** How many tracks to keep per friend. The UI fans out at most four. */
    tracksPerFriend?: number;
    /** How far back still counts as recent. */
    maxAgeMs?: number;
    /** Treated as "now", so tests are not at the mercy of the clock. */
    now?: number;
}

/**
 * A play too short to mean anything.
 *
 * The same threshold the profile history uses. Somebody skipping through a
 * playlist generates a play per track touched, and showing those would report
 * that a friend "listened to" eleven songs they heard two seconds of. A replay
 * is kept regardless of length, because choosing to hear something again is a
 * deliberate act however long it lasted.
 */
function isMeaningful(entry: HistoryEntry): boolean {
    return (entry.sessionDuration >= 0.2 || entry.replayed);
}

const DEFAULT_TRACKS_PER_FRIEND = 4;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Builds the recent activity list, newest friend first.
 *
 * Friends with nothing worth showing are dropped rather than listed as empty:
 * a row that says a friend has done nothing is worse than that friend simply
 * not appearing, and they are already visible in the strip above.
 */
export function buildRecentActivity(
    candidates: ActivityCandidate[],
    options: RecentActivityOptions = {},
): FriendRecentActivity[] {
    const tracksPerFriend = options.tracksPerFriend ?? DEFAULT_TRACKS_PER_FRIEND;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = options.now ?? Date.now();

    const oldest = now - maxAgeMs;

    const built: FriendRecentActivity[] = [];

    for (const candidate of candidates) {
        // Someone playing something is already on a card above, and showing
        // them here as well would say they are both listening and not
        if (candidate.isListening)
            continue;

        // The same setting the live sessions honour. Somebody who has turned
        // sharing off has turned it off for what they played an hour ago too.
        if (!candidate.sharesListeningActivity)
            continue;

        const plays = candidate.history
            .filter(isMeaningful)
            // Guards against a clock ahead of ours as well as against history
            // older than the window: a timestamp in the future would otherwise
            // pin this friend to the top of the list forever
            .filter(v => v.timestamp >= oldest && v.timestamp <= now)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (plays.length === 0)
            continue;

        built.push({
            userId: candidate.userId,
            username: candidate.username,
            pfpUrl: candidate.pfpUrl,
            pfpColourBlob: candidate.pfpColourBlob,
            tracks: plays.slice(0, tracksPerFriend).map(v => ({
                songId: v.songId,
                timestamp: v.timestamp,
                replayed: v.replayed,
            })),
            lastPlayedAt: plays[0].timestamp,
            playCount: plays.length,
            onRepeat: plays[0].replayed,
        });
    }

    // Most recently active first, so the section reads as a timeline of who was
    // around. Ties break on name so the order cannot wobble between refreshes.
    return built.sort((a, b) => (b.lastPlayedAt - a.lastPlayedAt)
        || a.username.localeCompare(b.username, undefined, { sensitivity: "base" }));
}
