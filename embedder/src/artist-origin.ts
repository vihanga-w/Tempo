/**
 * Where an artist is from.
 *
 * Spotify tells us who played; it does not tell us where they are from, and the
 * ISRC we already store is not the answer either. An ISRC's first two characters
 * are the country of the *registrant* — the label — so Burna Boy's "Last Last"
 * is USAT22204901 because Atlantic registered it. Reading the prefix would put
 * Afrobeats in New York and flatten the whole map onto the US and UK, which is
 * precisely the distortion this feature exists to correct.
 *
 * MusicBrainz does know, and the ISRC is the key that gets us there without any
 * fuzzy name matching:
 *
 *     isrc -> /ws/2/isrc/{isrc}  -> recording -> artist mbid
 *          -> /ws/2/artist/{mbid} -> country, begin-area, genres
 *
 * Two requests per artist, once, ever. An artist's country of origin does not
 * change, so a resolved answer is cached permanently and the cost is per artist
 * rather than per play.
 */

import { REQ_USER_AGENT } from "./const";

/** MusicBrainz asks for one request a second. This is that, with room to spare. */
export const MB_MIN_INTERVAL_MS = 1100;

/** How many times a 503 is retried before the artist is left for another day. */
export const MB_MAX_ATTEMPTS = 3;

/** Below this, a name match is a coincidence rather than an identification. */
export const MB_MIN_NAME_SCORE = 90;

/** How many of an artist's songs are asked about before giving up. */
export const MB_RECORDING_PROBES = 3;

/** Agreement at or above this is treated as settled. */
export const CORROBORATED = 2;

/**
 * After this many distinct songs have failed to agree, the answer stands.
 *
 * Rechecking is worth it while there is a song nobody has tried. It stops being
 * worth it once somebody has played six of an artist's tracks and no two of
 * them could be made to agree: at that point the answer is not going to improve,
 * and every further song would otherwise buy another round of searching.
 */
export const MB_RECHECK_LIMIT = 6;

/** Compared the way a person would: case and spacing are not the difference. */
export function normaliseName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export const MB_BASE = "https://musicbrainz.org/ws/2";

export interface ArtistOrigin {
    /** ISO 3166-1 alpha-2, as MusicBrainz reports it. */
    countryCode: string | null;
    /**
     * Where they started, when MusicBrainz knows it.
     *
     * Preferred over `area` because `area` is often just the country again,
     * while `begin-area` is the town the music actually came out of — Port
     * Harcourt rather than Nigeria. Carried for display only; the passport is
     * counted by country.
     */
    city: string | null;
    /** MusicBrainz community genre tags, most-voted first. */
    genres: string[];
    mbid: string | null;
    /**
     * How this was found.
     *
     * An ISRC identifies a recording; a name identifies something that shares a
     * name. Recorded so the two can be told apart if the name route ever turns
     * out to place people badly.
     */
    via?: "isrc" | "recording" | "name";
    /**
     * How many independent songs agreed on this artist.
     *
     * Below CORROBORATED the answer is worth revisiting if more of their music
     * turns up later: one song can match a cover, or a same-named act who
     * happens to have used the same title, and a resolved origin is otherwise
     * never looked at again.
     */
    corroboration?: number;
    /**
     * How many of their songs were available when this was decided.
     *
     * The difference between "not enough evidence yet" and "the evidence was
     * considered and did not agree". Without it, an answer that fell through to
     * the name route because two songs disagreed looked exactly like one still
     * waiting on a second song, so it was re-queued on every read and the same
     * two searches ran for ever.
     */
    evidence?: number;
}

export interface FetchLike {
    (url: string, init?: { headers?: Record<string, string> }): Promise<{
        ok: boolean;
        status: number;
        json(): Promise<any>;
    }>;
}

/**
 * The artist credited on a recording, from an ISRC lookup.
 *
 * Only the first credit is taken. A featured artist is a real contributor but
 * not whose record it is, and counting both would stamp a country for every
 * guest verse.
 */
export function parseIsrcRecordings(body: unknown): string | null {
    const recordings = (body as any)?.recordings;

    if (!Array.isArray(recordings))
        return null;

    for (const recording of recordings) {
        const credit = recording?.["artist-credit"];

        if (!Array.isArray(credit))
            continue;

        const mbid = credit[0]?.artist?.id;

        if (typeof mbid === "string" && mbid.length > 0)
            return mbid;
    }

    return null;
}

