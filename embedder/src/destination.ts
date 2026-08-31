/**
 * Choosing somewhere to send somebody.
 *
 * Two rules shape all of this.
 *
 * The first is that the destination must be somewhere they have *not* been.
 * Recommending the country somebody already listens to most is a mirror, not a
 * recommendation -- it tells them something they already know and costs them a
 * week of attention to learn nothing.
 *
 * The second is that nothing here is a guess dressed as a fact. The score is
 * cosine similarity between two genre profiles, both built from MusicBrainz
 * tags that were resolved per artist and stored. Every destination carries a
 * bridge -- an artist already in their rotation that the country genuinely
 * shares genres with -- and if no bridge exists, no destination is offered.
 * "Here is a country" is worthless; "here is why you, specifically" is the
 * entire product.
 *
 * The prose that describes the choice is written elsewhere (destination-copy).
 * Nothing in this file asks a language model anything: the model is handed the
 * facts this module computed and told to phrase them.
 */

import { countryPlace } from "./country-centroids";

/**
 * How many of a country's artists have to be known before it can be a candidate.
 *
 * One, and that is deliberate. It used to be three, which quietly made the
 * whole feature impossible: three different artists from a country is exactly
 * what earns a stamp, and stamped countries are excluded as candidates. So a
 * country either had too few artists to qualify or enough to already be
 * visited, and no destination could ever be chosen.
 *
 * A country somebody has heard one thing from and never gone back to is a good
 * lead anyway — better than one they have no connection to at all, because the
 * bridge is real.
 */
export const MIN_CANDIDATE_ARTISTS = 1;

/** A destination with nothing connecting it to the listener is not offered. */
export const MIN_BRIDGE_OVERLAP = 1;

/** Artists to name alongside the bridge. */
export const FRESH_ARTIST_COUNT = 3;

export interface CatalogueArtist {
    artistId: string;
    name: string;
    countryCode: string;
    genres: string[];
}

export interface ListenerArtist {
    artistId: string;
    name: string;
    countryCode: string | null;
    genres: string[];
    /** Unskipped plays by this listener. */
    plays: number;
}

export interface Destination {
    countryCode: string;
    name: string;
    lat: number;
    lon: number;
    continent: string;
    /** 0..1 cosine similarity between the listener's genres and the country's. */
    affinity: number;
    /**
     * Artists from there the listener has never played.
     *
     * Possibly empty here. Tempo's catalogue is what people here already listen
     * to, so it often has nothing new to offer about a place; the service fills
     * these in from MusicBrainz afterwards, and refuses the destination if it
     * still cannot name anybody.
     */
    /** Genres both sides share, strongest first. */
    sharedGenres: string[];
    /**
     * Whether they have played nothing at all from here.
     *
     * Not the same as "unstamped", which is what the candidate list filters on:
     * a single play earns no stamp, so an unstamped country can still be one
     * they have heard. The difference matters because this fact is handed to a
     * language model as ground truth, and "you have never played anything from
     * Nigeria" is a lie if they played one Burna Boy track last March.
     */
    neverPlayed: boolean;
    bridge: { artistId: string; name: string };
    fresh: { artistId: string; name: string }[];
}

type Profile = Map<string, number>;

/** Weighted genre counts, so a heavy rotation counts more than a single play. */
export function genreProfile(
    items: { genres: string[]; weight: number }[],
): Profile {
    const profile: Profile = new Map();

    for (const item of items) {
        if (item.weight <= 0)
            continue;

        for (const genre of item.genres) {
            const key = genre.trim().toLowerCase();

            if (key.length === 0)
                continue;

            profile.set(key, (profile.get(key) ?? 0) + item.weight);
        }
    }

    return profile;
}

/**
 * Cosine similarity between two genre profiles.
 *
 * Cosine rather than raw overlap because the two sides are wildly different
 * sizes: a listener has a few dozen genres and a country's catalogue can have
 * hundreds, and any un-normalised measure would rank the largest scene top every
 * time regardless of who is asking.
 */
export function cosine(a: Profile, b: Profile): number {
    if (a.size === 0 || b.size === 0)
        return 0;

    let dot = 0;

    // Iterate the smaller side; the intersection is what contributes.
    const [small, large] = (a.size <= b.size) ? [a, b] : [b, a];

    for (const [genre, weight] of small) {
        const other = large.get(genre);

        if (other)
            dot += weight * other;
    }

    if (dot === 0)
        return 0;

    let normA = 0;
    let normB = 0;

    for (const weight of a.values()) normA += weight * weight;
    for (const weight of b.values()) normB += weight * weight;

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Genres present on both sides, ordered by how much the listener plays them. */
export function sharedGenres(listener: Profile, country: Profile, limit = 4): string[] {
    const shared: { genre: string; weight: number }[] = [];

    for (const [genre, weight] of listener) {
        if (country.has(genre))
            shared.push({ genre, weight });
    }

    return shared
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit)
        .map(s => s.genre);
}

/**
 * The listener's own artist that best connects them to a country.
 *
 * Ranked by shared genres first and play count second, so the bridge is the
 * artist that actually explains the leap rather than merely their favourite.
 */
