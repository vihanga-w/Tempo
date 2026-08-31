import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    buildPassport,
    windowQualifies,
    windowProgress,
    monthKey,
    dayIndex,
    STAMP_WINDOW_MS,
    PassportPlay,
} from "./passport";
import { countryPlace, isKnownCountry } from "./country-centroids";
import { parseIsrcRecordings, parseArtistDoc, isRetryable } from "./artist-origin";
import { isStale, ORIGIN_RETRY_MS, ArtistOriginRecord } from "./origin-store";
import {
    genreProfile, cosine, sharedGenres, findBridge, pickDestination, weekKey,
    CatalogueArtist, ListenerArtist,
} from "./destination";
import { fallbackCopy, isUsableCopy, MAX_COPY_CHARS } from "./destination-copy";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 15, 12, 0, 0);   // 15 August 2026, midday UTC

/** A song per artist, so the fixtures read as "who", not "which track". */
function songs(map: { [songId: string]: string }) {
    return (songId: string) => (map[songId] ? [map[songId]] : null);
}

function countries(map: { [artistId: string]: string }) {
    return (artistId: string) => map[artistId] ?? null;
}

function play(songId: string, at: number, skipped = false): PassportPlay {
    return { songId, timestamp: at, skipped };
}

describe("country table", () => {
    it("places the countries the feature talks about", () => {
        for (const code of ["NG", "KR", "BR", "IS", "GB", "US", "JM", "ML"])
            assert.ok(isKnownCountry(code), `${code} should be placeable`);
    });

    it("puts Nigeria in the northern hemisphere, east of Greenwich", () => {
        const place = countryPlace("NG");

        assert.ok(place);
        assert.ok(place.lat > 0 && place.lat < 20, "latitude looks wrong");
        assert.ok(place.lon > 0 && place.lon < 15, "longitude looks wrong");
    });

    it("refuses an unknown or empty code rather than guessing", () => {
        assert.equal(countryPlace("ZZ"), null);
        assert.equal(countryPlace(""), null);
        assert.equal(countryPlace(null), null);
    });

    it("is case insensitive, because callers are", () => {
        assert.deepEqual(countryPlace("ng"), countryPlace("NG"));
    });
});

describe("the stamp rule", () => {
    it("is not met by two artists", () => {
        assert.equal(windowQualifies([
            { artistId: "a", timestamp: T0 },
            { artistId: "b", timestamp: T0 + 1000 },
        ]), false);
    });

    it("is met by three different artists", () => {
        assert.equal(windowQualifies([
            { artistId: "a", timestamp: T0 },
            { artistId: "b", timestamp: T0 + 1000 },
            { artistId: "c", timestamp: T0 + 2000 },
        ]), true);
    });

    it("is not met by one artist played three times in a day", () => {
        assert.equal(windowQualifies([
            { artistId: "a", timestamp: T0 },
            { artistId: "a", timestamp: T0 + 60e3 },
            { artistId: "a", timestamp: T0 + 120e3 },
        ]), false);
    });

    it("is met by one artist on three separate days", () => {
        assert.equal(windowQualifies([
            { artistId: "a", timestamp: T0 },
            { artistId: "a", timestamp: T0 + DAY },
            { artistId: "a", timestamp: T0 + (2 * DAY) },
        ]), true);
    });

    it("reports the further-along path, preferring artists on a tie", () => {
        assert.deepEqual(
            windowProgress([{ artistId: "a", timestamp: T0 }, { artistId: "b", timestamp: T0 }]),
            { have: 2, path: "artists" },
        );

        assert.deepEqual(
            windowProgress([{ artistId: "a", timestamp: T0 }, { artistId: "a", timestamp: T0 + DAY }]),
            { have: 2, path: "days" },
        );
    });
});