/** An ISO 3166-1 alpha-2 code, or null for anything that is not one. */
function normaliseCountry(value: unknown): string | null {
    if (typeof value !== "string")
        return null;

    const code = value.trim().toUpperCase();

    return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Country, city and genres out of an artist document.
 *
 * `country` is preferred over `area`, but an artist can carry an area and no
 * country — a lot of older entries do — so the area's name is not enough and we
 * fall back to the area only when it is itself a country with a code.
 */
export function parseArtistDoc(body: unknown): ArtistOrigin {
    const doc = body as any;

    const country =
        normaliseCountry(doc?.country) ??
        normaliseCountry(doc?.area?.["iso-3166-1-codes"]?.[0]);

    const beginArea = doc?.["begin-area"]?.name;

    // Only begin-area. `area` is almost always the country repeated, which is
    // not a city, and "Nigeria, Nigeria" is worse than no city at all.
    const city = (typeof beginArea === "string" && beginArea.length > 0)
        ? beginArea
        : null;

    const genres: string[] = Array.isArray(doc?.genres)
        ? [...doc.genres]
            .filter(g => typeof g?.name === "string")
            .sort((a, b) => (b?.count ?? 0) - (a?.count ?? 0))
            .map(g => String(g.name).toLowerCase())
        : [];

    return {
        countryCode: country,
        city,
        genres,
        mbid: (typeof doc?.id === "string") ? doc.id : null,
    };
}

/** A 503 from MusicBrainz means "busy, come back", not "no". */
export function isRetryable(status: number): boolean {
    return (status === 503 || status === 429 || status >= 500);
}

/**
 * A MusicBrainz client that will not get us blocked.
 *
 * Every request goes through one promise chain with a minimum gap between them,
 * so concurrent callers queue rather than burst. Without this the service
 * answers 503 "currently busy" almost immediately and keeps doing so.
 */
export class MusicBrainzClient {
    private tail: Promise<unknown> = Promise.resolve();
    private lastRequestAt = 0;

    constructor(
        private fetchImpl: FetchLike,
        private minIntervalMs: number = MB_MIN_INTERVAL_MS,
        private sleep: (ms: number) => Promise<void> =
            ms => new Promise(resolve => setTimeout(resolve, ms)),
        private now: () => number = () => Date.now(),
    ) {}

    /** Serialised, spaced, and retried. Resolves null rather than throwing. */
    private schedule<T>(run: () => Promise<T>): Promise<T | null> {
        const queued = this.tail.then(async () => {
            const since = this.now() - this.lastRequestAt;

            if (since < this.minIntervalMs)
                await this.sleep(this.minIntervalMs - since);

            this.lastRequestAt = this.now();

            return run();
        });

        // The chain must not be poisoned by one failure, or every request behind
        // a single error is rejected without ever being sent.
        this.tail = queued.catch(() => undefined);

        return queued.catch(() => null);
    }

    private async getJson(path: string): Promise<any | null> {
        for (let attempt = 1; attempt <= MB_MAX_ATTEMPTS; attempt++) {
            const response = await this.schedule(() => this.fetchImpl(`${MB_BASE}${path}`, {
                headers: {
                    "User-Agent": REQ_USER_AGENT,
                    "Accept": "application/json",
                },
            }));

            if (!response)
                return null;

            if (response.ok)
                return response.json();

            if (!isRetryable(response.status))
                return null;

            // Backs off rather than hammering: the service is telling us it is
            // busy, and the next request is already a second away regardless.
            if (attempt < MB_MAX_ATTEMPTS)
                await this.sleep(this.minIntervalMs * attempt);
        }

        return null;
    }

    /** The primary artist on a recording, by ISRC. */
    async artistIdForIsrc(isrc: string): Promise<string | null> {
        if (!/^[A-Za-z0-9]{12}$/.test(isrc))
            return null;

        const body = await this.getJson(
            `/isrc/${encodeURIComponent(isrc.toUpperCase())}?inc=artist-credits&fmt=json`,
        );

        return body ? parseIsrcRecordings(body) : null;
    }

    /** Country, city and genres for an artist. */
    async originForMbid(mbid: string): Promise<ArtistOrigin | null> {
        if (!/^[0-9a-fA-F-]{36}$/.test(mbid))
            return null;

        const body = await this.getJson(
            `/artist/${encodeURIComponent(mbid)}?inc=genres&fmt=json`,
        );

        return body ? parseArtistDoc(body) : null;
    }

    /**
     * Artists from a country, in a genre.
     *
     * The destination needs names the listener has never played, and Tempo's own
     * catalogue cannot supply them: it is built from what people here already
     * listen to, so early on it is a mirror of one library. MusicBrainz can be
     * asked directly, and its search takes both a country and a tag, so the
     * answers are guaranteed to be from the right place rather than guessed at.
     *
     * Ranked by MusicBrainz's own relevance, which favours the well documented,
     * which in practice favours the well known: asking for Jamaican dancehall
     * returns Sizzla, Beenie Man and King Tubby.
     */
    async artistsFromCountry(
        countryCode: string,
        genres: string[],
        /**
         * Lowercased names the caller already knows about.
         *
         * Filtered here rather than by the caller so a query that returns only
         * familiar artists falls through to the next one. Filtering afterwards
         * meant the first query that matched the country ended the search, and
         * if the listener already played everybody in it the whole destination
         * was refused while the country-only query went unasked.
         */
        exclude: Set<string> = new Set(),
        limit = 8,
    ): Promise<{ mbid: string; name: string }[]> {
        if (!/^[A-Za-z]{2}$/.test(countryCode))
            return [];

        // The strongest shared genre first, then the country alone. A tag that
        // nobody has applied in that country returns nothing rather than
        // failing, and an empty answer is not a reason to give up on the place.
        // Genres reach this from MusicBrainz's own tags, but they are still
        // interpolated into a Lucene query, so anything that could be an
        // operator or a quote is dropped rather than escaped.
        const safe = (genre: string) => genre.replace(/[^a-z0-9 &-]/gi, "").trim();

        const queries = [
            ...genres.slice(0, 2).map(safe).filter(g => g.length > 0)
                .map(g => `country:${countryCode} AND tag:"${g}"`),
            `country:${countryCode}`,
        ];

        for (const query of queries) {
            const body = await this.getJson(
                `/artist?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
            );

            const artists = (body as any)?.artists;

            if (!Array.isArray(artists) || artists.length === 0)
                continue;

            const found = artists
                .filter(a => typeof a?.id === "string" && typeof a?.name === "string")
                // The search matches loosely; anything not actually from there
                // would put the wrong country's artists under its name.
                .filter(a => (a.country ?? "").toUpperCase() === countryCode.toUpperCase())
                .filter(a => !exclude.has(String(a.name).toLowerCase()))
                .map(a => ({ mbid: a.id as string, name: a.name as string }));

            if (found.length > 0)
                return found;
        }

        return [];
    }

    /**
     * The artist behind two or three of their songs.
     *
     * Better than a name on its own, because a title corroborates it. "Dave" on
     * its own is a coin toss between a London rapper and a Virginian jam band;
     * "Starlight" by Dave is one of them. MusicBrainz will match a recording by
     * title and credited artist together, and the credit carries the artist's
     * id, so the song does the disambiguating that the name cannot.
     *
     * Asking about more than one song is the point. A single title can match a
     * cover, a remix credited to somebody else, or a different act who happens
     * to have used the same words -- but two songs agreeing on one artist is not
     * a coincidence. It stops as soon as two agree, so the common case costs two
     * requests rather than three.
     */
    async artistIdByRecordings(
        artistName: string,
        titles: string[],
    ): Promise<{ mbid: string; votes: number } | null> {
        const wanted = normaliseName(artistName);

        if (wanted.length === 0 || titles.length === 0)
            return null;

        const votes = new Map<string, number>();

        for (const title of titles.slice(0, MB_RECORDING_PROBES)) {
            const clean = title.replace(/["\\]/g, "").trim();

            if (clean.length === 0)
                continue;

            const query = `recording:"${clean}" AND artist:"${artistName.replace(/["\\]/g, "")}"`;

            const body = await this.getJson(
                `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
            );

            const recordings = (body as any)?.recordings;

            if (!Array.isArray(recordings))
                continue;

            // One vote per song, however many recordings of it come back: a
            // track with six released versions is still one piece of evidence.
            const seen = new Set<string>();

            for (const recording of recordings) {
                if ((recording?.score ?? 0) < MB_MIN_NAME_SCORE)
                    continue;

                for (const credit of recording["artist-credit"] ?? []) {
                    const artist = credit?.artist;

                    // The credited name has to be the artist we asked about.
                    // A search for a title will happily return somebody else's
                    // cover of it.
                    if (!artist?.id || normaliseName(artist.name ?? "") !== wanted)
                        continue;

                    seen.add(artist.id);
                    break;
                }
            }

            for (const id of seen) {
                const next = (votes.get(id) ?? 0) + 1;

                votes.set(id, next);

                if (next >= 2)
                    return { mbid: id, votes: next };
            }
        }

        /*
         * One match is only accepted when there was only ever one song to ask
         * about.
         *
         * If three of their songs were available and just one matched, the other
         * two did not merely fail to help -- they declined to agree, which is a
         * reason for suspicion rather than an absence of evidence. When there is
         * a single song, one match is the best answer that could exist.
         *
         * Even then the vote count travels with it, because one song can match a
         * cover or a same-named act that used the same title, and a resolved
         * origin is otherwise never looked at again.
         */
        if (titles.length === 1 && votes.size === 1) {
            const [mbid] = [...votes.keys()];

            return { mbid, votes: 1 };
        }

        return null;
    }

    /**
     * The artist of that exact name, when the ISRC route found nothing.
     *
     * MusicBrainz's ISRC index is contributed rather than ingested, so it is
     * patchy for newer and streaming-only releases -- which is most of what
     * anybody is playing. Measured against Tempo's own catalogue, seven out of
     * eight unresolved artists were an ISRC that matched no recording, not an
     * artist without a country: Skepta, Lil Yachty and Nemzzz are all in
     * MusicBrainz, and all were unplaceable.
     *
     * Searching by name is how you find them, and it is also how you put an
     * artist in the wrong country. So the guards are strict rather than
     * generous, and an ambiguous answer is refused:
     *
     *   - the name must match exactly, not merely score well. An unquoted search
     *     for "Dave" ranks Dave Matthews Band at 100.
     *   - the score must be high anyway.
     *   - two artists of the same name from different countries cannot be told
     *     apart from a name, so neither is used.
     *
     * A gap in the map is a gap. A wrong pin is a lie, and nobody reading it can
     * tell which one they are looking at.
     */
    async artistIdByName(name: string): Promise<string | null> {
        const wanted = normaliseName(name);

        if (wanted.length === 0)
            return null;

        // Quoted, so the search is for this name rather than for these words
        const query = `artist:"${name.replace(/["\\]/g, "")}"`;

        const body = await this.getJson(
            `/artist?query=${encodeURIComponent(query)}&fmt=json&limit=8`,
        );

        const artists = (body as any)?.artists;

        if (!Array.isArray(artists))
            return null;

        const exact = artists.filter(a =>
            typeof a?.id === "string"
            && typeof a?.name === "string"
            && normaliseName(a.name) === wanted
            && (a.score ?? 0) >= MB_MIN_NAME_SCORE);

        if (exact.length === 0)
            return null;

        if (exact.length > 1) {
            const countries = new Set(
                exact.map(a => (a.country ?? "").toUpperCase()).filter(Boolean),
            );

            // Same name, different places: a name cannot tell them apart, so it
            // is not allowed to try.
            if (countries.size !== 1)
                return null;
        }

        return exact[0].id as string;
    }

    /**
     * The whole chain: a track in, an origin out.
     *
     * The ISRC first, because it is exact -- it identifies the recording rather
     * than something that shares a name with it. The name only when that finds
     * nothing, and the answer says which route it came by, so the quality of the
     * two can be told apart later.
     */
    async resolve(track: {
        isrc?: string;
        name?: string;
        titles?: string[];
    }): Promise<ArtistOrigin | null> {
        if (track.isrc) {
            const mbid = await this.artistIdForIsrc(track.isrc);

            if (mbid) {
                const origin = await this.originForMbid(mbid);

                // An ISRC identifies the recording itself, so there is nothing
                // a further song could add to it.
                if (origin?.countryCode)
                    return { ...origin, via: "isrc", corroboration: CORROBORATED };
            }
        }

        if (!track.name)
            return null;

        // Songs before a bare name: the title is what tells two artists of the
        // same name apart, and a name alone cannot.
        const probed = track.titles?.length ?? 0;
        const byRecording = await this.artistIdByRecordings(track.name, track.titles ?? []);

        if (byRecording) {
            const origin = await this.originForMbid(byRecording.mbid);

            if (origin?.countryCode) {
                return {
                    ...origin,
                    via: "recording",
                    corroboration: byRecording.votes,
                    evidence: probed,
                };
            }
        }

        const named = await this.artistIdByName(track.name);

        if (!named)
            return null;

        const origin = await this.originForMbid(named);

        // A name on its own is one piece of evidence, however strict the guards.
        // The songs that were tried are recorded even though they did not settle
        // it, so this is not mistaken later for an answer still waiting on them.
        return origin
            ? { ...origin, via: "name", corroboration: 1, evidence: probed }
            : null;
    }
}
