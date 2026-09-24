import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SongDataCache, SongData } from "./song-data-cache";

/**
 * The new-song hook.
 *
 * It is what starts a song's metadata lookup, so it has to fire exactly once
 * per song: never for a refresh of one already known, and never at the cost of
 * the write it is reporting.
 */

const HOUR = 3600e3;

function song(id: string, updatedAt = Date.now()): SongData {
    return {
        id,
        name: id,
        artists: [{ id: "a1", name: "An Artist", url: "", uri: "" }],
        duration: 200000,
        explicit: false,
        album: { id: "al1", name: "An Album", releaseDate: 0, artUrl: "" },
        isrc: "GBAAA2600001",
        type: "track",
        meta: { updatedAt },
    };
}

function withCache(test: (cache: SongDataCache) => void) {
    const dir = mkdtempSync(join(tmpdir(), "song-data-cache-"));

    try {
        test(new SongDataCache(join(dir, "cache") + "/"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("SongDataCache.onNewSong", () => {
    it("announces a song the first time it is written, and not again", () => {
        withCache(cache => {
            const seen: string[] = [];

            cache.onNewSong(s => seen.push(s.id));

            cache.setItemIfNotExist(song("s1"));
            cache.setItemIfNotExist(song("s1"));

            assert.deepEqual(seen, ["s1"]);
        });
    });

    it("does not announce a stale song being rewritten, which it already knew", () => {
        withCache(cache => {
            const seen: string[] = [];

            cache.onNewSong(s => seen.push(s.id));

            // Written long enough ago that the next write refreshes it
            cache.setItemIfNotExist(song("s1", Date.now() - 49 * HOUR));
            cache.setItemIfNotExist(song("s1"));

            assert.deepEqual(seen, ["s1"]);
        });
    });

    it("still writes the song when a listener throws", () => {
        withCache(cache => {
            cache.onNewSong(() => { throw new Error("listener failed"); });

            cache.setItemIfNotExist(song("s2"));

            assert.equal(cache.getItem("s2")?.id, "s2");
        });
    });
});

/**
 * Links to other services.
 *
 * A song heard on two services is one song, opened in whichever the listener
 * uses — so each service's id, once learned, has to survive everything that
 * rewrites the record.
 */
describe("SongDataCache links", () => {
    it("records another service's id for a known song", () => {
        withCache(cache => {
            cache.setItemIfNotExist(song("s1"));
            cache.addLinks("s1", { appleMusic: "123" });

            assert.deepEqual(cache.getItem("s1")?.links, { appleMusic: "123" });
        });
    });

    it("does not store the service the song's own id comes from", () => {
        withCache(cache => {
            cache.setItemIfNotExist(song("s1"));
            cache.addLinks("s1", { spotify: "video" });

            assert.equal(cache.getItem("s1")?.links, undefined);
        });
    });

    it("keeps the first id learned for a service", () => {
        withCache(cache => {
            cache.setItemIfNotExist(song("s1"));
            cache.addLinks("s1", { appleMusic: "123" });
            cache.addLinks("s1", { appleMusic: "456" });

            assert.deepEqual(cache.getItem("s1")?.links, { appleMusic: "123" });
        });
    });

    it("ignores a song it has no record of", () => {
        withCache(cache => {
            cache.addLinks("missing", { appleMusic: "123" });

            assert.equal(cache.getItem("missing"), null);
        });
    });

    it("keeps links when a stale song is refreshed from its own service", () => {
        withCache(cache => {
            cache.setItemIfNotExist(song("s1", Date.now() - 49 * HOUR));
            cache.addLinks("s1", { appleMusic: "123" });

            // The refresh is written by the Spotify poll, which knows nothing of Apple Music
            cache.setItemIfNotExist(song("s1"));

            assert.deepEqual(cache.getItem("s1")?.links, { appleMusic: "123" });
        });
    });

    it("links the same recording heard on another service to the song already known", () => {
        withCache(cache => {
            const spotify = song("sp1");
            const apple = { ...song("am:123"), artists: [{ id: "900", name: "An Artist", url: "", uri: "" }] };

            cache.setItemIfNotExist(spotify);
            assert.equal(cache.resolveCanonicalId(spotify), "sp1");

            cache.setItemIfNotExist(apple);

            // One ISRC, one recording
            assert.equal(cache.resolveCanonicalId(apple), "sp1");
            assert.deepEqual(cache.getItem("sp1")?.links, { appleMusic: "123" });
        });
    });
});
