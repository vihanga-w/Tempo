import { describe, it } from "node:test";
import assert from "node:assert";

import { MAX_NAME_LENGTH, cleanName, isValidPlaylistId, isValidPlaylistUserId, rebuilt, withoutSong, type PlaylistRecord } from "./playlist-store";
import type { PlaylistPick } from "./playlist-builder";

const NOW = 1_800_000_000_000;
const EARLIER = NOW - 3 * 24 * 3600e3;

function record(over: Partial<PlaylistRecord> = {}): PlaylistRecord {
    return {
        id: "0123456789abcdef",
        name: "Your mix",
        recipe: "mix",
        createdAt: EARLIER,
        updatedAt: EARLIER,
        songs: [{ songId: "a", reason: { type: "liked", at: EARLIER, strength: 3 }, addedAt: EARLIER }],
        removed: [],
        ...over,
    };
}

function pick(songId: string): PlaylistPick {
    return { songId, score: 1, reason: { type: "played", plays: 2, replays: 0, lastAt: NOW } };
}

/**
 * A playlist is rebuilt from its recipe whenever the listener asks, and the
 * rebuild must respect two things the recipe cannot know: what the listener
 * took out by hand, and when each song first arrived.
 */
describe("rebuilding a playlist", () => {
    it("takes what the recipe found, keeps the date a song first arrived, and takes its newest reason", () => {
        const after = rebuilt(record(), [pick("a"), pick("b")], NOW);

        assert.deepEqual(after.songs.map(song => song.songId), ["a", "b"]);
        assert.equal(after.songs[0].addedAt, EARLIER);
        assert.equal(after.songs[0].reason.type, "played");
        assert.equal(after.songs[1].addedAt, NOW);
        assert.equal(after.updatedAt, NOW);
    });

    it("keeps out what the listener took out, however often it is rebuilt", () => {
        const taken = withoutSong(record(), "a", NOW);

        assert.deepEqual(taken.songs, []);
        assert.deepEqual(taken.removed, ["a"]);

        const again = rebuilt(taken, [pick("a"), pick("b")], NOW);

        assert.deepEqual(again.songs.map(song => song.songId), ["b"]);
    });

    it("leaves a playlist alone when asked to take out a song it does not hold", () => {
        const before = record();

        assert.equal(withoutSong(before, "zzz", NOW), before);
    });
});

describe("what is accepted", () => {
    it("keeps a name to one clean line, and falls back when there is none", () => {
        assert.equal(cleanName("  Sunday \n morning  ", "Your mix"), "Sunday morning");
        assert.equal(cleanName("", "Your mix"), "Your mix");
        assert.equal(cleanName(42, "Your mix"), "Your mix");
        assert.equal(cleanName("x".repeat(200), "Your mix").length, MAX_NAME_LENGTH);
    });

    it("refuses ids that could address part of a document", () => {
        assert.ok(isValidPlaylistUserId("spotify_user.1"));
        assert.ok(!isValidPlaylistUserId("a/b"));
        assert.ok(isValidPlaylistId("0123456789abcdef"));
        assert.ok(!isValidPlaylistId("0123456789abcdeg") && !isValidPlaylistId("../x"));
    });
});
