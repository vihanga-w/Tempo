/**
 * Turning a listening history into a passport.
 *
 * A stamp is not "you played something from there". It is a claim that somebody
 * went somewhere, so it has to cost more than an accident: a shuffle that lands
 * one track from Mali is not a visit to Mali.
 *
 * The rule is one sentence with two ways through it, over a rolling thirty days:
 *
 *     three different artists from that country, or one artist on three
 *     separate days.
 *
 * The two halves exist because there are two honest ways to know a place.
 * Breadth is somebody shuffling into Afrobeats and coming out with Asake, Rema
 * and Ayra Starr. Depth is somebody who only loves Bjork -- a three-artist rule
 * would lock them out of Iceland forever, which would be wrong. Three days says
 * they kept coming back, and coming back is the thing worth rewarding.
 *
 * Skipped plays never count. That needs no new field: the history already
 * records `skipped` per play, and a track that was abandoned was not listened to
 * by any definition this app already uses.
 *
 * A country can be stamped again each calendar month. A single permanent badge
 * stops paying out the moment it is earned, which kills the page for exactly the
 * people who use it most -- and a real passport stamps you on every entry.
 * Stamps are only ever added; nothing here can take one away.
 */

import { countryPlace } from "./country-centroids";

/** Different artists from one country that add up to a visit. */
export const STAMP_ARTISTS = 3;

/** Separate days with one artist that add up to the same thing. */
export const STAMP_DAYS = 3;

/**
 * The window the rule is measured over.
 *
 * Rolling rather than per calendar month, so somebody who plays two Nigerian
 * artists on the 30th and a third on the 2nd is not told they achieved nothing.
 * The stamp they earn is still *dated* by month, which is what the page shows.
 */
export const STAMP_WINDOW_MS = 30 * 24 * 60 * 60e3;

export interface PassportPlay {
    songId: string;
    skipped: boolean;
    timestamp: number;
}

/** What the caller can tell us about a song. Null when it is not cached. */
export type ArtistsForSong = (songId: string) => string[] | null;

/** What the caller knows about an artist. Null when they are not resolved yet. */
export type CountryForArtist = (artistId: string) => string | null;

export interface PassportStamp {
    countryCode: string;
    name: string;
    lat: number;
    lon: number;
    continent: string;
    /** "2026-08", in UTC. */
    month: string;
    /** When the play that completed the rule happened. */
    earnedAt: number;
}

export interface PassportCountry {
    countryCode: string;
    name: string;
    lat: number;
    lon: number;
    continent: string;
    stampCount: number;
    firstAt: number;
    lastAt: number;
}

export interface CloseToEntry {
    countryCode: string;
    name: string;
    have: number;
    need: number;
    /** Which half of the rule they are closest to completing. */
    path: "artists" | "days";
}

export interface Passport {
    stamps: PassportStamp[];
    countries: PassportCountry[];
    totalStamps: number;
    totalCountries: number;
    closeTo: CloseToEntry[];
    /**
     * Plays whose artist has no resolvable origin.
     *
     * Reported rather than quietly dropped. A map that silently omits a third of
     * somebody's listening is lying by omission, and this is the number that
     * says so.
     */
    unplacedPlays: number;
    placedPlays: number;
}

/** UTC, so the same history produces the same passport wherever it is computed. */
export function monthKey(timestamp: number): string {
    const date = new Date(timestamp);
    const month = date.getUTCMonth() + 1;

    return `${date.getUTCFullYear()}-${month < 10 ? "0" : ""}${month}`;
}

/** Whole UTC days since the epoch, for counting "separate days". */
export function dayIndex(timestamp: number): number {
    return Math.floor(timestamp / 86_400_000);
}

interface PlacedPlay {
    countryCode: string;
    artistId: string;
    timestamp: number;
}

/**
 * Whether a window of plays satisfies either half of the rule.
 *
 * Exported because it is the whole mechanic, and a rule nobody can test in
 * isolation is a rule that quietly drifts.
 */
export function windowQualifies(plays: { artistId: string; timestamp: number }[]): boolean {
    const artists = new Set<string>();
    const daysByArtist = new Map<string, Set<number>>();

    for (const play of plays) {
        artists.add(play.artistId);

        let days = daysByArtist.get(play.artistId);

        if (!days) {
            days = new Set<number>();
            daysByArtist.set(play.artistId, days);
        }

        days.add(dayIndex(play.timestamp));
    }

    if (artists.size >= STAMP_ARTISTS)
        return true;

    for (const days of daysByArtist.values()) {
        if (days.size >= STAMP_DAYS)
            return true;
    }

    return false;
}

/** How far along the better of the two paths a window is. */
export function windowProgress(
    plays: { artistId: string; timestamp: number }[],
): { have: number; path: "artists" | "days" } {
    const artists = new Set<string>();
    const daysByArtist = new Map<string, Set<number>>();

    for (const play of plays) {
        artists.add(play.artistId);

        let days = daysByArtist.get(play.artistId);

        if (!days) {
            days = new Set<number>();
            daysByArtist.set(play.artistId, days);
        }

        days.add(dayIndex(play.timestamp));
    }

    let bestDays = 0;

    for (const days of daysByArtist.values())
        bestDays = Math.max(bestDays, days.size);

    // Ties go to artists: "one more artist" is a clearer instruction than "come
    // back tomorrow", and it is the path somebody can act on right now.
    return (artists.size >= bestDays)
        ? { have: artists.size, path: "artists" }
        : { have: bestDays, path: "days" };
}

