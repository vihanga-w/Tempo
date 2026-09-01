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
import { currentPlaceholders } from "./profile-blob";
import {
    parseIsrcRecordings, parseArtistDoc, isRetryable, MusicBrainzClient,
} from "./artist-origin";
import {
    isStale, ORIGIN_RETRY_MS, RESOLVER_STRATEGY, ArtistOriginRecord,
} from "./origin-store";
import {
    genreProfile, cosine, sharedGenres, findBridge, pickDestination, weekKey,
    CatalogueArtist, ListenerArtist,
} from "./destination";
import { fallbackCopy, isUsableCopy, MAX_COPY_CHARS } from "./destination-copy";
import { isSecureEndpoint } from "./secure-url";

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

describe("placeholders that are still current", () => {
    const url = "https://pic/now.jpg";

    it("sends both when both were made from the picture being sent", () => {
        assert.deepEqual(currentPlaceholders({
            images: [{ url }],
            profilePictureColourBlob: "blob", profilePictureColourBlobFor: url,
            profilePictureBlurHash: "hash", profilePictureBlurHashFor: url,
        }), { colourBlob: "blob", blurHash: "hash" });
    });

    it("withholds one made from the picture before this one", () => {
        // Somebody who changes their picture has the new URL at once and the new
        // placeholder only after the refresh. In that window the stored value
        // describes the photograph they just replaced.
        assert.deepEqual(currentPlaceholders({
            images: [{ url }],
            profilePictureColourBlob: "old", profilePictureColourBlobFor: "https://pic/old.jpg",
            profilePictureBlurHash: "hash", profilePictureBlurHashFor: url,
        }), { colourBlob: undefined, blurHash: "hash" });
    });

    it("sends nothing for an account with no picture", () => {
        assert.deepEqual(currentPlaceholders({
            profilePictureColourBlob: "left", profilePictureColourBlobFor: "https://pic/gone.jpg",
        }), {});
    });

    it("sends nothing when there is no account", () => {
        assert.deepEqual(currentPlaceholders(undefined), {});
    });
});

