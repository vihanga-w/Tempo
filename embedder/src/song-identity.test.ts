import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    linksOf,
    mergedLinks,
    openLinkFor,
    openLinksOf,
    serviceTrackOf,
    songIdFor,
    withLink,
} from "./song-identity";

describe("songIdFor", () => {
    it("keeps a Spotify id as it is, so every stored song id stays valid", () => {
        assert.equal(songIdFor({ service: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" }), "4uLU6hMCjMI75M1A2tKUQC");
    });

    it("prefixes an Apple Music catalog id", () => {
        assert.equal(songIdFor({ service: "appleMusic", id: "1440833098" }), "am:1440833098");
    });

    it("refuses an Apple Music library id, which names one person's copy", () => {
        assert.equal(songIdFor({ service: "appleMusic", id: "i.abc123" }), undefined);
    });

    it("refuses ids that could address a stored path or a file", () => {
        assert.equal(songIdFor({ service: "spotify", id: "../x" }), undefined);
        assert.equal(songIdFor({ service: "spotify", id: "a.b" }), undefined);
        assert.equal(songIdFor({ service: "spotify", id: "" }), undefined);
        assert.equal(songIdFor({ service: "appleMusic", id: "" }), undefined);
    });
});

describe("serviceTrackOf", () => {
    it("reads an unprefixed id as Spotify", () => {
        assert.deepEqual(serviceTrackOf("4uLU6hMCjMI75M1A2tKUQC"), { service: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" });
    });

    it("reads a prefixed id as Apple Music", () => {
        assert.deepEqual(serviceTrackOf("am:1440833098"), { service: "appleMusic", id: "1440833098" });
    });

    it("undoes songIdFor", () => {
        for (const track of [{ service: "spotify", id: "abc" }, { service: "appleMusic", id: "123" }] as const)
            assert.deepEqual(serviceTrackOf(songIdFor(track)!), track);
    });
});

describe("linksOf", () => {
    it("is the song's own service for a song written before links were recorded", () => {
        assert.deepEqual(linksOf({ id: "sp1" }), { spotify: "sp1" });
        assert.deepEqual(linksOf({ id: "am:123" }), { appleMusic: "123" });
    });

    it("adds the song's recorded links", () => {
        assert.deepEqual(linksOf({ id: "sp1", links: { appleMusic: "123" } }), { spotify: "sp1", appleMusic: "123" });
    });
});

describe("withLink", () => {
    it("records a service the song had no link for", () => {
        assert.deepEqual(withLink({ spotify: "sp1" }, { service: "appleMusic", id: "123" }), { spotify: "sp1", appleMusic: "123" });
    });

    it("keeps an existing link for the same service", () => {
        // A music video resolving to the audio release must not replace it
        const links = { spotify: "audio" };

        assert.equal(withLink(links, { service: "spotify", id: "video" }), links);
    });

    it("starts from nothing", () => {
        assert.deepEqual(withLink(undefined, { service: "spotify", id: "sp1" }), { spotify: "sp1" });
    });
});

describe("mergedLinks", () => {
    it("adds only the services that are missing", () => {
        assert.deepEqual(
            mergedLinks({ spotify: "audio" }, { spotify: "video", appleMusic: "123" }),
            { spotify: "audio", appleMusic: "123" },
        );
    });

    it("handles nothing on either side", () => {
        assert.deepEqual(mergedLinks(undefined, undefined), {});
        assert.deepEqual(mergedLinks(undefined, { spotify: "sp1" }), { spotify: "sp1" });
    });
});

describe("openLinkFor", () => {
    it("opens Spotify tracks and episodes", () => {
        assert.deepEqual(openLinkFor({ service: "spotify", id: "sp1" }), {
            app: "spotify://track/sp1",
            web: "https://open.spotify.com/track/sp1",
        });
        assert.equal(openLinkFor({ service: "spotify", id: "ep1" }, "episode").app, "spotify://episode/ep1");
    });

    it("opens Apple Music songs", () => {
        assert.deepEqual(openLinkFor({ service: "appleMusic", id: "123" }), {
            app: "music://music.apple.com/us/song/123",
            web: "https://music.apple.com/us/song/123",
        });
    });
});

describe("openLinksOf", () => {
    it("has a link for every service the song is on", () => {
        const open = openLinksOf({ id: "sp1", links: { appleMusic: "123" } });

        assert.equal(open.spotify?.app, "spotify://track/sp1");
        assert.equal(open.appleMusic?.web, "https://music.apple.com/us/song/123");
    });

    it("opens an episode as an episode", () => {
        assert.equal(openLinksOf({ id: "ep1", type: "episode" }).spotify?.web, "https://open.spotify.com/episode/ep1");
    });
});
