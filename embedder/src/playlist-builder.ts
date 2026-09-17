import { playConfidence, type FriendPlay } from "./friend-discovery";
import type { UserTaste } from "./user-taste";

/**
 * Playlists, built from what only Tempo knows.
 *
 * Spotify can make a playlist from a taste. What it cannot see is what Tempo
 * records: how a listener rated a song in Discover and how hard, how much of
 * each play they and their friends actually heard, and who put what on
 * repeat. A playlist here is built from those, and every song in it carries
 * the reason it is there — "Maya had this on repeat", "you liked this on
 * Tuesday" — which is the part a Spotify playlist never has.
 *
 * Four recipes, one scoring model:
 *
 *   - liked:    songs liked in Discover. A like never becomes a play, so this
 *               pile exists nowhere else.
 *   - friends:  what friends put on repeat or played through this week.
 *   - returned: songs the listener came back to after a gap, which is the
 *               most honest "I like this" a play history holds.
 *   - mix:      everything above, weighed together.
 *
 * One rule holds across all of them: the newest word wins, and a word against
 * a song keeps it out. A like followed by a skip was a wrong like, a pass
 * followed by a replay was a change of mind, and summing them would say
 * neither. The taste embedding only down-weights a pass; a playlist that kept
 * a song somebody had just swiped away has failed at the one thing it is for.
 */

export type PlaylistRecipe = "liked" | "friends" | "returned" | "mix";

export const RECIPES: Record<PlaylistRecipe, { name: string; blurb: string }> = {
    liked: { name: "Liked in Discover", blurb: "Everything you swiped right on, newest first." },
    friends: { name: "On repeat with friends", blurb: "What your friends kept playing this week." },
    returned: { name: "Songs you came back to", blurb: "The ones you returned to after a while away." },
    mix: { name: "Your mix", blurb: "Likes, your plays and your friends', weighed together." },
};

export function isRecipe(value: unknown): value is PlaylistRecipe {
    return typeof value === "string" && value in RECIPES;
}

/** A friend's play, with who it was: a playlist says whose it was. */
export interface PlaylistFriendPlay extends FriendPlay {
    userId: string;
    username: string;
}

export type PlaylistReason =
    | { type: "liked"; at: number; strength: number }
    | {
        type: "friend";
        userId: string;
        username: string;
        /** Repeat beats played through beats played: the strongest thing any friend did with it. */
        how: "repeat" | "through" | "played";
        at: number;
        /** How many other friends played it too. */
        others: number;
    }
    | { type: "returned"; days: number; lastAt: number }
    | { type: "played"; plays: number; replays: number; lastAt: number };

export interface PlaylistPick {
    songId: string;
    score: number;
    reason: PlaylistReason;
}

export interface BuildInput {
    taste: Pick<UserTaste, "history" | "affinityHistory">;
    /** Friends' plays, already limited to friends who share their listening. */
    friendPlays: readonly PlaylistFriendPlay[];
    /** A song's artists, for the cap on any one artist. Unknown songs have none. */
    artistsOf: (songId: string) => readonly string[];
    now?: number;
    limit?: number;
}

/** A play that heard this much of a song is a word in its favour, whatever was said before. */
export const DECISIVE_PLAY = 0.6;
/** A play that heard less than this, and was skipped, is a word against it. */
export const DECISIVE_SKIP = 0.3;
/** A like counts for half as much after this long: a playlist wants what is liked now. */
export const LIKE_HALF_LIFE_MS = 14 * 24 * 3600e3;
/** A listener's own play, likewise. */
export const PLAY_HALF_LIFE_MS = 14 * 24 * 3600e3;
/** A friend's play fades faster: "this week" is the whole point of that recipe. */
export const FRIEND_HALF_LIFE_MS = 3 * 24 * 3600e3;
/** How far back friends' plays are looked at. */
export const FRIEND_HORIZON_MS = 7 * 24 * 3600e3;
/** Coming back to a song counts once the visits are this far apart. */
export const RETURN_GAP_MS = 7 * 24 * 3600e3;
/** No more of any one artist than this, so a playlist is not one album. */
export const ARTIST_CAP = 2;
export const DEFAULT_LIMIT = 30;

