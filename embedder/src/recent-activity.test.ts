import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { ActivityCandidate, HistoryEntry, buildRecentActivity } from "./recent-activity";

/**
 * The exclusions matter more than the ordering here.
 *
 * Showing a friend who has turned sharing off, or reporting that somebody
 * "listened to" eleven tracks they skipped through in twenty seconds, are both
 * worse than showing nothing at all.
 */
describe("buildRecentActivity", () => {
    const NOW = 1_700_000_000_000;
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;

    const play = (songId: string, agoMs: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
        songId,
        sessionDuration: 0.8,
        skipped: false,
        replayed: false,
        timestamp: NOW - agoMs,
        ...over,
    });

    const friend = (over: Partial<ActivityCandidate> = {}): ActivityCandidate => ({
        userId: "vidhu",
        username: "Vidhu",
        sharesListeningActivity: true,
        history: [play("a", HOUR)],
        ...over,
    });

    const build = (candidates: ActivityCandidate[], options = {}) =>
        buildRecentActivity(candidates, { now: NOW, ...options });

    it("shows a friend who was listening earlier", () => {
        const result = build([friend()]);

        assert.equal(result.length, 1);
        assert.equal(result[0].userId, "vidhu");
        assert.equal(result[0].lastPlayedAt, NOW - HOUR);
    });

    it("reports a friend who is listening right now as well", () => {
        // Whether a row would repeat a card is a question about one screen, and
        // is answered there. Skipping them here meant a friend's whole morning
        // left the page the moment they pressed play.
        const result = build([friend()]);

        assert.equal(result.length, 1);
        assert.equal(result[0].userId, "vidhu");
    });

    it("leaves out a friend who does not share their listening", () => {
        // Turning sharing off applies to an hour ago as much as to now
        assert.deepEqual(build([friend({ sharesListeningActivity: false })]), []);
    });

    it("leaves out a friend with nothing to show rather than showing them empty", () => {
        assert.deepEqual(build([friend({ history: [] })]), []);
    });

    it("ignores plays too short to mean anything", () => {
        // Skipping through a playlist should not read as having listened to it
        const result = build([friend({
            history: [play("a", HOUR, { sessionDuration: 0.05, skipped: true })],
        })]);

        assert.deepEqual(result, []);
    });

    it("keeps a short play that was a replay", () => {
        // Choosing to hear something again is deliberate however long it lasted
        const result = build([friend({
            history: [play("a", HOUR, { sessionDuration: 0.05, replayed: true })],
        })]);

        assert.equal(result.length, 1);
        assert.equal(result[0].onRepeat, true);
    });

    it("orders a friend's tracks newest first", () => {
        const result = build([friend({
            history: [play("old", 3 * HOUR), play("new", MINUTE), play("mid", HOUR)],
        })]);

        assert.deepEqual(result[0].tracks.map(v => v.songId), ["new", "mid", "old"]);
    });

    it("caps how many tracks a friend contributes", () => {
        const result = build([friend({
            history: [play("a", MINUTE), play("b", 2 * MINUTE), play("c", 3 * MINUTE),
                play("d", 4 * MINUTE), play("e", 5 * MINUTE)],
        })], { tracksPerFriend: 4 });

        assert.equal(result[0].tracks.length, 4);
    });

    it("still reports how many they played beyond the cap", () => {
        // "Nights +3 more" needs the real count, not the capped one
        const result = build([friend({
            history: [play("a", MINUTE), play("b", 2 * MINUTE), play("c", 3 * MINUTE),
                play("d", 4 * MINUTE), play("e", 5 * MINUTE), play("f", 6 * MINUTE)],
        })], { tracksPerFriend: 4 });

        assert.equal(result[0].tracks.length, 4);
        assert.equal(result[0].playCount, 6);
    });

    it("orders friends by who was listening most recently", () => {
        const result = build([
            friend({ userId: "old", username: "Old", history: [play("a", 5 * HOUR)] }),
            friend({ userId: "new", username: "New", history: [play("b", MINUTE)] }),
            friend({ userId: "mid", username: "Mid", history: [play("c", HOUR)] }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["new", "mid", "old"]);
    });

    /**
     * Recency decides; a session worth reading about only slows down how fast
     * it stops being news. The boundaries are the point - too much and
     * yesterday climbs over this morning, too little and this does nothing.
     */
    it("puts a proper session above a single track played a little later", () => {
        const run = Array.from({ length: 10 }, (_, i) => play(`r${i.toString()}`, (3 * HOUR) + (i * MINUTE)));

        const result = build([
            friend({ userId: "one", username: "One", history: [play("a", 2 * HOUR)] }),
            friend({ userId: "run", username: "Run", history: run }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["run", "one"]);
    });

    it("does not let a session outrank something genuinely fresh", () => {
        const run = Array.from({ length: 10 }, (_, i) => play(`r${i.toString()}`, (3 * HOUR) + (i * MINUTE)));

        const result = build([
            friend({ userId: "fresh", username: "Fresh", history: [play("a", 10 * MINUTE)] }),
            friend({ userId: "run", username: "Run", history: run }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["fresh", "run"]);
    });

    it("never drags yesterday above this morning", () => {
        // The largest possible boost is small and the age it divides is not
        const yesterday = Array.from({ length: 40 }, (_, i) => play(`y${i.toString()}`, (26 * HOUR) + (i * MINUTE), { replayed: i === 0 }));

        const result = build([
            friend({ userId: "today", username: "Today", history: [play("a", 3 * HOUR)] }),
            friend({ userId: "yesterday", username: "Yesterday", history: yesterday }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["today", "yesterday"]);
    });

    it("prefers the one on repeat when two are otherwise alike", () => {
        const result = build([
            friend({ userId: "plain", username: "Plain", history: [play("a", 2 * HOUR), play("b", 2 * HOUR + MINUTE)] }),
            friend({ userId: "repeat", username: "Repeat", history: [play("c", 2 * HOUR, { replayed: true }), play("d", 2 * HOUR + MINUTE)] }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["repeat", "plain"]);
    });

    it("breaks a tie on name so the order cannot wobble between refreshes", () => {
        const result = build([
            friend({ userId: "b", username: "Zoe", history: [play("a", HOUR)] }),
            friend({ userId: "a", username: "Alex", history: [play("b", HOUR)] }),
        ]);

        assert.deepEqual(result.map(v => v.username), ["Alex", "Zoe"]);
    });

    it("drops history older than the window", () => {
        assert.deepEqual(build([friend({ history: [play("a", 30 * DAY)] })]), []);
    });

    it("keeps history inside the window", () => {
        const result = build([friend({ history: [play("a", 2 * DAY)] })]);

        assert.equal(result.length, 1);
    });

    it("does not let a clock running fast pin somebody to the top", () => {
        // A timestamp in the future would otherwise sort above everyone forever
        const result = build([
            friend({ userId: "future", username: "Future", history: [play("a", -DAY)] }),
            friend({ userId: "real", username: "Real", history: [play("b", HOUR)] }),
        ]);

        assert.deepEqual(result.map(v => v.userId), ["real"]);
    });

    it("says on repeat only when the newest play was the replayed one", () => {
        // An older replay is not what they are listening to now
        const result = build([friend({
            history: [play("newest", MINUTE), play("older", HOUR, { replayed: true })],
        })]);

        assert.equal(result[0].onRepeat, false);
    });

    it("returns nothing when nobody qualifies", () => {
        assert.deepEqual(build([]), []);
    });
});