describe("country table", () => {
    it("places the territories Natural Earth drops but MusicBrainz reports", () => {
        // Not academic: zouk is from Guadeloupe and Martinique, maloya from
        // Reunion. Without these the artists resolve and are then discarded.
        for (const code of ["BQ", "GP", "MQ", "RE", "GF", "GI", "YT"])
            assert.ok(isKnownCountry(code), `${code} should be placeable`);

        const martinique = countryPlace("MQ");

        assert.ok(martinique);
        assert.equal(martinique.name, "Martinique");
        assert.ok(martinique.lat > 14 && martinique.lat < 15);
    });

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

    it("will not re-earn a stamp from listening that already paid for one", () => {
        // Three artists in early August earns August. On 1 September those plays
        // are still inside the rolling thirty days, so without consuming the
        // evidence a single accidental track earned September too -- which is
        // precisely the accident the rule exists to refuse.
        const p = buildPassport([
            play("s1", Date.UTC(2026, 7, 2)),
            play("s2", Date.UTC(2026, 7, 3)),
            play("s3", Date.UTC(2026, 7, 4)),
            play("s1", Date.UTC(2026, 8, 1)),
        ], songMap, countryMap, Date.UTC(2026, 8, 2));

        assert.equal(p.totalStamps, 1);
        assert.equal(p.stamps[0].month, "2026-08");
    });

    it("earns a second stamp from three fresh artists in a new month", () => {
        const p = buildPassport([
            play("s1", Date.UTC(2026, 7, 2)),
            play("s2", Date.UTC(2026, 7, 3)),
            play("s3", Date.UTC(2026, 7, 4)),
            play("s1", Date.UTC(2026, 8, 1)),
            play("s2", Date.UTC(2026, 8, 2)),
            play("s3", Date.UTC(2026, 8, 3)),
        ], songMap, countryMap, Date.UTC(2026, 8, 4));

        assert.equal(p.totalStamps, 2);
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

describe("finding an artist by name", () => {
    /** A MusicBrainz client with the network replaced by a canned answer. */
    function client(artists: any[]) {
        const fetchImpl = async () => ({
            ok: true, status: 200, json: async () => ({ artists }),
        });

        return new MusicBrainzClient(fetchImpl as any, 0, async () => {});
    }

    it("takes an unambiguous exact match", async () => {
        const mb = client([{ id: "abc", name: "Skepta", country: "GB", score: 100 }]);

        assert.equal(await mb.artistIdByName("Skepta"), "abc");
    });

    it("ignores a hit that merely scores well", async () => {
        // An unquoted search for "Dave" ranks Dave Matthews Band at 100
        const mb = client([{ id: "x", name: "Dave Matthews Band", country: "US", score: 100 }]);

        assert.equal(await mb.artistIdByName("Dave"), null);
    });

    it("refuses two artists of the same name from different countries", async () => {
        // A name cannot tell them apart, so it is not allowed to try
        const mb = client([
            { id: "a", name: "Origin", country: "US", score: 100 },
            { id: "b", name: "Origin", country: "SE", score: 98 },
        ]);

        assert.equal(await mb.artistIdByName("Origin"), null);
    });

    it("refuses a namesake with no country, whichever order they arrive in", async () => {
        // Dropping the countryless one before comparing made a British artist
        // and a nameless twin look unambiguous -- and returned whichever
        // MusicBrainz happened to list first, so the same Spotify artist could
        // resolve two different ways on two different days.
        const forwards = client([
            { id: "known", name: "Origin", country: "GB", score: 100 },
            { id: "nowhere", name: "Origin", score: 99 },
        ]);
        const backwards = client([
            { id: "nowhere", name: "Origin", score: 99 },
            { id: "known", name: "Origin", country: "GB", score: 100 },
        ]);

        assert.equal(await forwards.artistIdByName("Origin"), null);
        assert.equal(await backwards.artistIdByName("Origin"), null);
    });

    it("does not treat one artist listed twice as two people", async () => {
        const mb = client([
            { id: "same", name: "Origin", country: "GB", score: 100 },
            { id: "same", name: "Origin", country: "GB", score: 100 },
        ]);

        assert.equal(await mb.artistIdByName("Origin"), "same");
    });

    it("picks the same one of two agreeing namesakes every time", async () => {
        const forwards = client([
            { id: "bbb", name: "Origin", country: "GB", score: 95 },
            { id: "aaa", name: "Origin", country: "GB", score: 100 },
        ]);
        const backwards = client([
            { id: "aaa", name: "Origin", country: "GB", score: 100 },
            { id: "bbb", name: "Origin", country: "GB", score: 95 },
        ]);

        assert.equal(await forwards.artistIdByName("Origin"), "aaa");
        assert.equal(await backwards.artistIdByName("Origin"), "aaa");
    });

    it("accepts two of the same name when they agree on the country", async () => {
        const mb = client([
            { id: "a", name: "Origin", country: "GB", score: 100 },
            { id: "b", name: "Origin", country: "GB", score: 95 },
        ]);

        assert.equal(await mb.artistIdByName("Origin"), "a");
    });

    it("ignores a low-scoring match even when the name is exact", async () => {
        const mb = client([{ id: "a", name: "Skepta", country: "GB", score: 40 }]);

        assert.equal(await mb.artistIdByName("Skepta"), null);
    });

    it("matches regardless of case and spacing", async () => {
        const mb = client([{ id: "a", name: "Lil  Yachty", country: "US", score: 100 }]);

        assert.equal(await mb.artistIdByName("lil yachty"), "a");
    });

    it("asks nothing for an empty name", async () => {
        const mb = client([{ id: "a", name: "", country: "US", score: 100 }]);

        assert.equal(await mb.artistIdByName("   "), null);
    });
});

describe("finding an artist by their songs", () => {
    /** A client whose network is a lookup table of query substring to answer. */
    function client(answers: { [contains: string]: any }) {
        const fetchImpl = async (url: string) => {
            const key = Object.keys(answers).find(k => decodeURIComponent(url).includes(k));

            return {
                ok: true, status: 200,
                json: async () => (key ? answers[key] : { recordings: [] }),
            };
        };

        return new MusicBrainzClient(fetchImpl as any, 0, async () => {});
    }

    const rec = (artist: string, id: string, score = 100) => ({
        recordings: [{ title: "A Song", score, "artist-credit": [{ artist: { id, name: artist } }] }],
    });

    it("accepts an artist two of their songs agree on", async () => {
        const mb = client({ "Starlight": rec("Dave", "uk-dave"), "Location": rec("Dave", "uk-dave") });

        const found = await mb.artistIdByRecordings("Dave", ["Starlight", "Location", "Titanium"]);

        assert.equal(found?.mbid, "uk-dave");
        assert.equal(found?.votes, 2, "two songs agreed, and the count says so");
    });

    it("refuses when the songs point at different artists", async () => {
        // Exactly the case a bare name cannot see: two acts called Dave
        const mb = client({ "Starlight": rec("Dave", "uk-dave"), "Crash": rec("Dave", "us-dave") });

        assert.equal(await mb.artistIdByRecordings("Dave", ["Starlight", "Crash"]), null);
    });

    it("ignores somebody else's cover of the same song", async () => {
        const mb = client({ "Shutdown": rec("A Covers Band", "someone-else") });

        assert.equal(await mb.artistIdByRecordings("Skepta", ["Shutdown"]), null);
    });

    it("ignores a weak match however exact the name", async () => {
        const mb = client({ "Shutdown": rec("Skepta", "skepta", 40) });

        assert.equal(await mb.artistIdByRecordings("Skepta", ["Shutdown"]), null);
    });

    it("counts one song once even across several of its recordings", async () => {
        const many = {
            recordings: Array.from({ length: 6 }, () => ({
                title: "Shutdown", score: 100,
                "artist-credit": [{ artist: { id: "skepta", name: "Skepta" } }],
            })),
        };

        const mb = client({ "Shutdown": many });
        const found = await mb.artistIdByRecordings("Skepta", ["Shutdown"]);

        assert.equal(found?.votes, 1, "six pressings of one song is one song");
    });

    it("takes a single song when it is the only one there is", async () => {
        const mb = client({ "Shutdown": rec("Skepta", "skepta") });
        const found = await mb.artistIdByRecordings("Skepta", ["Shutdown"]);

        assert.equal(found?.mbid, "skepta");
        assert.equal(found?.votes, 1, "one song, and it does not pretend otherwise");
    });

    it("refuses a lone match when other songs were there and did not agree", async () => {
        // Two songs available, one matched: the others did not merely fail to
        // help, they declined to agree, which is a reason for suspicion rather
        // than an absence of evidence.
        const mb = client({ "Shutdown": rec("Skepta", "skepta") });

        assert.equal(
            await mb.artistIdByRecordings("Skepta", ["Shutdown", "Konnichiwa"]),
            null,
        );
    });

    it("will not let one song stand in for two", async () => {
        // A track with six released versions is one piece of evidence, not six,
        // so it cannot corroborate itself into a second vote.
        const many = {
            recordings: Array.from({ length: 6 }, () => ({
                title: "Shutdown", score: 100,
                "artist-credit": [{ artist: { id: "skepta", name: "Skepta" } }],
            })),
        };

        const mb = client({ "Shutdown": many });

        assert.equal(await mb.artistIdByRecordings("Skepta", ["Shutdown", "Nothing Else"]), null);
    });

    it("has nothing to go on without a name or a title", async () => {
        const mb = client({});

        assert.equal(await mb.artistIdByRecordings("", ["Shutdown"]), null);
        assert.equal(await mb.artistIdByRecordings("Skepta", []), null);
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
        const failed = {
            ...resolved, resolved: false, strategy: RESOLVER_STRATEGY,
            updatedAt: T0 - ORIGIN_RETRY_MS - 1,
        };

        assert.equal(isStale(failed, T0), true);
    });

    it("re-reads a recent failure that predates the strategy field", () => {
        // No strategy recorded means it was written by the first one, which
        // knew only how to follow an ISRC.
        const failed = { ...resolved, resolved: false, updatedAt: T0 - 1000 };

        assert.equal(isStale(failed, T0), true);
    });

    it("re-reads a failure recorded by an older resolver, whatever its age", () => {
        // A failure is a failure of the strategy that produced it. When the ISRC
        // route was all there was, 145 artists were written off who are findable
        // by their songs; without this they would sit out the fortnight first.
        const old = { ...resolved, resolved: false, strategy: 1, updatedAt: T0 - 1000 };

        assert.equal(isStale(old, T0), true);
    });

    it("leaves a recent failure from the current resolver alone", () => {
        const now = {
            ...resolved, resolved: false, strategy: RESOLVER_STRATEGY, updatedAt: T0 - 1000,
        };

        assert.equal(isStale(now, T0), false);
    });

    it("does not re-read a resolved artist just because the resolver moved on", () => {
        const old = { ...resolved, strategy: 1 };

        assert.equal(isStale(old, T0), false);
    });

    it("re-reads a country reached from a single song once a second turns up", () => {
        // A resolved origin is never read again, so a weak answer would
        // otherwise outlive every chance to correct it.
        const weak = { ...resolved, via: "recording" as const, corroboration: 1, evidence: 1 };

        assert.equal(isStale(weak, T0, 1), false, "nothing new to check it against");
        assert.equal(isStale(weak, T0, 2), true, "a second song can settle it");
    });

    it("does not chase an artist whose songs have already disagreed", () => {
        // Three songs weighed, no two agreed, so it fell through to the name.
        // A fourth cannot be added to a tally nobody kept.
        const weak = { ...resolved, via: "name" as const, corroboration: 1, evidence: 3 };

        assert.equal(isStale(weak, T0, 4), false);
    });

    it("stops once two or more of their songs have been weighed", () => {
        // Chasing this further needs the vote tally carried between attempts,
        // or the evidence splits across rechecks and never adds up.
        const weighed = {
            ...resolved, via: "name" as const, corroboration: 1, evidence: 2,
        };

        assert.equal(isStale(weighed, T0, 9), false);
    });

    it("does not re-read an answer whose songs were already tried and disagreed", () => {
        // The name route is reached when the recording searches fail to agree.
        // Asking again runs the same searches to the same end -- on every read
        // of the page, for ever.
        const fellThrough = {
            ...resolved, via: "name" as const, corroboration: 1, evidence: 2,
        };

        assert.equal(isStale(fellThrough, T0, 2), false);
        assert.equal(isStale(fellThrough, T0, 3), false);
    });

    it("leaves a corroborated origin alone however many songs arrive", () => {
        const strong = { ...resolved, via: "recording" as const, corroboration: 2 };

        assert.equal(isStale(strong, T0, 9), false);
    });

    it("treats an ISRC answer as settled, because it identifies the recording", () => {
        const exact = { ...resolved, via: "isrc" as const };

        assert.equal(isStale(exact, T0, 9), false);
    });

    it("treats a record from before any of this as an ISRC answer", () => {
        // Everything in the database predates via and corroboration, and all of
        // it came by ISRC.
        assert.equal(isStale(resolved, T0, 9), false);
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

    it("can offer a country known by a single artist", () => {
        // The gate used to be three artists, which made a destination
        // impossible: three artists from a country is exactly what earns a
        // stamp, and stamped countries are excluded, so every country was
        // either too small to qualify or already visited.
        //
        // Exactly one artist from the candidate country, and nothing else in
        // the catalogue: appending to the shared fixture gave Mongolia two, so
        // the test passed just as happily with a threshold of two.
        const oneLead: CatalogueArtist[] = [
            { artistId: "m2", name: "Ulzii", countryCode: "MN", genres: ["uk funky"] },
        ];

        const d = pickDestination(listener, oneLead, new Set(), T0);

        assert.ok(d, "one artist sharing a genre should be enough of a lead");
        assert.equal(d.countryCode, "MN");
        assert.equal(d.bridge.name, "J Hus");
    });

    it("still refuses a country with nothing in common", () => {
        // Mongolia's only catalogue artist sings throat singing, which shares
        // nothing with this listener. Opening the artist-count gate must not
        // open this one.
        assert.equal(pickDestination(listener, catalogue, new Set(["NG"]), T0), null);
    });

    it("returns null for a listener with no genre profile", () => {
        const blank = [{ artistId: "x", name: "X", countryCode: null, genres: [], plays: 5 }];

        assert.equal(pickDestination(blank, catalogue, new Set(), T0), null);
    });

    it("returns no fresh names when the catalogue holds none, leaving them to be found", () => {
        // Not a refusal: Tempo's catalogue is what people here already play, so
        // for most places it has nothing new. The service fills these in from
        // MusicBrainz and refuses only if that comes back empty too.
        const played = listener.concat(
            catalogue.filter(c => c.countryCode === "NG").map(c => ({
                artistId: c.artistId, name: c.name, countryCode: c.countryCode,
                genres: c.genres, plays: 1,
            })),
        );

        const d = pickDestination(played, catalogue, new Set(), T0);

        assert.ok(d);
        assert.deepEqual(d.fresh, []);
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

    it("knows the difference between unstamped and never played", () => {
        // A single play earns no stamp, so an unstamped country can still be
        // one they have heard -- and saying otherwise hands a model a lie.
        const heard = listener.concat([{
            artistId: "n2", name: "Rema", countryCode: "NG",
            genres: ["afrobeats"], plays: 1,
        }]);

        assert.equal(pickDestination(listener, catalogue, new Set(), T0)?.neverPlayed, true);
        assert.equal(pickDestination(heard, catalogue, new Set(), T0)?.neverPlayed, false);
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
        affinity: 0.4, sharedGenres: ["afrobeats", "uk funky"], neverPlayed: true,
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

    it("does not claim they have never been somewhere they have heard", () => {
        const heard = { ...destination, neverPlayed: false, sharedGenres: [] };
        const text = fallbackCopy(heard);

        assert.ok(!text.includes("never played"), text);
        assert.ok(isUsableCopy(text, heard));
    });

    it("will not send the key to a cleartext endpoint", () => {
        assert.equal(isSecureEndpoint("https://api.groq.com/openai/v1"), true);
        assert.equal(isSecureEndpoint("http://api.groq.com/openai/v1"), false);
        assert.equal(isSecureEndpoint("http://evil.example/v1"), false);
        assert.equal(isSecureEndpoint("not a url"), false);
        // A local proxy never leaves the machine
        assert.equal(isSecureEndpoint("http://localhost:8080/v1"), true);
        assert.equal(isSecureEndpoint("http://127.0.0.1:8080/v1"), true);
    });

    it("rejects an assistant preamble, markdown and over-long answers", () => {
        assert.equal(isUsableCopy("Sure! Nigeria is great.", destination), false);
        assert.equal(isUsableCopy("**Nigeria** is great.", destination), false);
        assert.equal(isUsableCopy("Nigeria ".repeat(MAX_COPY_CHARS), destination), false);
        assert.equal(isUsableCopy("   ", destination), false);
    });
});
