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

const ALBUM_ART = "https://i.scdn.co/image/ab67616d0000b273aaaa";
const VIDEO_ART = "https://i.scdn.co/image/ab6742d3000053b7bbbb";

function spotifySong(id: string, art: string, name = "A Song"): SongData {
    return { ...song(id), name, album: { id: "al1", name: "An Album", releaseDate: 0, artUrl: art } };
}

function appleSong(id: string): SongData {
    return {
        ...song(id),
        name: "A Song",
        artists: [{ id: "900", name: "An Artist", url: "", uri: "" }],
        album: { id: "am-al1", name: "An Album", releaseDate: 0, artUrl: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg" },
    };
}

describe("SongDataCache links across reconciliation", () => {
    it("carries a demoted song's links onto the release promoted over it", () => {
        withCache(cache => {
            const apple = appleSong("am:123");
            const release = spotifySong("audio1", ALBUM_ART);

            cache.setItemIfNotExist(apple);
            assert.equal(cache.resolveCanonicalId(apple), "am:123");

            cache.setItemIfNotExist(release);
            assert.equal(cache.resolveCanonicalId(release), "audio1");

            assert.deepEqual(cache.getItem("audio1")?.links, { appleMusic: "123" });
        });
    });

    it("answers for a demoted id through the song it was reconciled into", () => {
        withCache(cache => {
            const apple = appleSong("am:123");
            const release = spotifySong("audio1", ALBUM_ART);

            cache.setItemIfNotExist(apple);
            cache.resolveCanonicalId(apple);
            cache.setItemIfNotExist(release);
            cache.resolveCanonicalId(release);

            // Plays recorded under am:123 before the release was known
            assert.deepEqual(cache.linksFor("am:123"), { spotify: "audio1", appleMusic: "123" });
        });
    });

    it("prefers the canonical song's link to one the demoted id holds", () => {
        withCache(cache => {
            const apple = appleSong("am:123");

            cache.setItemIfNotExist(apple);
            cache.resolveCanonicalId(apple);

            // Recorded on am:123 before this change stopped video links
            cache.addLinks("am:123", { spotify: "vid1" });

            const release = spotifySong("audio1", ALBUM_ART);

            cache.setItemIfNotExist(release);
            cache.resolveCanonicalId(release);

            assert.equal(cache.linksFor("am:123").spotify, "audio1");
        });
    });

    it("does not link a music video as the song's release", () => {
        withCache(cache => {
            const apple = appleSong("am:123");
            const video = spotifySong("vid1", VIDEO_ART, "A Song (Official Video)");

            cache.setItemIfNotExist(apple);
            cache.resolveCanonicalId(apple);

            cache.setItemIfNotExist(video);
            assert.equal(cache.resolveCanonicalId(video), "am:123");

            assert.equal(cache.getItem("am:123")?.links, undefined);
        });
    });

    it("does not link a video that only its artwork gives away", () => {
        withCache(cache => {
            const apple = appleSong("am:123");
            // Spotify often titles a video exactly like its release
            const video = spotifySong("vid1", VIDEO_ART);

            cache.setItemIfNotExist(apple);
            cache.resolveCanonicalId(apple);
            cache.setItemIfNotExist(video);
            cache.resolveCanonicalId(video);

            assert.equal(cache.getItem("am:123")?.links, undefined);
        });
    });

    it("answers for a song it has never seen with the song's own service", () => {
        withCache(cache => {
            assert.deepEqual(cache.linksFor("am:999"), { appleMusic: "999" });
        });
    });
});

describe("SongDataCache ids", () => {
    it("reads nothing outside its directory", () => {
        withCache(cache => {
            assert.equal(cache.getItem("../escape"), null);
            assert.equal(cache.getItem("a/b"), null);
        });
    });

    it("writes nothing for an id no service issues", () => {
        withCache(cache => {
            cache.setItemIfNotExist({ ...song("x"), id: "../escape" });
            cache.addLinks("../escape", { appleMusic: "1" });

            assert.equal(cache.getItem("../escape"), null);
        });
    });

    it("stores songs first heard on Apple Music", () => {
        withCache(cache => {
            cache.setItemIfNotExist(appleSong("am:123"));

            assert.equal(cache.getItem("am:123")?.id, "am:123");
        });
    });
});