const DAY_MS = 24 * 3600e3;

function decay(at: number, now: number, halfLife: number): number {
    const age = Math.max(0, now - at);

    return Math.exp(-Math.LN2 * age / halfLife);
}

/** One thing that happened to a song, in the order things happened. */
interface Word {
    at: number;
    /** Positive for a like or a play heard, negative for a pass or a skip, zero for a play that said nothing. */
    sign: 1 | -1 | 0;
}

interface Ledger {
    songId: string;
    likes: { at: number; strength: number }[];
    plays: UserTaste["history"];
    friends: Map<string, PlaylistFriendPlay[]>;
    words: Word[];
}

function ledgersOf(input: BuildInput, now: number): Map<string, Ledger> {
    const ledgers = new Map<string, Ledger>();
    const ledger = (songId: string): Ledger => {
        let entry = ledgers.get(songId);

        if (!entry) {
            entry = { songId, likes: [], plays: [], friends: new Map(), words: [] };
            ledgers.set(songId, entry);
        }

        return entry;
    };

    for (const entry of input.taste.affinityHistory) {
        if (entry.timestamp > now || entry.affinity === 0)
            continue;

        const l = ledger(entry.songId);

        if (entry.affinity > 0)
            l.likes.push({ at: entry.timestamp, strength: entry.affinity });

        l.words.push({ at: entry.timestamp, sign: entry.affinity > 0 ? 1 : -1 });
    }

    for (const play of input.taste.history) {
        if (play.timestamp > now)
            continue;

        const l = ledger(play.songId);

        l.plays.push(play);

        const heard = Math.max(0, Math.min(1, play.sessionDuration));
        const sign: Word["sign"] = (play.replayed || heard >= DECISIVE_PLAY) ? 1
            : (play.skipped && heard < DECISIVE_SKIP) ? -1
                : 0;

        l.words.push({ at: play.timestamp, sign });
    }

    for (const play of input.friendPlays) {
        if (play.timestamp > now || now - play.timestamp > FRIEND_HORIZON_MS)
            continue;

        const l = ledger(play.songId);
        const theirs = l.friends.get(play.userId) ?? [];

        theirs.push(play);
        l.friends.set(play.userId, theirs);
    }

    return ledgers;
}

/**
 * Whether the newest thing said about a song was against it.
 *
 * Only decisive words count: a play that heard half a song and was not skipped
 * is neither a yes nor a no, and must not overrule the like before it.
 */
export function standsAgainst(words: readonly Word[]): boolean {
    let latest: Word | null = null;

    for (const word of words)
        if (word.sign !== 0 && (!latest || word.at > latest.at))
            latest = word;

    return latest !== null && latest.sign < 0;
}

function likedScore(l: Ledger, now: number): { score: number; reason: PlaylistReason } | null {
    if (l.likes.length === 0)
        return null;

    const newest = l.likes.reduce((a, b) => (b.at > a.at ? b : a));
    const score = l.likes.reduce((sum, like) => sum + like.strength * decay(like.at, now, LIKE_HALF_LIFE_MS), 0);

    return { score, reason: { type: "liked", at: newest.at, strength: newest.strength } };
}

function friendsScore(l: Ledger, now: number): { score: number; reason: PlaylistReason } | null {
    if (l.friends.size === 0)
        return null;

    let score = 0;
    let best: { play: PlaylistFriendPlay; confidence: number } | null = null;

    for (const plays of l.friends.values()) {
        // One friend's best play of it: a friend who looped it ten times is
        // one friend who loved it, not ten friends
        let theirs: { play: PlaylistFriendPlay; confidence: number } | null = null;

        for (const play of plays) {
            const confidence = playConfidence(play);

            if (!theirs || confidence > theirs.confidence || (confidence === theirs.confidence && play.timestamp > theirs.play.timestamp))
                theirs = { play, confidence };
        }

        if (!theirs)
            continue;

        score += theirs.confidence * decay(theirs.play.timestamp, now, FRIEND_HALF_LIFE_MS);

        if (!best || theirs.confidence > best.confidence || (theirs.confidence === best.confidence && theirs.play.timestamp > best.play.timestamp))
            best = theirs;
    }

    if (!best)
        return null;

    const how: Extract<PlaylistReason, { type: "friend" }>["how"] = best.play.replayed ? "repeat"
        : best.play.sessionDuration >= 0.9 ? "through"
            : "played";

    return {
        score,
        reason: {
            type: "friend",
            userId: best.play.userId,
            username: best.play.username,
            how,
            at: best.play.timestamp,
            others: l.friends.size - 1,
        },
    };
}

