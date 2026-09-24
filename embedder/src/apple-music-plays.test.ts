import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newPlays, retimeImportedPlay, timePlays, withImportedPlay } from "./apple-music-plays";
import type { HistoryEntry } from "./user-taste";

describe("newPlays", () => {
    it("finds nothing new when the list has not changed", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["c", "b", "a"]), { ids: [], gap: false });
    });

    it("finds the tracks in front of what the list held last time", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["e", "d", "c", "b", "a"]), { ids: ["e", "d"], gap: false });
    });

    it("finds them when the oldest have dropped off the end", () => {
        // A full list, here five long: z has been pushed off the end
        assert.deepEqual(newPlays(["c", "b", "a", "z"], ["e", "d", "c", "b", "a"], 5), { ids: ["e", "d"], gap: false });
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

    it("sees the newest songs of a short history replayed, since nothing falls off a list not yet full", () => {
        assert.deepEqual(newPlays(["c", "b", "a"], ["c", "b", "a", "c", "b", "a"]), { ids: ["c", "b", "a"], gap: false });
        assert.deepEqual(newPlays(["x"], ["x", "x"]), { ids: ["x"], gap: false });
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
        assert.deepEqual(timePlays(["b", "a"], [3 * MIN, 4 * MIN], 100 * MIN, 93 * MIN), [
            { id: "b", endedAt: 100 * MIN, fraction: 1 },
            { id: "a", endedAt: 97 * MIN, fraction: 1 },
        ]);
    });

    it("puts nothing before the previous read, when the songs add up to more than the time between", () => {
        const plays = timePlays(["c", "b", "a"], [4 * MIN, 4 * MIN, 4 * MIN], 100 * MIN, 95 * MIN);

        for (const play of plays)
            assert.ok(play.endedAt >= 95 * MIN, `${play.id} at ${play.endedAt}`);

        // Still newest first
        assert.ok(plays[0].endedAt > plays[1].endedAt && plays[1].endedAt > plays[2].endedAt);
    });

    it("has no floor after a gap", () => {
        assert.deepEqual(timePlays(["b", "a"], [3 * MIN, 4 * MIN], 100 * MIN, undefined), [
            { id: "b", endedAt: 100 * MIN, fraction: 1 },
            { id: "a", endedAt: 97 * MIN, fraction: 1 },
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
        // The oldest may have begun before the last read, by no more than its length
        const oldestStart = plays[2].endedAt - (plays[1].endedAt - plays[2].endedAt);

        assert.ok(oldestStart >= 97 * MIN - 200e3 - 1);
    });

    it("counts a song longer than the time between reads as played through", () => {
        // A five minute song heard in full shows up in one three minute window
        const [play] = timePlays(["long"], [5 * MIN], 100 * MIN, 96.8 * MIN);

        assert.equal(play.fraction, 1);
    });

    it("counts two short songs in one window as played through", () => {
        const plays = timePlays(["b", "a"], [2.5 * MIN, 2.5 * MIN], 100 * MIN, 96.8 * MIN);

        assert.ok(plays.every(play => play.fraction === 1));
    });

    it("counts plays squeezed in as only as much of a play as there was time for", () => {
        // Eight 3.5 minute songs in the three minutes between reads: skipped through
        const plays = timePlays(Array(8).fill("s"), Array(8).fill(3.5 * MIN), 100 * MIN, 97 * MIN);

        for (const play of plays)
            assert.ok(play.fraction < 0.3, String(play.fraction));
    });

    it("spreads plays across a long absence, not just after a gap", () => {
        // A refused token on Monday, a new one on Friday, a dozen plays between
        const DAY = 24 * 60 * MIN;
        const plays = timePlays(Array(12).fill("s"), Array(12).fill(3 * MIN), 5 * DAY, 1 * DAY);

        assert.ok(plays[11].endedAt < 2 * DAY, `oldest at day ${plays[11].endedAt / DAY}`);
        assert.ok(plays.every(play => play.fraction === 1));
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

describe("retimeImportedPlay", () => {
    const plain = (songId: string, timestamp: number): HistoryEntry =>
        ({ songId, timestamp, sessionDuration: 1, skipped: false, replayed: false });
    const estimated = (songId: string, timestamp: number): HistoryEntry =>
        ({ ...plain(songId, timestamp), source: "appleMusic", estimated: true });

    const MIN = 60e3;

    it("gives an estimated play its real time, and moves it there", () => {
        const history = [estimated("s", 10 * MIN), plain("x", 9 * MIN), plain("y", 5 * MIN)];
        const { history: next, before, after } = retimeImportedPlay(history, "s", 7 * MIN, 5 * MIN);

        assert.deepEqual(next.map(v => [v.songId, v.timestamp, v.estimated]), [["x", 9 * MIN, undefined], ["s", 7 * MIN, false], ["y", 5 * MIN, undefined]]);
        assert.equal(before?.timestamp, 10 * MIN);
        assert.equal(after?.timestamp, 7 * MIN);
    });

    it("takes what else is now known", () => {
        const { after } = retimeImportedPlay([estimated("s", 10 * MIN)], "s", 9 * MIN, 5 * MIN, 0, { sessionDuration: 0.2, skipped: true });

        assert.deepEqual([after?.sessionDuration, after?.skipped], [0.2, true]);
    });

    it("does not move an earlier play onto a replay's time", () => {
        // The first play was recorded at 5; a replay ended at 10 and has not
        // been recorded yet. The library's time is the replay's.
        const history = [estimated("s", 5 * MIN)];

        assert.equal(retimeImportedPlay(history, "s", 10 * MIN, 10 * MIN).history, history);
    });

    it("corrects a play recorded while still going, whose real end is well after it", () => {
        // Recorded at 10, a minute into a four minute song; seen to end at 13
        const history = [{ ...estimated("s", 10 * MIN), openEnded: true }];
        const { after } = retimeImportedPlay(history, "s", 13 * MIN, 5 * MIN, 0, {}, 4 * MIN);

        assert.deepEqual([after?.timestamp, after?.estimated, after?.openEnded], [13 * MIN, false, undefined]);
    });

    it("still does not move a finished play that far", () => {
        const history = [estimated("s", 10 * MIN)];

        assert.equal(retimeImportedPlay(history, "s", 13 * MIN, 5 * MIN, 0, {}, 4 * MIN).history, history);
    });

    it("drops a play that at its real time turns out to be one Spotify recorded", () => {
        const history = [estimated("s", 10 * MIN), plain("s", 6 * MIN)];
        const { history: next, before, after } = retimeImportedPlay(history, "s", 6.2 * MIN, 10 * MIN, MIN);

        assert.deepEqual(next.map(v => v.timestamp), [6 * MIN]);
        assert.equal(before?.timestamp, 10 * MIN);
        assert.equal(after, undefined);
    });

    it("leaves plays that are real already, or from another service, or too far off", () => {
        const history = [
            plain("s", 10 * MIN),
            { ...estimated("s", 10 * MIN), estimated: false },
            // Estimated, but Spotify's: only Apple Music's imports are corrected
            { ...plain("s", 10 * MIN), estimated: true },
            estimated("s", 99 * MIN),
        ];

        assert.equal(retimeImportedPlay(history, "s", 10 * MIN, MIN).history, history);
    });
});
