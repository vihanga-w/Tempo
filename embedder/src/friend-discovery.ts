/**
 * Picking what to recommend out of what a user's friends have been playing.
 *
 * Discover draws its candidates from the audio-embedding catalogue and ranks
 * them by how close each one sits to the listener's own taste vector. Both
 * halves of that were measured against the real playback history of one friend
 * group — five accounts, 1,552 plays — by walking each timeline forwards and
 * asking, at every first-time play, whether the thing about to be played was
 * anywhere in the candidate pool and where a ranker put it.
 *
 * On reach, the embedding catalogue held 23.5% of first-time plays. The artists
 * that group was already playing between them accounted for 52.4%, and only a
 * third of that overlapped — together they reach 58.9%. Friends are not a
 * better pool than the catalogue so much as a different one.
 *
 * On ranking, the surprise was which friend signal carries. Weighting each
 * friend by how close their taste is to yours — the obvious thing, and the
 * thing tasteMatchScore already computes — scored no better than ignoring the
 * weights entirely (MRR 0.033 against 0.033 for flat popularity, and 0.024 for
 * ranking the pool at random). How recently somebody played a track scored more
 * than twice either (MRR 0.077, and it was the only ranker to beat chance on
 * both a familiar artist and an unfamiliar one). So this ranks on recency and
 * does not consult taste similarity at all.
 */

/** Where the decay is measured from, in hours. Six was the best of 6/24/none. */
export const RECENCY_HALF_LIFE_MS = 6 * 3600e3;

/**
 * Nothing older than this counts. Four days is the window the feed already
 * pulls friend history over, so this only guards against a stale profile.
 */
export const RECENCY_HORIZON_MS = 4 * 24 * 3600e3;

/** Of first-time plays in the sample, 65% were of an artist already played. */
export const FAMILIAR_ARTIST_SHARE = 0.65;

/*
 * Artist affinity is a raw count of past plays, so multiplying by (1 + it) put
 * no ceiling on the boost: 200 logged plays of an artist multiplied a candidate
 * by 201, which is 7.6 half-lives, so a two-day-old play by a favourite beat one
 * from a minute ago. Recency is the signal that carried the trial and affinity
 * was worth about five points of hit rate on familiar artists, so that ordering
 * was backwards.
 *
 * Saturating keeps affinity's ordering while bounding what it can spend. At the
 * ceiling the boost is worth about 1.6 half-lives, and the counts that most
 * listeners actually have sit near the old multiplier rather than under it:
 * one play gives 1.7x where it used to give 2x, two gives 2x, and only the long
 * tail is pulled in.
 */
export const AFFINITY_MAX_BOOST = 2;
export const AFFINITY_HALF_BOOST_AT = 2;

/**
 * Whether somebody else's listening may be read at all.
 *
 * Being friends is not consent to be watched: an account can switch listening
 * activity off, and that setting is what every path reading another person's
 * play history has to ask before it reads. It lived inline in three routes and
 * was simply missing from a fourth, so it is one function now and the answer is
 * the same everywhere.
 *
 * Absent settings are treated as not sharing. An account whose settings never
 * loaded has not opted in, and defaulting the other way publishes it.
 */
export function sharesListeningActivity(
    user: { settings?: { shareListeningActivity?: boolean } } | undefined | null,
): boolean {
    return user?.settings?.shareListeningActivity === true;
}

export interface FriendPlay {
    songId: string;
    /** Whose play this was, so a recommendation can say where it came from. */
    friendId: string;
    artistIds: string[];
    sessionDuration: number;
    skipped: boolean;
    replayed: boolean;
    timestamp: number;
}

export interface FriendCandidate {
    songId: string;
    score: number;
    /** By an artist the listener has played before. */
    familiarArtist: boolean;
    /** When a friend last played it, so callers can say "an hour ago". */
    lastPlayedAt: number;
    /**
     * Who to credit. The most recent player where several friends played it,
     * because that is the one lastPlayedAt is describing.
     */
    friendId: string;
}

/**
 * How much one play says the listener wanted it.
 *
 * sessionDuration is the fraction of the track heard. A replay is the strongest
 * positive Tempo records, and a skip is evidence against however much of the
 * track happened to play before it.
 */
