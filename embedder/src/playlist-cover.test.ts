import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";

import { COVER_MAX_BYTES, artworkForFan, avatarColour, coverJpegBase64, fanCoverJpegBase64, fanCoverSvg, friendsCoverJpegBase64, friendsCoverSvg, friendsLine, isLight, lifted } from "./playlist-cover";

const MARK = "static/playlist-cover.png";
const isJpeg = (b64: string) => { const b = Buffer.from(b64, "base64"); return b.byteLength <= COVER_MAX_BYTES && b[0] === 0xff && b[1] === 0xd8; };

describe("the mark cover", () => {
    it("is a JPEG within Spotify's limit, made from the mark that ships with the server", async () => {
        assert.ok(isJpeg(await coverJpegBase64(MARK)));
    });
});

describe("the fan cover", () => {
    it("fans up to three artworks and stays within Spotify's limit with all three", async () => {
        const mark = readFileSync(MARK);
        // The mark itself stands in for artwork: three 512px PNGs, shrunk as real ones are
        const artworks = await Promise.all([mark, mark, mark].map(artworkForFan));
        const b64 = await fanCoverJpegBase64({ name: "Liked in Discover", line: "for Vihanga · Liked in Discover", artworks, colours: ["#6b3f6f"], markPng: mark });

        assert.ok(isJpeg(b64));
    });

    it("draws as many cards as it is given, and none from nothing", () => {
        const one = fanCoverSvg({ name: "One", line: "", artworks: [Buffer.from([0xff, 0xd8])], colours: [], markPng: Buffer.alloc(0) });
        const none = fanCoverSvg({ name: "None", line: "", artworks: [], colours: [], markPng: Buffer.alloc(0) });

        assert.equal((one.match(/id="card\d"/g) ?? []).length, 1);
        assert.equal((none.match(/id="card\d"/g) ?? []).length, 0);
    });
});

describe("the friends cover", () => {
    const friends = [{ id: "u-maya", name: "Maya" }, { id: "u-jon", name: "Jon" }, { id: "u-sam", name: "Sam" }, { id: "u-priya", name: "Priya" }];

    it("rasterises to a JPEG within Spotify's limit", async () => {
        const b64 = await friendsCoverJpegBase64({ name: "On repeat with friends", friends, colours: ["#6b3f6f", "#2b4a5c"], markPng: readFileSync(MARK) });

        assert.ok(isJpeg(b64));
    });

    it("draws every friend, escapes their names, and counts those past the ring", () => {
        const many = Array.from({ length: 11 }, (_, i) => ({ id: "u" + i, name: `F${i} <&>` }));
        const svg = friendsCoverSvg({ name: "Mix & match", friends: many, colours: [], markPng: Buffer.alloc(0) });

        assert.equal((svg.match(/<circle[^>]*r="3\d"/g) ?? []).length, 9, "eight faces and one +n");
        assert.ok(svg.includes("+3"));
        assert.ok(svg.includes("Mix &amp; match"));
        assert.ok(!svg.includes("<&>"));
    });

    it("names the friends the way a person would", () => {
        assert.equal(friendsLine(friends.slice(0, 1)), "Maya");
        assert.equal(friendsLine(friends.slice(0, 3)), "Maya, Jon and Sam");
        assert.equal(friendsLine(friends), "Maya, Jon and 2 others");
    });

    it("lifts the count's disc clear of the wash, and picks ink to suit", () => {
        assert.equal(lifted("#000000", 0.5), "#808080");
        assert.equal(lifted("#ff0000", 0), "#ff0000");
        assert.equal(isLight("#f0f0f0"), true);
        assert.equal(isLight("#2b4a5c"), false);
    });

    it("colours a friend as the app does", () => {
        // The app's rule, ported: same id, same slot
        assert.deepEqual(avatarColour("u-maya"), avatarColour("u-maya"));
        assert.notEqual(avatarColour("u-maya").from, avatarColour("u-jon").from);
    });
});
