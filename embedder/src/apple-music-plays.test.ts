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

    it("counts everything after a read that found the list empty", () => {
        assert.deepEqual(newPlays([], ["b", "a"]), { ids: ["b", "a"], gap: false });
    });

    it("sees an album replayed from the top, in the same order as before", () => {
        assert.deepEqual(
            newPlays(["a", "b", "c", "x", "y", "z"], ["a", "b", "c", "a", "b", "c", "x", "y", "z"]),
            { ids: ["a", "b", "c"], gap: false },
        );
    });

    it("sees a whole page of new plays", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["f", "e", "d"]).ids, ["f", "e", "d"]);
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

    it("gives a play of unknown length about a song's length, so replays stay apart", () => {
        const [newer, older] = timePlays(["a", "a"], [], 100 * MIN, undefined);

        assert.ok(newer.endedAt - older.endedAt >= 3 * MIN);
    });

    it("spaces plays squeezed in since the last read far enough apart to stay separate plays", () => {
        // Three plays of a 200 s song in the three minutes between reads
        const plays = timePlays(["s", "s", "s"], [200e3, 200e3, 200e3], 100 * MIN, 97 * MIN);

        assert.ok(plays[0].endedAt - plays[1].endedAt >= 50e3);
        assert.ok(plays[1].endedAt - plays[2].endedAt >= 50e3);
        assert.ok(plays[2].endedAt - 200e3 * (3 * MIN / 600e3) >= 97 * MIN - 1);
    });

    it("spreads the plays after a gap across the whole gap", () => {
        const DAY = 24 * 60 * MIN;
        const plays = timePlays(["c", "b", "a"], [3 * MIN, 3 * MIN, 3 * MIN], 7 * DAY, 3 * DAY, true);

        assert.deepEqual(plays.map(v => v.endedAt), [7 * DAY, 7 * DAY - (4 * DAY) / 3, 7 * DAY - (8 * DAY) / 3].map(Math.round));
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

    it("keeps a replay of a song on the same service, however close", () => {
        const history = [imported("s1", 1000)];

        assert.equal(withImportedPlay(history, imported("s1", 1001), 200).length, 2);
    });

    it("counts the same song again once it is far enough apart", () => {
        const history = [entry("s1", 1000)];

        assert.equal(withImportedPlay(history, imported("s1", 5000), 200).length, 2);
    });
});
