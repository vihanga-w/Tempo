import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { PassportService } from "./passport-service";
import type { ArtistOriginRecord } from "./origin-store";

/**
 * The wiring layer, with everything around it faked.
 *
 * The rules themselves are tested in passport.test.ts; what is checked here is
 * the behaviour that only exists because this class talks to slow, failing
 * things: that a resolution in flight is not started twice, that a failure is
 * written down as firmly as a success, and that a listener is told how many
 * artists are pending rather than how many plays.
 */

const T0 = Date.UTC(2026, 7, 15, 12);

function fakes(opts: {
    history?: { songId: string; skipped: boolean; timestamp: number }[];
    songs?: { [songId: string]: { id: string; name: string; isrc?: string } };
    origins?: ArtistOriginRecord[];
    resolve?: (isrc: string) => Promise<any>;
    fromCountry?: (country: string, genres: string[]) => Promise<{ mbid: string; name: string }[]>;
} = {}) {
    const stored: { [artistId: string]: ArtistOriginRecord } = {};

    const originStore = {
        get: async (id: string) => stored[id] ?? null,
        set: async (id: string, r: ArtistOriginRecord) => { stored[id] = r; return true; },
        all: async () => opts.origins ?? [],
    };

    const songMetaCache = {
        getItem: (songId: string) => {
            const artist = opts.songs?.[songId];

            return artist
                ? { id: songId, artists: [{ id: artist.id, name: artist.name }], isrc: artist.isrc }
                : null;
        },
    };

    const tasteStore = {
        get: async () => ({ history: opts.history ?? [] }),
        load: async () => ({ status: "loaded" as const, taste: null as any }),
        set: async () => true,
        exists: async () => true,
    };

    let calls = 0;

    const mb = {
        resolveByIsrc: async (isrc: string) => {
            calls++;

            return opts.resolve ? opts.resolve(isrc) : null;
        },
        artistsFromCountry: async (country: string, genres: string[]) =>
            (opts.fromCountry ? opts.fromCountry(country, genres) : []),
    };

    const service = new PassportService(
        {} as any, originStore as any, songMetaCache as any, tasteStore as any, mb as any,
    );

    return { service, stored, mbCalls: () => calls };
}

describe("PassportService", () => {
    it("counts artists pending, not plays of them", async () => {
        // One unresolved artist played two hundred times is one artist pending.
        const history = Array.from({ length: 200 }, (_, i) => ({
            songId: "s1", skipped: false, timestamp: T0 - (i * 60e3),
        }));

        const { service } = fakes({
            history,
            songs: { s1: { id: "a1", name: "An Artist", isrc: "GBAYE0000001" } },
        });

        const result = await service.buildFor("u1", T0);

        assert.equal(result.pendingArtists, 1);
    });

    it("does not queue an artist whose tracks carry no ISRC", async () => {
        const { service } = fakes({
            history: [{ songId: "s1", skipped: false, timestamp: T0 }],
            songs: { s1: { id: "a1", name: "An Artist" } },
        });

        const result = await service.buildFor("u1", T0);

        assert.equal(result.pendingArtists, 0);
        assert.equal(await service.resolveNext(), false);
    });

    it("records a success", async () => {
        const { service, stored } = fakes({
            history: [{ songId: "s1", skipped: false, timestamp: T0 }],
            songs: { s1: { id: "a1", name: "Burna Boy", isrc: "USAT22204901" } },
            resolve: async () => ({
                countryCode: "NG", city: "Port Harcourt", genres: ["afrobeats"], mbid: "x",
            }),
        });

        await service.buildFor("u1", T0);
        assert.equal(await service.resolveNext(), true);

        assert.equal(stored.a1.countryCode, "NG");
        assert.equal(stored.a1.resolved, true);
        assert.equal(stored.a1.name, "Burna Boy");
    });

    it("writes a failure down as firmly as a success", async () => {
        // Otherwise the queue refills with the same unresolvable artist forever
        // and the ones that could be answered never come up.
        const { service, stored } = fakes({
            history: [{ songId: "s1", skipped: false, timestamp: T0 }],
            songs: { s1: { id: "a1", name: "Nobody", isrc: "GBAYE0000001" } },
            resolve: async () => null,
        });

        await service.buildFor("u1", T0);
        await service.resolveNext();

        assert.equal(stored.a1.resolved, false);
        assert.equal(stored.a1.countryCode, null);
    });

    it("names artists from MusicBrainz when the catalogue has none to offer", async () => {
        const { service } = fakes({
            history: [{ songId: "s1", skipped: false, timestamp: T0 }],
            songs: { s1: { id: "a1", name: "J Hus", isrc: "GBAYE0000001" } },
            origins: [{
                artistId: "a1", name: "J Hus", countryCode: "GB", city: null,
                genres: ["uk funky"], mbid: null, resolved: true, updatedAt: T0,
            }],
            fromCountry: async () => [{ mbid: "x1", name: "Sizzla" }],
        });

        const result = await service.buildFor("u1", T0);

        // GB is the only country in the catalogue and it is unstamped, so it is
        // the candidate; the catalogue offers nobody new, MusicBrainz does.
        assert.ok(result.destination);
        assert.deepEqual(result.destination.fresh.map(f => f.name), ["Sizzla"]);
    });

    it("offers no destination when nobody new can be named", async () => {
        const { service } = fakes({
            history: [{ songId: "s1", skipped: false, timestamp: T0 }],
            songs: { s1: { id: "a1", name: "J Hus", isrc: "GBAYE0000001" } },
            origins: [{
                artistId: "a1", name: "J Hus", countryCode: "GB", city: null,
                genres: ["uk funky"], mbid: null, resolved: true, updatedAt: T0,
            }],
            fromCountry: async () => [],
        });

        assert.equal((await service.buildFor("u1", T0)).destination, null);
    });

    it("does not start a second resolution while one is in flight", async () => {
        let release: (() => void) | null = null;
        const gate = new Promise<void>(resolve => { release = resolve; });

        const { service, mbCalls } = fakes({
            history: [
                { songId: "s1", skipped: false, timestamp: T0 },
                { songId: "s2", skipped: false, timestamp: T0 },
            ],
            songs: {
                s1: { id: "a1", name: "One", isrc: "GBAYE0000001" },
                s2: { id: "a2", name: "Two", isrc: "GBAYE0000002" },
            },
            resolve: async () => { await gate; return null; },
        });

        await service.buildFor("u1", T0);

        const first = service.resolveNext();

        assert.equal(await service.resolveNext(), false, "second tick should stand down");
        assert.equal(mbCalls(), 1);

        release!();
        await first;

        // And the queue is picked back up once the first one finishes
        assert.equal(await service.resolveNext(), true);
        assert.equal(mbCalls(), 2);
    });

    it("survives a resolver that throws, and keeps resolving after", async () => {
        let first = true;

        const { service } = fakes({
            history: [
                { songId: "s1", skipped: false, timestamp: T0 },
                { songId: "s2", skipped: false, timestamp: T0 },
            ],
            songs: {
                s1: { id: "a1", name: "One", isrc: "GBAYE0000001" },
                s2: { id: "a2", name: "Two", isrc: "GBAYE0000002" },
            },
            resolve: async () => {
                if (first) {
                    first = false;
                    throw new Error("MusicBrainz fell over");
                }

                return null;
            },
        });

        await service.buildFor("u1", T0);

        await service.resolveNext();
        // A stuck in-flight flag would look exactly like an empty queue
        assert.equal(await service.resolveNext(), true);
    });
});
