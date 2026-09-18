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
 * Five recipes, one scoring model:
 *
 *   - liked:    songs liked in Discover. A like never becomes a play, so this
 *               pile exists nowhere else.
 *   - friends:  what friends put on repeat or played through this week.
 *   - returned: "On repeat with Tempo": songs the listener came back to after a gap, which is the
 *               most honest "I like this" a play history holds.
 *   - mix:      everything above, weighed together.
 *   - now:      the same signals read against the clock. Nobody has one taste:
 *               they have a morning one and a late one, and the four recipes
 *               above answer the same thing at breakfast as at midnight. This
 *               one weighs every play by how near the clock it happened to the
 *               hour being asked about, leans on the last fortnight rather than
 *               the last season, and shuffles what is left, so it is a
 *               different playlist by the afternoon and a different one again
 *               tomorrow morning.
 *
 * One rule holds across all of them: the newest word wins, and a word against
 * a song keeps it out. A like followed by a skip was a wrong like, a pass
 * followed by a replay was a change of mind, and summing them would say
 * neither. The taste embedding only down-weights a pass; a playlist that kept
 * a song somebody had just swiped away has failed at the one thing it is for.
 */

export type PlaylistRecipe = "liked" | "friends" | "returned" | "mix" | "now";

export const RECIPES: Record<PlaylistRecipe, { name: string; blurb: string }> = {
    liked: { name: "Liked in Discover", blurb: "Everything you swiped right on, newest first." },
    friends: { name: "On repeat with friends", blurb: "What your friends kept playing this week." },
    returned: { name: "On repeat with Tempo", blurb: "The songs you keep coming back to." },
    mix: { name: "Your mix", blurb: "Likes, your plays and your friends', weighed together." },
    now: { name: "Right about now", blurb: "What you play at this hour, made fresh through the day." },
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
    | { type: "played"; plays: number; replays: number; lastAt: number }
    | {
        type: "daypart";
        /** The part of the day the listener plays it in, for the words under it. */
        part: DayPart;
        /** How many of their plays of it landed near this hour of the clock. */
        plays: number;
        /** The newest of those, so the line can say when. */
        lastAt: number;
    };

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
    /**
     * The hour of the clock a moment fell on, for the recipe that asks what
     * time it is. The server's own clock by default, which is the clock the
     * hourly listenership aggregate is already kept on; injectable so the
     * scoring can be tested without a timezone deciding the answer.
     */
    hourOf?: (at: number) => number;
    /**
     * Which turn of the shuffle to build. Defaults to the turn the moment
     * falls in, so a preview and the playlist made from it agree, and two
     * rebuilds within one turn give the same list.
     */
    seed?: number;
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
const HOUR_MS = 3600e3;

function decay(at: number, now: number, halfLife: number): number {
    const age = Math.max(0, now - at);

    return Math.exp(-Math.LN2 * age / halfLife);
}

/* ------------------------------------------------------------ the clock */

/**
 * What time it is, and what that is worth.
 *
 * A listener does not have one taste; they have the one they put on with the
 * kettle and the one they end the night with, and a playlist that ignores the
 * clock hands them the wrong one half the time. So a play is worth most to
 * the hour it happened at and less the further round the dial it sits, which
 * makes the same history answer differently at nine in the morning and at
 * midnight without anything being recomputed.
 */

export type DayPart = "morning" | "afternoon" | "evening" | "night";

/** The part of the day an hour sits in. Only ever words for a listener: the scoring reads hours, not parts. */
export function dayPart(hour: number): DayPart {
    const h = ((Math.floor(hour) % 24) + 24) % 24;

    if (h >= 5 && h < 11)
        return "morning";

    if (h >= 11 && h < 17)
        return "afternoon";

    if (h >= 17 && h < 23)
        return "evening";

    return "night";
}

/** The hour a moment fell on, by the server's clock — the one the listenership aggregate is kept on. */
export function clockHour(at: number): number {
    return new Date(at).getHours();
}

/** How far apart two hours are on the dial: eleven at night and one in the morning are two hours apart, not twenty-two. */
export function hoursApart(a: number, b: number): number {
    const gap = Math.abs(a - b) % 24;

    return Math.min(gap, 24 - gap);
}

/** An hour either side counts for most of a play; the other side of the clock keeps a sixteenth of it. */
export const HOUR_HALF_LIFE = 3;

/** What a play made at one hour is worth to another. */
export function hourFit(playHour: number, atHour: number): number {
    return Math.pow(0.5, hoursApart(playHour, atHour) / HOUR_HALF_LIFE);
}

/** Plays this near the hour are the ones the reason line may call "around now". */
export const NEAR_HOURS = 2;

/**
 * A number in [0, 1) for a song in a turn of the shuffle, and the same number
 * every time it is asked for.
 *
 * The randomisation has to be repeatable or nothing else here works: the
 * playlist somebody was shown before they named it would not be the one they
 * were given, and a rebuild a minute later would be a different playlist
 * again for no reason anybody could see. So the roll is a hash of the song
 * and the turn rather than a draw from Math.random, and it only changes when
 * the turn does.
 */
export function shuffleRoll(songId: string, seed: number): number {
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;

    for (let i = 0; i < songId.length; i++)
        h = Math.imul(h ^ songId.charCodeAt(i), 0x01000193) >>> 0;

    h ^= h >>> 15;
    h = Math.imul(h, 0x2545f491) >>> 0;
    h ^= h >>> 13;

    return (h >>> 0) / 4294967296;
}

/** How long one turn of the shuffle lasts. Longer than it takes to name a playlist, shorter than a mood. */
export const NOW_SLOT_MS = 3 * HOUR_MS;

/** Which turn a moment falls in. */
export function nowSlot(at: number): number {
    return Math.floor(at / NOW_SLOT_MS);
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

/**
 * What friends have been doing with a song.
 *
 * `fit` is how much a play made at a given moment counts, for the recipe that
 * cares what time it is; by default a play counts for itself.
 */
function friendsScore(l: Ledger, now: number, fit: (at: number) => number = () => 1): { score: number; reason: PlaylistReason } | null {
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

        score += theirs.confidence * fit(theirs.play.timestamp) * decay(theirs.play.timestamp, now, FRIEND_HALF_LIFE_MS);

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

type Scored = { score: number; reason: PlaylistReason };

/**
 * Several signals, each already on its own scale, weighed into one score and
 * one reason. A signal that found nothing is simply absent.
 */
function weighed(parts: readonly { weight: number; part: Scored | null }[]): Scored | null {
    const found = parts.filter((v): v is { weight: number; part: Scored } => v.part !== null);

    if (found.length === 0)
        return null;

    const score = found.reduce((sum, { weight, part }) => sum + weight * part.score, 0);
    // The reason is the part that carried the most weight, which is what the listener would recognise
    const strongest = found.reduce((a, b) => (b.weight * b.part.score > a.weight * a.part.score ? b : a));

    return { score, reason: strongest.part.reason };
}

/** The weights the mix gives each kind of signal, once each is on its own scale. */
export const MIX_WEIGHTS = { liked: 2, played: 1, friends: 0.5 } as const;

function mixScore(l: Ledger, now: number): Scored | null {
    return weighed([
        { weight: MIX_WEIGHTS.liked, part: likedScore(l, now) },
        { weight: MIX_WEIGHTS.played, part: returnedScore(l, now) ?? playedScore(l, now) },
        { weight: MIX_WEIGHTS.friends, part: friendsScore(l, now) },
    ]);
}

/** A play fades faster here than in the mix: this recipe answers for the fortnight, not the season. */
export const NOW_HALF_LIFE_MS = 10 * DAY_MS;
/** The weights the dynamic recipe gives each signal, once the clock has had its say. */
export const NOW_WEIGHTS = { hour: 1, liked: 0.4, friends: 0.5 } as const;
/** How far the shuffle may move a song, up or down. Half: a favourite still wins, the middle of the pile turns over. */
export const NOW_JITTER = 0.5;

/**
 * The listener's own plays, read against the hour being asked about.
 *
 * Every play counts, but a play made at this hour counts for all of itself
 * and one made twelve hours away for a sixteenth, so the songs that rise are
 * the ones this listener actually reaches for at this time of day.
 */
function hourScore(l: Ledger, now: number, hourOf: (at: number) => number): Scored | null {
    if (l.plays.length === 0)
        return null;

    const atHour = hourOf(now);
    let score = 0;
    let near = 0;
    let nearAt = 0;
    let last = 0;
    let replays = 0;

    for (const play of l.plays) {
        const hour = hourOf(play.timestamp);

        score += playConfidence(play) * hourFit(hour, atHour) * decay(play.timestamp, now, NOW_HALF_LIFE_MS);
        last = Math.max(last, play.timestamp);

        if (play.replayed)
            replays++;

        if (hoursApart(hour, atHour) <= NEAR_HOURS) {
            near++;
            nearAt = Math.max(nearAt, play.timestamp);
        }
    }

    if (score <= 0)
        return null;

    /*
     * A song carried by plays around this hour can say so, and name the part
     * of the day they were. One carried from the far side of the clock — played
     * so much that even a sixteenth of each play adds up — says the plain thing
     * instead: "you play this in the morning" would not be true of it.
     */
    const reason: PlaylistReason = near > 0
        ? { type: "daypart", part: dayPart(atHour), plays: near, lastAt: nearAt }
        : { type: "played", plays: l.plays.length, replays, lastAt: last };

    return { score, reason };
}

/**
 * The dynamic recipe: the same signals as the mix, asked at an hour and then
 * shuffled.
 *
 * The clock does most of the work — their own plays and their friends' are
 * both weighed by how near this hour they happened — and likes come in
 * unweighed but light, since when somebody swiped in Discover says nothing
 * about when they want to hear the song. What comes out is then nudged up or
 * down by a roll that holds for the turn, which is what keeps a playlist
 * rebuilt six times a day from being the same playlist six times a day: the
 * songs a listener is clearly in the mood for stay, and the ones behind them
 * take turns.
 */
function nowScore(l: Ledger, now: number, hourOf: (at: number) => number, seed: number): Scored | null {
    const atHour = hourOf(now);
    const scored = weighed([
        { weight: NOW_WEIGHTS.hour, part: hourScore(l, now, hourOf) },
        { weight: NOW_WEIGHTS.liked, part: likedScore(l, now) },
        { weight: NOW_WEIGHTS.friends, part: friendsScore(l, now, at => hourFit(hourOf(at), atHour)) },
    ]);

    if (!scored)
        return null;

    return { ...scored, score: scored.score * (1 + NOW_JITTER * (2 * shuffleRoll(l.songId, seed) - 1)) };
}

/**
 * The playlist a recipe makes from what is known.
 *
 * Deterministic: the same inputs give the same list, so a playlist can be
 * rebuilt and compared with what it was. The dynamic recipe is no exception —
 * its shuffle is a hash of the song and the turn, not a draw — so it too
 * gives the same list twice within a turn, and a different one in the next.
 */
export function buildPlaylist(recipe: PlaylistRecipe, input: BuildInput): PlaylistPick[] {
    const now = input.now ?? Date.now();
    const limit = input.limit ?? DEFAULT_LIMIT;
    const hourOf = input.hourOf ?? clockHour;
    const seed = input.seed ?? nowSlot(now);
    const scorer: (l: Ledger, at: number) => Scored | null = recipe === "now"
        ? (l, at) => nowScore(l, at, hourOf, seed)
        : {
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