describe("buildPassport", () => {
    const songMap = songs({ s1: "a1", s2: "a2", s3: "a3", s4: "b1" });
    const countryMap = countries({ a1: "NG", a2: "NG", a3: "NG", b1: "SE" });

    it("gives an empty passport for an empty history", () => {
        const p = buildPassport([], songMap, countryMap, T0);

        assert.deepEqual(p.stamps, []);
        assert.equal(p.totalStamps, 0);
        assert.equal(p.totalCountries, 0);
    });

    it("stamps a country once three of its artists are played", () => {
        const p = buildPassport([
            play("s1", T0 - (2 * DAY)),
            play("s2", T0 - DAY),
            play("s3", T0),
        ], songMap, countryMap, T0);

        assert.equal(p.totalStamps, 1);
        assert.equal(p.stamps[0].countryCode, "NG");
        assert.equal(p.stamps[0].month, "2026-08");
        assert.equal(p.totalCountries, 1);
    });

    it("does not stamp on skipped plays", () => {
        const p = buildPassport([
            play("s1", T0 - (2 * DAY), true),
            play("s2", T0 - DAY, true),
            play("s3", T0, true),
        ], songMap, countryMap, T0);

        assert.equal(p.totalStamps, 0);
    });

    it("does not stamp when the three artists fall outside one window", () => {
        const p = buildPassport([
            play("s1", T0 - (80 * DAY)),
            play("s2", T0 - (45 * DAY)),
            play("s3", T0),
        ], songMap, countryMap, T0);

        assert.equal(p.totalStamps, 0);
    });

    it("stamps the same country again in a later month", () => {
        const august = [play("s1", T0 - (2 * DAY)), play("s2", T0 - DAY), play("s3", T0)];
        const september = [
            play("s1", T0 + (20 * DAY)),
            play("s2", T0 + (21 * DAY)),
            play("s3", T0 + (22 * DAY)),
        ];

        const p = buildPassport([...august, ...september], songMap, countryMap, T0 + (23 * DAY));

        assert.equal(p.totalStamps, 2);
        assert.equal(p.totalCountries, 1);
        assert.deepEqual(p.stamps.map(s => s.month), ["2026-09", "2026-08"]);
    });

    it("only stamps a country once within one month", () => {
        const p = buildPassport([
            play("s1", T0 - (5 * DAY)),
            play("s2", T0 - (4 * DAY)),
            play("s3", T0 - (3 * DAY)),
            play("s1", T0 - (2 * DAY)),
            play("s2", T0 - DAY),
            play("s3", T0),
        ], songMap, countryMap, T0);

        assert.equal(p.totalStamps, 1);
    });

    it("orders stamps newest first", () => {
        const p = buildPassport([
            play("s1", T0 - (2 * DAY)), play("s2", T0 - DAY), play("s3", T0),
            play("s1", T0 + (35 * DAY)), play("s2", T0 + (36 * DAY)), play("s3", T0 + (37 * DAY)),
        ], songMap, countryMap, T0 + (38 * DAY));

        assert.ok(p.stamps[0].earnedAt > p.stamps[1].earnedAt);
    });

    it("counts plays it cannot place rather than hiding them", () => {
        const p = buildPassport([
            play("s1", T0), play("unknown-song", T0), play("s4", T0),
        ], songMap, countries({ a1: "NG" }), T0);

        assert.equal(p.placedPlays, 1);
        assert.equal(p.unplacedPlays, 2);
    });

    it("treats an unplaceable country code as unplaced", () => {
        const p = buildPassport(
            [play("s1", T0)], songMap, countries({ a1: "ZZ" }), T0,
        );

        assert.equal(p.placedPlays, 0);
        assert.equal(p.unplacedPlays, 1);
    });

    it("offers a nudge for a country two artists in", () => {
        const p = buildPassport([
            play("s1", T0 - DAY), play("s2", T0),
        ], songMap, countryMap, T0);

        assert.equal(p.totalStamps, 0);
        assert.equal(p.closeTo.length, 1);
        assert.deepEqual(
            { ...p.closeTo[0], name: undefined },
            { countryCode: "NG", name: undefined, have: 2, need: 3, path: "artists" },
        );
    });

    it("drops a country from the nudge once it is stamped this month", () => {
        const p = buildPassport([
            play("s1", T0 - (2 * DAY)), play("s2", T0 - DAY), play("s3", T0),
        ], songMap, countryMap, T0);

        assert.equal(p.closeTo.length, 0);
    });

    it("does not nudge on listening older than the window", () => {
        const p = buildPassport(
            [play("s1", T0 - STAMP_WINDOW_MS - DAY)], songMap, countryMap, T0,
        );

        assert.equal(p.closeTo.length, 0);
    });

    it("never returns more than four nudges", () => {
        const many: PassportPlay[] = [];
        const songMapMany: { [k: string]: string } = {};
        const countryMapMany: { [k: string]: string } = {};
        const codes = ["NG", "SE", "BR", "KR", "JP", "ZA", "FR", "IS"];

        codes.forEach((code, i) => {
            songMapMany[`x${i}`] = `art${i}`;
            countryMapMany[`art${i}`] = code;
            many.push(play(`x${i}`, T0 - (i * 60e3)));
        });

        const p = buildPassport(many, songs(songMapMany), countries(countryMapMany), T0);

        assert.equal(p.closeTo.length, 4);
    });

    it("is stable: recomputing the same history gives the same stamps", () => {
        const history = [
            play("s1", T0 - (3 * DAY)), play("s2", T0 - (2 * DAY)), play("s3", T0 - DAY),
        ];

        assert.deepEqual(
            buildPassport(history, songMap, countryMap, T0),
            buildPassport(history, songMap, countryMap, T0),
        );
    });
});

