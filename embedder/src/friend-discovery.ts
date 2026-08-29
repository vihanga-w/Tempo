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

export interface FriendPlay {
    songId: string;
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
    },
    now = Date.now(),
): FriendCandidate[] {
    const scored = new Map<string, FriendCandidate>();

    for (const play of friendPlays) {
        if (listener.playedSongIds.has(play.songId))
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
            existing.lastPlayedAt = Math.max(existing.lastPlayedAt, play.timestamp);
            continue;
        }

        scored.set(play.songId, {
            songId: play.songId,
            score: weight,
            familiarArtist: play.artistIds.some(id => listener.playedArtistIds.has(id)),
            lastPlayedAt: play.timestamp,
        });
    }

    return [...scored.values()].sort((a, b) => (b.score - a.score) || a.songId.localeCompare(b.songId));
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
): FriendCandidate[] {
    const familiar = candidates.filter(c => c.familiarArtist);
    const fresh = candidates.filter(c => !c.familiarArtist);

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
