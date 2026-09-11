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