describe("month and day keys", () => {
    it("formats a month with a leading zero", () => {
        assert.equal(monthKey(Date.UTC(2026, 0, 5)), "2026-01");
        assert.equal(monthKey(Date.UTC(2026, 10, 5)), "2026-11");
    });

    it("puts two times on the same UTC day in one bucket", () => {
        assert.equal(
            dayIndex(Date.UTC(2026, 7, 15, 1)),
            dayIndex(Date.UTC(2026, 7, 15, 23)),
        );
    });
});

describe("MusicBrainz parsing", () => {
    it("takes the first credited artist from an ISRC lookup", () => {
        const mbid = parseIsrcRecordings({
            recordings: [{
                title: "Last Last",
                "artist-credit": [
                    { artist: { id: "78a19169-ac75-4868-b504-7e2e073118e0", name: "Burna Boy" } },
                    { artist: { id: "other", name: "A Feature" } },
                ],
            }],
        });

        assert.equal(mbid, "78a19169-ac75-4868-b504-7e2e073118e0");
    });

    it("returns null for a body with no recordings", () => {
        assert.equal(parseIsrcRecordings({}), null);
        assert.equal(parseIsrcRecordings({ recordings: [] }), null);
        assert.equal(parseIsrcRecordings(null), null);
    });

    it("reads country, city and genres from an artist document", () => {
        const origin = parseArtistDoc({
            id: "78a19169-ac75-4868-b504-7e2e073118e0",
            country: "NG",
            area: { name: "Nigeria" },
            "begin-area": { name: "Port Harcourt", type: "City" },
            genres: [
                { name: "dancehall", count: 1 },
                { name: "afrobeats", count: 5 },
            ],
        });

        assert.equal(origin.countryCode, "NG");
        assert.equal(origin.city, "Port Harcourt");
        assert.deepEqual(origin.genres, ["afrobeats", "dancehall"]);
    });

    it("falls back to the area's ISO code when there is no country", () => {
        const origin = parseArtistDoc({
            area: { name: "Sweden", "iso-3166-1-codes": ["SE"] },
        });

        assert.equal(origin.countryCode, "SE");
    });

    it("does not use the area name as a city", () => {
        const origin = parseArtistDoc({ country: "SE", area: { name: "Sweden" } });

        assert.equal(origin.city, null);
    });

    it("rejects anything that is not a two letter code", () => {
        assert.equal(parseArtistDoc({ country: "NGA" }).countryCode, null);
        assert.equal(parseArtistDoc({ country: 7 }).countryCode, null);
        assert.equal(parseArtistDoc({}).countryCode, null);
    });

    it("treats a busy service as worth retrying and a 404 as not", () => {
        assert.equal(isRetryable(503), true);
        assert.equal(isRetryable(429), true);
        assert.equal(isRetryable(404), false);
    });
});

describe("origin cache staleness", () => {
    const resolved: ArtistOriginRecord = {
        countryCode: "NG", city: null, genres: [], mbid: null,
        resolved: true, updatedAt: T0 - (10 * 365 * DAY),
    };

    it("never re-reads a resolved artist, however old", () => {
        assert.equal(isStale(resolved, T0), false);
    });

    it("re-reads an unresolved artist after the retry window", () => {
        const failed = { ...resolved, resolved: false, updatedAt: T0 - ORIGIN_RETRY_MS - 1 };

        assert.equal(isStale(failed, T0), true);
    });

    it("leaves a recent failure alone", () => {
        const failed = { ...resolved, resolved: false, updatedAt: T0 - 1000 };

        assert.equal(isStale(failed, T0), false);
    });

    it("treats a missing record as stale", () => {
        assert.equal(isStale(null, T0), true);
    });
});