/**
 * Every play reduced to a country, in time order.
 *
 * Only the first credited artist counts. A featured artist is a real
 * contributor but not whose record it is, and counting every guest verse would
 * stamp countries nobody visited.
 */
function placePlays(
    history: PassportPlay[],
    artistsForSong: ArtistsForSong,
    countryForArtist: CountryForArtist,
): { placed: PlacedPlay[]; unplaced: number } {
    const placed: PlacedPlay[] = [];
    let unplaced = 0;

    for (const play of history) {
        if (play.skipped)
            continue;

        const artists = artistsForSong(play.songId);
        const artistId = artists?.[0];

        if (!artistId) {
            unplaced++;
            continue;
        }

        const countryCode = countryForArtist(artistId);

        if (!countryCode || !countryPlace(countryCode)) {
            unplaced++;
            continue;
        }

        placed.push({ countryCode, artistId, timestamp: play.timestamp });
    }

    placed.sort((a, b) => a.timestamp - b.timestamp);

    return { placed, unplaced };
}

/**
 * The passport for one listening history.
 *
 * Stamps are found by replaying the history forwards and asking, at each play,
 * whether the previous thirty days now satisfy the rule. The first play in a
 * calendar month that does earns that month's stamp, and the country cannot earn
 * another until the month turns over. That makes the result a pure function of
 * the history: no stored counters to drift, and recomputing never loses a stamp
 * somebody already had.
 */
export function buildPassport(
    history: PassportPlay[],
    artistsForSong: ArtistsForSong,
    countryForArtist: CountryForArtist,
    now: number,
): Passport {
    const { placed, unplaced } = placePlays(history, artistsForSong, countryForArtist);

    const byCountry = new Map<string, PlacedPlay[]>();

    for (const play of placed) {
        const list = byCountry.get(play.countryCode);

        if (list)
            list.push(play);
        else
            byCountry.set(play.countryCode, [play]);
    }

    const stamps: PassportStamp[] = [];
    const countries: PassportCountry[] = [];
    const closeTo: CloseToEntry[] = [];
    const currentMonth = monthKey(now);

    for (const [countryCode, plays] of byCountry) {
        const place = countryPlace(countryCode);

        if (!place)
            continue;

        const stampedMonths = new Set<string>();
        let start = 0;

        for (let i = 0; i < plays.length; i++) {
            // Slide the window so it holds only the last thirty days up to this play
            while (plays[start].timestamp < plays[i].timestamp - STAMP_WINDOW_MS)
                start++;

            const month = monthKey(plays[i].timestamp);

            if (stampedMonths.has(month))
                continue;

            if (!windowQualifies(plays.slice(start, i + 1)))
                continue;

            stampedMonths.add(month);

            stamps.push({
                countryCode,
                name: place.name,
                lat: place.lat,
                lon: place.lon,
                continent: place.continent,
                month,
                earnedAt: plays[i].timestamp,
            });
        }

        if (stampedMonths.size > 0) {
            const earned = stamps.filter(s => s.countryCode === countryCode);

            countries.push({
                countryCode,
                name: place.name,
                lat: place.lat,
                lon: place.lon,
                continent: place.continent,
                stampCount: earned.length,
                firstAt: Math.min(...earned.map(s => s.earnedAt)),
                lastAt: Math.max(...earned.map(s => s.earnedAt)),
            });
        }

        // Close to: only countries with nothing yet this month, measured over the
        // same rolling window the rule uses. A country already stamped this month
        // has nothing left to chase until the month turns.
        if (stampedMonths.has(currentMonth))
            continue;

        const windowPlays = plays.filter(p => p.timestamp >= now - STAMP_WINDOW_MS);

        if (windowPlays.length === 0)
            continue;

        const progress = windowProgress(windowPlays);

        if (progress.have > 0 && progress.have < STAMP_ARTISTS) {
            closeTo.push({
                countryCode,
                name: place.name,
                have: progress.have,
                need: progress.path === "artists" ? STAMP_ARTISTS : STAMP_DAYS,
                path: progress.path,
            });
        }
    }

    stamps.sort((a, b) => b.earnedAt - a.earnedAt);
    countries.sort((a, b) => b.stampCount - a.stampCount || b.lastAt - a.lastAt);

    // Nearest first, and never a wall of them: this is a nudge, not an inventory.
    closeTo.sort((a, b) => (b.have / b.need) - (a.have / a.need) || a.name.localeCompare(b.name));

    return {
        stamps,
        countries,
        totalStamps: stamps.length,
        totalCountries: countries.length,
        closeTo: closeTo.slice(0, 4),
        unplacedPlays: unplaced,
        placedPlays: placed.length,
    };
}
