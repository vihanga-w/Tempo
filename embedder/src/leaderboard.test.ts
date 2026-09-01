import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    buildLeaderboard,
    LeaderboardCandidate,
    LeaderboardHistoryItem,
    listeningTimeMs,
    Period,
} from "./leaderboard";

const NOW = 1_700_000_000_000;
const WEEK: Period = { start: NOW - (7 * 24 * 3600e3), end: NOW };
const THREE_MIN = 180e3;

const durations: { [songId: string]: number } = { a: THREE_MIN, b: 120e3, c: 240e3 };
const durationFor = (songId: string) => durations[songId];

function played(songId: string, overrides: Partial<LeaderboardHistoryItem> = {}): LeaderboardHistoryItem {
    return {
        songId,
        sessionDuration: 1,
        skipped: false,
        timestamp: NOW - 3600e3,
        ...overrides,
    };
}

function listener(
    userId: string,
    history: LeaderboardHistoryItem[],
    overrides: Partial<LeaderboardCandidate> = {},
): LeaderboardCandidate {
    return { userId, displayName: userId, history, sharing: true, ...overrides };
}

describe("listeningTimeMs", () => {
    it("counts a full play as the whole track", () => {
        const total = listeningTimeMs([played("a")], durationFor, WEEK);

        assert.equal(total.listeningMs, THREE_MIN);
        assert.equal(total.uniqueSongs, 1);
    });

    it("counts a partial play as the fraction heard", () => {
        const total = listeningTimeMs([played("a", { sessionDuration: 0.5 })], durationFor, WEEK);

        assert.equal(total.listeningMs, THREE_MIN / 2);
    });

    it("ignores a skipped track entirely", () => {
        // Otherwise rejecting music quickly would be a way up the board
        const total = listeningTimeMs(
            [played("a", { skipped: true, sessionDuration: 0.4 })], durationFor, WEEK);

        assert.equal(total.listeningMs, 0);
        assert.equal(total.uniqueSongs, 0);
    });

    it("ignores a track whose length is unknown", () => {
        const total = listeningTimeMs([played("unknown")], durationFor, WEEK);

        assert.equal(total.listeningMs, 0);
    });

    it("ignores listening from before the period", () => {
        const total = listeningTimeMs(
            [played("a", { timestamp: WEEK.start - 1 })], durationFor, WEEK);

        assert.equal(total.listeningMs, 0);
    });

    it("ignores listening from after the period", () => {
        const total = listeningTimeMs(
            [played("a", { timestamp: WEEK.end + 1 })], durationFor, WEEK);

        assert.equal(total.listeningMs, 0);
    });

    it("includes listening exactly on the boundaries", () => {
        const total = listeningTimeMs([
            played("a", { timestamp: WEEK.start }),
            played("b", { timestamp: WEEK.end }),
        ], durationFor, WEEK);

        assert.equal(total.listeningMs, THREE_MIN + 120e3);
    });

    it("counts a song played twice once towards unique songs", () => {
        const total = listeningTimeMs([played("a"), played("a")], durationFor, WEEK);

        assert.equal(total.listeningMs, THREE_MIN * 2);
        assert.equal(total.uniqueSongs, 1);
    });

    it("clamps a nonsensical fraction", () => {
        const total = listeningTimeMs([
            played("a", { sessionDuration: 5 }),
            played("b", { sessionDuration: -2 }),
        ], durationFor, WEEK);

        assert.equal(total.listeningMs, THREE_MIN);
    });

    it("returns nothing for someone who has not listened", () => {
        assert.deepEqual(listeningTimeMs([], durationFor, WEEK), { listeningMs: 0, uniqueSongs: 0 });
    });
});

