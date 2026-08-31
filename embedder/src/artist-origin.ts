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
        limit = 8,
    ): Promise<{ mbid: string; name: string }[]> {
        if (!/^[A-Za-z]{2}$/.test(countryCode))
            return [];

        // The strongest shared genre first, then the country alone. A tag that
        // nobody has applied in that country returns nothing rather than
        // failing, and an empty answer is not a reason to give up on the place.
        const queries = [
            ...genres.slice(0, 2).map(g => `country:${countryCode} AND tag:"${g.replace(/"/g, "")}"`),
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
                .map(a => ({ mbid: a.id as string, name: a.name as string }));

            if (found.length > 0)
                return found;
        }

        return [];
    }

    /** The whole chain: an ISRC in, an origin out. */
    async resolveByIsrc(isrc: string): Promise<ArtistOrigin | null> {
        const mbid = await this.artistIdForIsrc(isrc);

        if (!mbid)
            return null;

        return this.originForMbid(mbid);
    }
}