export function playConfidence(play: Pick<FriendPlay, "sessionDuration" | "skipped" | "replayed">): number {
    let confidence = Math.max(0, Math.min(1, play.sessionDuration));

    if (play.replayed)
        confidence += 1;

    if (play.skipped)
        confidence *= 0.25;

    return confidence;
}

/**
 * Friends' plays, scored as candidates for one listener.
 *
 * Anything the listener has played themselves is dropped: this is for
 * recommending, and a track already in their history is not a recommendation.
 */
export function rankFriendCandidates(
    friendPlays: FriendPlay[],
    listener: {
        playedSongIds: Set<string>;
        playedArtistIds: Set<string>;
        /**
         * How much the listener has played each artist, if the caller has it.
         *
         * Worth about five points of hit rate on a familiar artist, and nothing
         * either way on an unfamiliar one — an artist absent from the map
         * simply scores its recency unmodified. It is the interleave below that
         * keeps this from burying every unfamiliar artist.
         */
        artistAffinity?: Map<string, number>;
        /**
         * Songs the listener has rated down, from the graded cooldown the taste
         * profile has always applied. Without it the dislike button did nothing
         * on this half of Discover: a dismissed pick returned on the next page,
         * and the friend still playing it kept its recency score high.
         */
        rejected?: (songId: string) => boolean;
    },
    now = Date.now(),
): FriendCandidate[] {
    const scored = new Map<string, FriendCandidate>();

    for (const play of friendPlays) {
        if (listener.playedSongIds.has(play.songId))
            continue;

        if (listener.rejected?.(play.songId))
            continue;

        const age = now - play.timestamp;

        if (age < 0 || age > RECENCY_HORIZON_MS)
            continue;

        let affinity = 0;

        for (const artistId of play.artistIds)
            affinity += listener.artistAffinity?.get(artistId) ?? 0;

        const affinityBoost = AFFINITY_MAX_BOOST * (affinity / (affinity + AFFINITY_HALF_BOOST_AT));

        const weight = playConfidence(play)
            * Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
            * (1 + affinityBoost);

        if (weight <= 0)
            continue;

        const existing = scored.get(play.songId);

        if (existing) {
            existing.score += weight;

            // The credit follows lastPlayedAt: whoever played it most recently
            // is the one "20 minutes ago" is about.
            if (play.timestamp > existing.lastPlayedAt) {
                existing.lastPlayedAt = play.timestamp;
                existing.friendId = play.friendId;
            }

            continue;
        }

        scored.set(play.songId, {
            songId: play.songId,
            score: weight,
            familiarArtist: play.artistIds.some(id => listener.playedArtistIds.has(id)),
            lastPlayedAt: play.timestamp,
            friendId: play.friendId,
        });
    }

    return [...scored.values()].sort((a, b) => (b.score - a.score) || a.songId.localeCompare(b.songId));
}

/**
 * The most of one page any single friend may supply.
 *
 * Measured over the trial group, the flat ranking hands one friend most of the
 * page and sometimes nearly all of it — 19 of 20 for one listener, 14 to 15 for
 * three others, with only two or three of four friends appearing at all. It is
 * not simply that they played the most: the listener with 568 plays against the
 * top friend's 635 barely appeared. A six hour half-life over a four day window
 * is sixteen half-lives, so whoever listened most recently sweeps the page and
 * everybody else is rounding error.
 *
 * That is a feed of one person's afternoon wearing the word "friends". Half a
 * page is the cap, which still lets an active friend lead and still degrades to
 * the whole page when only one friend has anything.
 */
export const MAX_SHARE_PER_FRIEND = 0.5;

/**
 * Hold slots open for friends the recency ranking would otherwise bury.
 *
 * Order within a friend is untouched — that ordering is the part the trial
 * measured. What changes is only how many of one friend's picks may run before
 * somebody else gets a turn.
 *
 * The cap is deliberately soft: a candidate over it is deferred to the back
 * rather than dropped, so a listener whose only active friend is one person
 * still gets a full page instead of a stub. That means the overflow can flow
 * back into the same page when nobody else has enough material, and the real
 * guarantee is the one that matters — every friend with a candidate is seated
 * before any friend's overflow returns.
 */
