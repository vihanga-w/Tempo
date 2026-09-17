import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "fs";

import { COVER_MAX_BYTES, artworkForFan, avatarColour, coverJpegBase64, fanCoverJpegBase64, fanCoverSvg, friendsLine, isLight, lifted, pictureForChip, playlistDuration } from "./playlist-cover";

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

    it("says how long the playlist runs, as Spotify does", () => {
        assert.equal(playlistDuration(87 * 60e3), "1h 27m");
        assert.equal(playlistDuration(43 * 60e3 + 20e3), "43m");
        assert.equal(playlistDuration(0), "0m");
    });

    it("draws as many cards as it is given, and none from nothing", () => {
        const one = fanCoverSvg({ name: "One", line: "", artworks: [Buffer.from([0xff, 0xd8])], colours: [], markPng: Buffer.alloc(0) });
        const none = fanCoverSvg({ name: "None", line: "", artworks: [], colours: [], markPng: Buffer.alloc(0) });

        assert.equal((one.match(/id="card\d"/g) ?? []).length, 1);
        assert.equal((none.match(/id="card\d"/g) ?? []).length, 0);
    });
});

describe("the friends' chips", () => {
    const friends = [{ id: "u-maya", name: "Maya" }, { id: "u-jon", name: "Jon" }, { id: "u-sam", name: "Sam" }, { id: "u-priya", name: "Priya" }];

    it("puts a chip per friend under the words, escapes their names, and counts those past the room", () => {
        const many = Array.from({ length: 14 }, (_, i) => ({ id: "u" + i, name: `F${i} <&>` }));
        const svg = fanCoverSvg({ name: "Mix & match", line: "for V · 1h", artworks: [], colours: [], markPng: Buffer.alloc(0), friends: many });

        // Ten fit beside the mark: nine faces and a count
        assert.equal((svg.match(/<circle[^>]*r="21"/g) ?? []).length, 10);
        assert.ok(svg.includes("+5"));
        assert.ok(svg.includes("Mix &amp; match"));
        assert.ok(!svg.includes("<&>"));
    });

    it("rasterises with chips to a JPEG within Spotify's limit", async () => {
        const mark = readFileSync(MARK);
        const artworks = await Promise.all([mark, mark, mark].map(artworkForFan));
        const b64 = await fanCoverJpegBase64({ name: "On repeat with friends", line: "for Vihanga · 1h 27m", artworks, colours: ["#6b3f6f"], markPng: mark, friends });

        assert.ok(isJpeg(b64));
    });

    it("shows a friend's own picture where they have one, in a round chip, and the initial where not", async () => {
        const picture = await pictureForChip(readFileSync(MARK));
        const svg = fanCoverSvg({ name: "x", line: "", artworks: [], colours: [], markPng: Buffer.alloc(0), friends: [{ ...friends[0], picture }, friends[1]] });

        assert.equal((svg.match(/clip-path="url\(#chip0\)"/g) ?? []).length, 1);
        assert.ok(svg.includes("data:image/jpeg;base64,"));
        assert.ok(!svg.includes(">M</text>"), "a pictured friend shows no initial");
        assert.ok(svg.includes(">J</text>"), "a friend without a picture shows theirs");
    });

    it("names the friends the way a person would", () => {
        assert.equal(friendsLine(friends.slice(0, 1)), "Maya");
        assert.equal(friendsLine(friends.slice(0, 3)), "Maya, Jon and Sam");
        assert.equal(friendsLine(friends), "Maya, Jon and 2 others");
    });

    it("lifts a colour clear of the wash, and picks ink to suit", () => {
        assert.equal(lifted("#000000", 0.5), "#808080");
        assert.equal(lifted("#ff0000", 0), "#ff0000");
        assert.equal(isLight("#f0f0f0"), true);
        assert.equal(isLight("#2b4a5c"), false);
    });

    it("colours a friend as the app does", () => {
        assert.deepEqual(avatarColour("u-maya"), avatarColour("u-maya"));
        assert.notEqual(avatarColour("u-maya").from, avatarColour("u-jon").from);
    });
});