describe("choosing a destination", () => {
    const listener: ListenerArtist[] = [
        { artistId: "l1", name: "J Hus", countryCode: "GB", genres: ["afroswing", "uk funky"], plays: 40 },
        { artistId: "l2", name: "Fred again..", countryCode: "GB", genres: ["uk garage", "house"], plays: 30 },
    ];

    const catalogue: CatalogueArtist[] = [
        { artistId: "n1", name: "Asake", countryCode: "NG", genres: ["afrobeats", "uk funky"] },
        { artistId: "n2", name: "Rema", countryCode: "NG", genres: ["afrobeats"] },
        { artistId: "n3", name: "Ayra Starr", countryCode: "NG", genres: ["afrobeats", "uk funky"] },
        { artistId: "s1", name: "Solo Act", countryCode: "MN", genres: ["throat singing"] },
    ];

    it("picks a country the listener shares genres with", () => {
        const d = pickDestination(listener, catalogue, new Set(), T0);

        assert.ok(d);
        assert.equal(d.countryCode, "NG");
        assert.equal(d.bridge.name, "J Hus");
        assert.ok(d.fresh.length > 0);
        assert.ok(d.affinity > 0);
    });

    it("never suggests somewhere already visited", () => {
        assert.equal(pickDestination(listener, catalogue, new Set(["NG"]), T0), null);
    });

    it("ignores a country with too few artists to be a scene", () => {
        const d = pickDestination(listener, catalogue, new Set(["NG"]), T0);

        assert.equal(d, null, "Mongolia has one artist and should not qualify");
    });

    it("returns null for a listener with no genre profile", () => {
        const blank = [{ artistId: "x", name: "X", countryCode: null, genres: [], plays: 5 }];

        assert.equal(pickDestination(blank, catalogue, new Set(), T0), null);
    });

    it("will not offer a country whose artists they have all already played", () => {
        const played = listener.concat(
            catalogue.filter(c => c.countryCode === "NG").map(c => ({
                artistId: c.artistId, name: c.name, countryCode: c.countryCode,
                genres: c.genres, plays: 1,
            })),
        );

        assert.equal(pickDestination(played, catalogue, new Set(), T0), null);
    });

    it("weights a genre profile by plays", () => {
        const profile = genreProfile([
            { genres: ["house"], weight: 10 },
            { genres: ["house", "techno"], weight: 1 },
        ]);

        assert.equal(profile.get("house"), 11);
        assert.equal(profile.get("techno"), 1);
    });

    it("scores identical profiles at one and disjoint ones at zero", () => {
        const a = genreProfile([{ genres: ["house"], weight: 3 }]);
        const b = genreProfile([{ genres: ["house"], weight: 9 }]);
        const c = genreProfile([{ genres: ["polka"], weight: 9 }]);

        assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9);
        assert.equal(cosine(a, c), 0);
        assert.equal(cosine(a, new Map()), 0);
    });

    it("orders shared genres by how much the listener plays them", () => {
        const listenerProfile = genreProfile([
            { genres: ["afrobeats"], weight: 1 },
            { genres: ["uk funky"], weight: 50 },
        ]);
        const countryProfile = genreProfile([{ genres: ["afrobeats", "uk funky"], weight: 1 }]);

        assert.deepEqual(sharedGenres(listenerProfile, countryProfile), ["uk funky", "afrobeats"]);
    });

    it("finds no bridge when nothing overlaps", () => {
        const countryProfile = genreProfile([{ genres: ["polka"], weight: 1 }]);

        assert.equal(findBridge(listener, countryProfile), null);
    });

    it("holds one destination for a whole ISO week", () => {
        const monday = Date.UTC(2026, 7, 10);
        const sunday = Date.UTC(2026, 7, 16);

        assert.equal(weekKey(monday), weekKey(sunday));
        assert.notEqual(weekKey(monday), weekKey(Date.UTC(2026, 7, 17)));
    });
});

describe("destination copy", () => {
    const destination = {
        countryCode: "NG", name: "Nigeria", lat: 9, lon: 8, continent: "Africa",
        affinity: 0.4, sharedGenres: ["afrobeats", "uk funky"],
        bridge: { artistId: "l1", name: "J Hus" },
        fresh: [{ artistId: "n1", name: "Asake" }],
    };

    it("writes a usable sentence with no model at all", () => {
        const text = fallbackCopy(destination);

        assert.ok(text.includes("Nigeria"));
        assert.ok(text.includes("J Hus"));
        assert.ok(isUsableCopy(text, destination));
    });

    it("still works when no genres are shared", () => {
        const text = fallbackCopy({ ...destination, sharedGenres: [] });

        assert.ok(isUsableCopy(text, destination));
    });

    it("rejects copy that invents a statistic", () => {
        assert.equal(
            isUsableCopy("Nigeria makes up 40% of what you play.", destination),
            false,
        );
    });

    it("rejects copy that never mentions the country", () => {
        assert.equal(isUsableCopy("You should hear what they are doing there.", destination), false);
    });

    it("rejects an assistant preamble, markdown and over-long answers", () => {
        assert.equal(isUsableCopy("Sure! Nigeria is great.", destination), false);
        assert.equal(isUsableCopy("**Nigeria** is great.", destination), false);
        assert.equal(isUsableCopy("Nigeria ".repeat(MAX_COPY_CHARS), destination), false);
        assert.equal(isUsableCopy("   ", destination), false);
    });
});