export function findBridge(
    listenerArtists: ListenerArtist[],
    countryProfile: Profile,
): { artist: ListenerArtist; overlap: number } | null {
    let best: { artist: ListenerArtist; overlap: number } | null = null;

    for (const artist of listenerArtists) {
        let overlap = 0;

        for (const genre of artist.genres) {
            if (countryProfile.has(genre.trim().toLowerCase()))
                overlap++;
        }

        if (overlap < MIN_BRIDGE_OVERLAP)
            continue;

        if (!best
            || overlap > best.overlap
            || (overlap === best.overlap && artist.plays > best.artist.plays))
            best = { artist, overlap };
    }

    return best;
}

/**
 * Somewhere to go next, or null.
 *
 * Null is a real answer and has to stay one. A listener with twelve plays has no
 * genre profile worth reasoning about, and a made-up destination for them is
 * worse than none -- it teaches them the feature is noise.
 */
export function pickDestination(
    listenerArtists: ListenerArtist[],
    catalogue: CatalogueArtist[],
    /** Countries the listener has ever stamped, which are therefore not new. */
    visitedCountries: Set<string>,
    now: number,
): Destination | null {
    const listened = new Set(listenerArtists.map(a => a.artistId));

    const playedCountries = new Set(
        listenerArtists.map(a => a.countryCode).filter((c): c is string => !!c),
    );

    const listenerProfile = genreProfile(
        listenerArtists.map(a => ({ genres: a.genres, weight: a.plays })),
    );

    if (listenerProfile.size === 0)
        return null;

    const byCountry = new Map<string, CatalogueArtist[]>();

    for (const artist of catalogue) {
        if (visitedCountries.has(artist.countryCode))
            continue;

        if (!countryPlace(artist.countryCode))
            continue;

        const list = byCountry.get(artist.countryCode);

        if (list)
            list.push(artist);
        else
            byCountry.set(artist.countryCode, [artist]);
    }

    let best: Destination | null = null;
    let bestScore = 0;

    for (const [countryCode, artists] of byCountry) {
        if (artists.length < MIN_CANDIDATE_ARTISTS)
            continue;

        const place = countryPlace(countryCode);

        if (!place)
            continue;

        // Every artist counts once. Tempo has no cross-listener popularity
        // signal to weight them by, and inventing one would only decide the
        // ordering by something that is not true.
        const countryProfile = genreProfile(
            artists.map(a => ({ genres: a.genres, weight: 1 })),
        );

        const affinity = cosine(listenerProfile, countryProfile);

        if (affinity <= 0)
            continue;

        const bridge = findBridge(listenerArtists, countryProfile);

        if (!bridge)
            continue;

        /*
         * Ranked on how well understood the country is as well as how close it
         * looks.
         *
         * Cosine ignores magnitude, so a country known by a single artist whose
         * two genres both land in the listener's rotation scores close to
         * perfect, while one known by six artists has its profile spread over
         * more genres and scores lower for being better evidenced. Since the
         * candidate gate is one artist, that bias would hand every destination
         * to the thinnest possible evidence.
         */
        const confidence = artists.length / (artists.length + 1);
        const score = affinity * confidence;

        // Ties broken by country code, not by whichever order the origin cache
        // happened to load in: two countries scoring identically must not give
        // different answers before and after a restart.
        if (best && (score < bestScore
            || (score === bestScore && countryCode >= best.countryCode)))
            continue;

        bestScore = score;

        // Ordered by how much each one overlaps with what they already play,
        // so the three names offered are the three most likely to land rather
        // than three arbitrary ones.
        const fresh = artists
            .filter(a => !listened.has(a.artistId))
            .map(a => ({
                artist: a,
                overlap: a.genres.reduce(
                    (n, g) => n + (listenerProfile.has(g.trim().toLowerCase()) ? 1 : 0), 0,
                ),
            }))
            .sort((a, b) => b.overlap - a.overlap || a.artist.name.localeCompare(b.artist.name))
            .slice(0, FRESH_ARTIST_COUNT)
            .map(f => ({ artistId: f.artist.artistId, name: f.artist.name }));

        best = {
            countryCode,
            name: place.name,
            lat: place.lat,
            lon: place.lon,
            continent: place.continent,
            affinity,
            sharedGenres: sharedGenres(listenerProfile, countryProfile),
            neverPlayed: !playedCountries.has(countryCode),
            bridge: { artistId: bridge.artist.artistId, name: bridge.artist.name },
            fresh,
        };
    }

    return best;
}

/**
 * Which week a destination belongs to.
 *
 * A recommendation that changes when you pull to refresh is a slot machine. The
 * choice is pinned to the ISO week so it holds for seven days, and the same
 * history produces the same answer all week.
 */
export function weekKey(now: number): string {
    const date = new Date(now);

    date.setUTCHours(0, 0, 0, 0);
    // Thursday of the current week decides the ISO year
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));

    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    const week = Math.ceil((((date.getTime() - yearStart) / 86_400_000) + 1) / 7);

    return `${date.getUTCFullYear()}-W${week < 10 ? "0" : ""}${week}`;
}