export function spreadAcrossFriends(
    candidates: FriendCandidate[],
    pageSize: number,
    maxShare = MAX_SHARE_PER_FRIEND,
    rotation = 0,
): FriendCandidate[] {
    // At least two, or a two-item page could never seat a second friend.
    const cap = Math.max(2, Math.floor(pageSize * maxShare));

    /*
     * Which friend leads rotates, borrowed from the old For You page.
     *
     * That page reshuffled itself against a seed derived from the account and
     * the quarter hour — stable while somebody pages through, different when
     * they come back later. The cap alone has no such property: it seats
     * whoever holds the top-scoring track first, so the same friend leads every
     * refresh and the others are permanently second.
     *
     * The improvement over reshuffling is that this rotates friends rather than
     * items. The old page threw away its own ranking to get variety; here the
     * order within a friend, which is the part the trial measured, is kept
     * exactly and only the turn order moves.
     */
    const order = [...new Set(candidates.map(c => c.friendId))];

    if (order.length > 1) {
        const by = ((rotation % order.length) + order.length) % order.length;
        order.push(...order.splice(0, by));
    }

    const rank = new Map(order.map((id, i) => [id, i]));
    const seated = new Set<string>();
    const rotated: FriendCandidate[] = [];
    const rest: FriendCandidate[] = [];

    // One turn each, in the rotated order, before anybody takes a second slot.
    for (const candidate of candidates) {
        if (seated.has(candidate.friendId)) {
            rest.push(candidate);
            continue;
        }

        seated.add(candidate.friendId);
        rotated.push(candidate);
    }

    rotated.sort((a, b) => (rank.get(a.friendId) ?? 0) - (rank.get(b.friendId) ?? 0));

    const taken = new Map<string, number>();
    const kept: FriendCandidate[] = [];
    const deferred: FriendCandidate[] = [];

    for (const candidate of [...rotated, ...rest]) {
        const used = taken.get(candidate.friendId) ?? 0;

        if (used >= cap) {
            deferred.push(candidate);
            continue;
        }

        taken.set(candidate.friendId, used + 1);
        kept.push(candidate);
    }

    return [...kept, ...deferred];
}

/**
 * One list out of two, drawn from each at the rate that kind of discovery
 * happens.
 *
 * Ranking the two kinds together is what a single score does, and it goes badly
 * in one specific direction: any ranker that scores a track by the listener's
 * affinity for its artist gives an artist they have never played a score of
 * zero, so every unfamiliar artist sinks below every familiar one. Measured, a
 * fused ranking scored 0.006 on unfamiliar artists where the friend signal on
 * its own scored 0.052. Keeping the two apart and interleaving them is what
 * stops the half of the feed that is actually discovery from being squeezed out
 * by the half that is not.
 */
export function interleaveByFamiliarity(
    candidates: FriendCandidate[],
    familiarShare = FAMILIAR_ARTIST_SHARE,
    pageSize?: number,
    rotation = 0,
): FriendCandidate[] {
    /*
     * The spread belongs in here, per lane, not outside on the combined list.
     *
     * Spreading the combined list and then interleaving undoes the spread: this
     * re-splits by familiarity and draws each lane in order, so a friend who
     * dominates one lane still takes that lane whatever the combined ordering
     * said. Measured, one listener stayed at 15 of 20 from a single friend
     * while everybody else improved — that listener had played little enough
     * that almost every candidate landed in the same lane.
     *
     * Each lane gets the budget it will actually be drawn on, so the cap binds
     * on what reaches the page rather than on the list it came from.
     */
    const spread = (lane: FriendCandidate[], budget: number) =>
        (pageSize === undefined
            ? lane
            : spreadAcrossFriends(lane, Math.max(1, Math.round(budget)),
                MAX_SHARE_PER_FRIEND, rotation));

    const familiar = spread(candidates.filter(c => c.familiarArtist),
        (pageSize ?? 0) * familiarShare);
    const fresh = spread(candidates.filter(c => !c.familiarArtist),
        (pageSize ?? 0) * (1 - familiarShare));

    const out: FriendCandidate[] = [];

    let takeFamiliar = 0;
    let owed = 0;
    let takeFresh = 0;

    while (takeFamiliar < familiar.length || takeFresh < fresh.length) {
        owed += familiarShare;

        if (owed >= 1 && takeFamiliar < familiar.length) {
            out.push(familiar[takeFamiliar++]);
            owed -= 1;
        } else if (takeFresh < fresh.length) {
            out.push(fresh[takeFresh++]);
        } else if (takeFamiliar < familiar.length) {
            out.push(familiar[takeFamiliar++]);
        }
    }

    return out;
}