describe("buildLeaderboard", () => {
    it("carries each listener's BlurHash through to the board", () => {
        // It reached the candidate and stopped there: the projection dropped it,
        // so every client fell back to the grid and nothing said so.
        const board = buildLeaderboard([
            listener("a", [played("a")], {
                imageUrl: "http://pic/a", imageBlurHash: "UWJayD0K4o%M~qV@-oRj?a%1kDIoV?xvxaoe",
            }),
        ], durationFor, WEEK);

        assert.equal(board[0].imageBlurHash, "UWJayD0K4o%M~qV@-oRj?a%1kDIoV?xvxaoe");
    });

    it("carries each listener's colour blob through to the board", () => {
        // A board is a column of faces that all load at once, which is the worst
        // case for the hole-then-pop the blob exists to prevent -- and it was
        // the one list of people not being sent one.
        const board = buildLeaderboard([
            listener("a", [played("a")], {
                imageUrl: "http://pic/a", imageColourBlob: "blob-a",
            }),
        ], durationFor, WEEK);

        assert.equal(board[0].imageColourBlob, "blob-a");
    });

    it("leaves the blob out for somebody with no picture", () => {
        const board = buildLeaderboard([
            listener("a", [played("a")]),
        ], durationFor, WEEK);

        assert.equal(board[0].imageColourBlob, undefined);
    });

    it("ranks the longest listener first", () => {
        const board = buildLeaderboard([
            listener("quiet", [played("b")]),
            listener("loud", [played("a"), played("c")]),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.userId), ["loud", "quiet"]);
        assert.deepEqual(board.map(e => e.position), [1, 2]);
    });

    it("gives equal totals the same position and skips the next", () => {
        const board = buildLeaderboard([
            listener("alice", [played("a")]),
            listener("bob", [played("a")]),
            listener("carol", [played("b")]),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.position), [1, 1, 3]);
    });

    it("orders a tie by name so the board does not shuffle between requests", () => {
        const first = buildLeaderboard([
            listener("z", [played("a")], { displayName: "Zoe" }),
            listener("a", [played("a")], { displayName: "Alex" }),
        ], durationFor, WEEK);

        const second = buildLeaderboard([
            listener("a", [played("a")], { displayName: "Alex" }),
            listener("z", [played("a")], { displayName: "Zoe" }),
        ], durationFor, WEEK);

        assert.deepEqual(first.map(e => e.userId), ["a", "z"]);
        assert.deepEqual(first.map(e => e.userId), second.map(e => e.userId));
    });

    it("leaves out a friend who does not share their activity", () => {
        // A total is the kind of thing that setting exists to withhold
        const board = buildLeaderboard([
            listener("open", [played("a")]),
            listener("private", [played("a"), played("c")], { sharing: false }),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.userId), ["open"]);
    });

    it("shows the reader their own listening even with sharing off", () => {
        const board = buildLeaderboard([
            listener("me", [played("a")], { sharing: false, isViewer: true }),
            listener("friend", [played("b")]),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.userId), ["me", "friend"]);
        assert.equal(board[0].isViewer, true);
    });

    it("keeps a friend who listened to nothing this week", () => {
        // Dropping them makes the board shrink over a quiet week and leaves
        // people wondering where everyone went
        const board = buildLeaderboard([
            listener("busy", [played("a")]),
            listener("away", []),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.userId), ["busy", "away"]);
        assert.equal(board[1].listeningMs, 0);
        assert.equal(board[1].position, 2);
    });

    it("gives everyone first place when nobody has listened", () => {
        const board = buildLeaderboard([
            listener("a", []),
            listener("b", []),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.position), [1, 1]);
    });

    it("reports unique songs alongside the total", () => {
        const board = buildLeaderboard([
            listener("alice", [played("a"), played("a"), played("b")]),
        ], durationFor, WEEK);

        assert.equal(board[0].uniqueSongs, 2);
        assert.equal(board[0].listeningMs, (THREE_MIN * 2) + 120e3);
    });

    it("marks exactly one entry as the reader", () => {
        const board = buildLeaderboard([
            listener("me", [played("a")], { isViewer: true }),
            listener("friend", [played("b")]),
        ], durationFor, WEEK);

        assert.equal(board.filter(e => e.isViewer).length, 1);
    });

    it("handles a board of one", () => {
        const board = buildLeaderboard(
            [listener("me", [played("a")], { isViewer: true })], durationFor, WEEK);

        assert.equal(board.length, 1);
        assert.equal(board[0].position, 1);
    });

    it("handles nobody at all", () => {
        assert.deepEqual(buildLeaderboard([], durationFor, WEEK), []);
    });

    it("does not let skipped listening change a position", () => {
        const board = buildLeaderboard([
            listener("skipper", [
                played("a", { skipped: true }),
                played("c", { skipped: true }),
                played("b"),
            ]),
            listener("listener", [played("a")]),
        ], durationFor, WEEK);

        assert.deepEqual(board.map(e => e.userId), ["listener", "skipper"]);
    });
});
