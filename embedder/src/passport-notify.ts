/**
 * Telling somebody they have been stamped into a country.
 *
 * Three rules, all of them about not being a nuisance.
 *
 * A country's **first** stamp is always worth hearing about. It is somewhere
 * new, and that is the whole feature.
 *
 * A **repeat** is not, most of the time. A country can be stamped again every
 * month, which is what keeps the page paying out for somebody who deepens
 * rather than widens -- but announcing each one would send a listener with ten
 * countries ten notifications in the first days of every month, all saying they
 * still like the music they already liked. So repeats are announced only when
 * they reach a multiple of ten: a tenth stamp from one country is ten separate
 * months with that country's music in them, which is a real thing to be told.
 *
 * And an account nobody has looked at before is **not news**. Nothing records
 * what has been announced until the first sweep, so without a seeding step
 * everybody's whole back catalogue would arrive at once the first time this
 * runs -- a dozen notifications about stamps earned weeks ago. An account seen
 * for the first time is written down in silence.
 */

import type { PassportCountry } from "./passport";

/** Repeats are announced when a country's count reaches a multiple of this. */
export const REPEAT_MILESTONE = 10;

/** How many countries are named before the rest become a number. */
export const MAX_NAMED = 3;

export interface StampNotice {
    title: string;
    message: string;
}

export interface StampEvent {
    country: PassportCountry;
    kind: "new" | "milestone";
    /** Stamps held there now. */
    count: number;
}

/** Stamps held per country, as it was written down last time. */
export type StampTally = { [countryCode: string]: number };

export interface StampCheck {
    announce: StampEvent[];
    /** The whole tally to store, announced or not. */
    remember: StampTally;
    /** True when this account had never been recorded, so nothing is sent. */
    seeded: boolean;
}

/**
 * What changed since last time.
 *
 * `previous` is null for an account never recorded, which is not the same as an
 * account recorded as having nothing: the first is seeded in silence, the second
 * is somebody whose first stamp is worth hearing about.
 */
export function stampsToAnnounce(
    previous: StampTally | null,
    countries: PassportCountry[],
): StampCheck {
    const remember: StampTally = {};

    for (const country of countries)
        remember[country.countryCode] = country.stampCount;

    if (previous === null)
        return { announce: [], remember, seeded: true };

    const announce: StampEvent[] = [];

    for (const country of countries) {
        const before = previous[country.countryCode];

        if (before === undefined) {
            announce.push({ country, kind: "new", count: country.stampCount });
            continue;
        }

        // Crossed a multiple of ten since last time. Counted by which decade the
        // tally is in rather than by equality, so a country that gains two
        // stamps between sweeps and steps over the line is not missed.
        const crossed = Math.floor(country.stampCount / REPEAT_MILESTONE)
            > Math.floor(before / REPEAT_MILESTONE);

        if (crossed && country.stampCount >= REPEAT_MILESTONE)
            announce.push({ country, kind: "milestone", count: country.stampCount });
    }

    return { announce, remember, seeded: false };
}

/** "France", "France and Mali", "France, Mali and Japan and 2 more". */
function nameList(names: string[]): string {
    const shown = names.slice(0, MAX_NAMED);
    const rest = names.length - shown.length;

    const joined = shown.length === 1
        ? shown[0]
        : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;

    return rest > 0 ? `${joined} and ${rest} more` : joined;
}

const NUMBER_WORDS: { [n: number]: string } = {
    1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five",
    10: "Ten", 20: "Twenty", 30: "Thirty", 40: "Forty", 50: "Fifty",
};

function word(n: number): string {
    return NUMBER_WORDS[n] ?? String(n);
}

/**
 * One notification, or null when there is nothing worth sending.
 *
 * One per sweep, never two. Somewhere new outranks a milestone, so on the rare
 * occasion both land together the new country is what gets said -- being told
 * about a tenth French stamp matters less than being told you have reached
 * Nigeria, and two notifications at once for the same feature is how people
 * turn a feature's notifications off.
 */
export function stampNotice(
    announce: StampEvent[],
    totalCountries: number,
): StampNotice | null {
    if (announce.length === 0)
        return null;

    const fresh = announce.filter(e => e.kind === "new");

    if (fresh.length === 0) {
        const best = announce.reduce((a, b) => (b.count > a.count ? b : a));

        return {
            title: `${word(best.count)} stamps from ${best.country.name}`,
            message: `${word(best.count)} separate months with `
                + `${best.country.name}'s music in them.`,
        };
    }

    const names = fresh.map(e => e.country.name);

    // Their very first stamp is not a running total, it is a beginning
    if (totalCountries === 1 && fresh.length === 1) {
        return {
            title: "Your first stamp",
            message: `${names[0]} is in your passport.`,
        };
    }

    if (fresh.length === 1) {
        return {
            title: `${names[0]} stamped`,
            message: `That makes ${totalCountries} countries in your passport.`,
        };
    }

    return {
        title: `${word(fresh.length)} new stamps`,
        message: `${nameList(names)} are in your passport, `
            + `making ${totalCountries} countries.`,
    };
}