function returnedScore(l: Ledger, now: number): { score: number; reason: PlaylistReason } | null {
    // Only plays that were wanted: coming back to skip it again is not coming back
    const wanted = l.plays.filter(play => play.replayed || (!play.skipped && play.sessionDuration >= DECISIVE_SKIP));

    if (wanted.length < 2)
        return null;

    const days = new Set(wanted.map(play => Math.floor(play.timestamp / DAY_MS)));
    const first = Math.min(...wanted.map(play => play.timestamp));
    const last = Math.max(...wanted.map(play => play.timestamp));

    if (days.size < 2 || last - first < RETURN_GAP_MS)
        return null;

    const latest = wanted.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    const score = days.size * playConfidence(latest) * decay(last, now, 30 * DAY_MS);

    return { score, reason: { type: "returned", days: days.size, lastAt: last } };
}

function playedScore(l: Ledger, now: number): { score: number; reason: PlaylistReason } | null {
    if (l.plays.length === 0)
        return null;

    const score = l.plays.reduce((sum, play) => sum + playConfidence(play) * decay(play.timestamp, now, PLAY_HALF_LIFE_MS), 0);
    const last = Math.max(...l.plays.map(play => play.timestamp));

    return {
        score,
        reason: {
            type: "played",
            plays: l.plays.length,
            replays: l.plays.filter(play => play.replayed).length,
            lastAt: last,
        },
    };
}

/** The weights the mix gives each kind of signal, once each is on its own scale. */
export const MIX_WEIGHTS = { liked: 2, played: 1, friends: 0.5 } as const;

function mixScore(l: Ledger, now: number): { score: number; reason: PlaylistReason } | null {
    const parts: { weight: number; part: { score: number; reason: PlaylistReason } }[] = [];
    const consider = (weight: number, part: { score: number; reason: PlaylistReason } | null) => {
        if (part)
            parts.push({ weight, part });
    };

    consider(MIX_WEIGHTS.liked, likedScore(l, now));
    consider(MIX_WEIGHTS.played, returnedScore(l, now) ?? playedScore(l, now));
    consider(MIX_WEIGHTS.friends, friendsScore(l, now));

    if (parts.length === 0)
        return null;

    const score = parts.reduce((sum, { weight, part }) => sum + weight * part.score, 0);
    // The reason is the part that carried the most weight, which is what the listener would recognise
    const strongest = parts.reduce((a, b) => (b.weight * b.part.score > a.weight * a.part.score ? b : a));

    return { score, reason: strongest.part.reason };
}

/**
 * The playlist a recipe makes from what is known.
 *
 * Deterministic: the same inputs give the same list, so a playlist can be
 * rebuilt and compared with what it was.
 */
export function buildPlaylist(recipe: PlaylistRecipe, input: BuildInput): PlaylistPick[] {
    const now = input.now ?? Date.now();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const scorer = {
        liked: likedScore,
        friends: friendsScore,
        returned: returnedScore,
        mix: mixScore,
    }[recipe];

    const picks: PlaylistPick[] = [];

    for (const ledger of ledgersOf(input, now).values()) {
        if (standsAgainst(ledger.words))
            continue;

        const scored = scorer(ledger, now);

        if (!scored || scored.score <= 0)
            continue;

        picks.push({ songId: ledger.songId, ...scored });
    }

    picks.sort((a, b) => (b.score - a.score) || a.songId.localeCompare(b.songId));

    const perArtist = new Map<string, number>();
    const kept: PlaylistPick[] = [];

    for (const pick of picks) {
        if (kept.length >= limit)
            break;

        const artists = input.artistsOf(pick.songId);

        if (artists.some(artist => (perArtist.get(artist) ?? 0) >= ARTIST_CAP))
            continue;

        for (const artist of artists)
            perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);

        kept.push(pick);
    }

    return kept;
}
