import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newPlays, timePlays, withImportedPlay } from "./apple-music-plays";
import type { HistoryEntry } from "./user-taste";

describe("newPlays", () => {
    it("finds nothing new when the list has not changed", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["c", "b", "a"]), { ids: [], gap: false });
    });

    it("finds the tracks in front of what the list held last time", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["e", "d", "c", "b", "a"]), { ids: ["e", "d"], gap: false });
    });

    it("finds them when the oldest have dropped off the end", () => {
        assert.deepEqual(newPlays(["c", "b", "a", "z"], ["e", "d", "c", "b", "a"]), { ids: ["e", "d"], gap: false });
    });

    it("counts a replay when a track played again is listed twice", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["c", "c", "b", "a"]), { ids: ["c"], gap: false });
    });

    it("counts a replay when a track played again moves to the top", () => {
        // a was played again: it leaves its old place and comes to the front
        assert.deepEqual(newPlays(["c", "b", "a"], ["a", "c", "b"]), { ids: ["a"], gap: false });
    });

    it("counts a replay of a track that was among the newest", () => {
        // a was second newest; played again, it moves to the front
        assert.deepEqual(newPlays(["c", "a", "b", "d"], ["a", "c", "b", "d"]), { ids: ["a"], gap: false });
    });

    it("does not take one matching track for the previous list", () => {
        // c is where the previous list began, but what follows it is not
        assert.deepEqual(newPlays(["c", "b", "a"], ["x", "c", "y", "z"]), { ids: ["x", "y", "z"], gap: true });
    });

    it("reports a gap when the previous list cannot be found", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["f", "e", "d"]), { ids: ["f", "e", "d"], gap: true });
    });

    it("counts only tracks the previous list never held, when it cannot be found", () => {
        // Rearranged rather than played through: b and a are not new plays
        assert.deepEqual(newPlays(["c", "b", "a"], ["b", "x", "a"]), { ids: ["x"], gap: true });
    });

    it("treats a first read as a gap, since nothing says when any of it was played", () => {
        assert.deepEqual(newPlays([], ["b", "a"]), { ids: ["b", "a"], gap: true });
    });

    it("finds a short previous list", () => {
        assert.deepEqual(newPlays(["a"], ["b", "a"]), { ids: ["b"], gap: false });
    });

    it("finds nothing in an empty list", () => {
        assert.deepEqual(newPlays(["a"], []), { ids: [], gap: false });
    });
});

describe("timePlays", () => {
    const MIN = 60e3;

    it("ends the newest play now and each older one where the next began", () => {
        assert.deepEqual(timePlays(["b", "a"], [3 * MIN, 4 * MIN], 100 * MIN, 0), [
            { id: "b", endedAt: 100 * MIN },
            { id: "a", endedAt: 97 * MIN },
        ]);
    });

    it("puts nothing before the previous read, when the songs add up to more than the time between", () => {
        const plays = timePlays(["c", "b", "a"], [4 * MIN, 4 * MIN, 4 * MIN], 100 * MIN, 95 * MIN);

        for (const play of plays)
            assert.ok(play.endedAt > 95 * MIN, `${play.id} at ${play.endedAt}`);

        // Still newest first
        assert.ok(plays[0].endedAt > plays[1].endedAt && plays[1].endedAt > plays[2].endedAt);
    });

    it("has no floor after a gap", () => {
        assert.deepEqual(timePlays(["b", "a"], [3 * MIN, 4 * MIN], 100 * MIN, undefined), [
            { id: "b", endedAt: 100 * MIN },
            { id: "a", endedAt: 97 * MIN },
        ]);
    });

    it("treats an unknown length as none", () => {
        assert.deepEqual(timePlays(["b", "a"], [], 100, undefined), [
            { id: "b", endedAt: 100 },
            { id: "a", endedAt: 100 },
        ]);
    });
});

describe("withImportedPlay", () => {
    function entry(songId: string, timestamp: number): HistoryEntry {
        return { songId, timestamp, sessionDuration: 1, skipped: false, replayed: false };
    }

    const imported = (songId: string, timestamp: number): HistoryEntry =>
        ({ ...entry(songId, timestamp), source: "appleMusic", estimated: true });

    it("puts a play where its time belongs, newest first", () => {
        const history = [entry("c", 300), entry("a", 100)];

        assert.deepEqual(
            withImportedPlay(history, imported("b", 200), 1000 / 100).map(v => v.songId),
            ["c", "b", "a"],
        );
    });

    it("puts the newest play first and the oldest last", () => {
        const history = [entry("b", 200)];

        assert.deepEqual(withImportedPlay(history, imported("c", 300), 10).map(v => v.songId), ["c", "b"]);
        assert.deepEqual(withImportedPlay(history, imported("a", 100), 10).map(v => v.songId), ["b", "a"]);
        assert.deepEqual(withImportedPlay([], imported("a", 100), 10).map(v => v.songId), ["a"]);
    });

    it("does not count one song played on both services twice", () => {
        const history = [entry("s1", 1000)];

        assert.equal(withImportedPlay(history, imported("s1", 1100), 200), history);
    });

    it("counts the same song again once it is far enough apart", () => {
        const history = [entry("s1", 1000)];

        assert.equal(withImportedPlay(history, imported("s1", 5000), 200).length, 2);
    });
});
