import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildDigest, ordinal, Standing } from "./leaderboard-digest";

const NOW = 1_700_000_000_000;

const NAMES: { [id: string]: string } = { a: "Alex", s: "Sam", k: "Kai", r: "Rowan" };
const nameFor = (id: string) => NAMES[id] ?? "A friend";

function standing(aheadOfMe: string[], position: number): Standing {
    return { aheadOfMe, position, takenAt: NOW - 24 * 3600e3 };
}

describe("ordinal", () => {
    it("handles the ordinary cases", () => {
        assert.equal(ordinal(1), "1st");
        assert.equal(ordinal(2), "2nd");
        assert.equal(ordinal(3), "3rd");
        assert.equal(ordinal(4), "4th");
    });

    it("handles the teens, which do not follow the last digit", () => {
        assert.equal(ordinal(11), "11th");
        assert.equal(ordinal(12), "12th");
        assert.equal(ordinal(13), "13th");
    });

    it("handles the twenties onward", () => {
        assert.equal(ordinal(21), "21st");
        assert.equal(ordinal(22), "22nd");
        assert.equal(ordinal(111), "111th");
    });
});

describe("buildDigest", () => {
    it("says nothing on the first run", () => {
        // Nothing to compare against; recording where they stand is all there is
        const digest = buildDigest({
            previous: undefined,
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a", "s"],
            nameFor,
        });

        assert.deepEqual(digest.passed, []);
        assert.equal(digest.notification, undefined);
    });

    it("says nothing when the standing has not changed", () => {
        const digest = buildDigest({
            previous: standing(["a", "s"], 3),
            currentlyAhead: ["a", "s"],
            position: 3,
            presentNow: ["a", "s"],
            nameFor,
        });

        assert.equal(digest.notification, undefined);
    });

    it("reports passing one friend", () => {
        const digest = buildDigest({
            previous: standing(["a", "s"], 3),
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a", "s"],
            nameFor,
        });

        assert.deepEqual(digest.passed, ["s"]);
        assert.equal(digest.notification?.message, "You passed Sam. You're 2nd on the leaderboard.");
    });

    it("reports passing several", () => {
        const digest = buildDigest({
            previous: standing(["a", "s", "k"], 4),
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a", "s", "k"],
            nameFor,
        });

        assert.deepEqual(digest.passed, ["s", "k"]);
        assert.equal(digest.notification?.message, "You passed Sam and Kai. You're 2nd on the leaderboard.");
    });

    it("says something different on reaching the top", () => {
        const digest = buildDigest({
            previous: standing(["a"], 2),
            currentlyAhead: [],
            position: 1,
            presentNow: ["a", "s"],
            nameFor,
        });

        assert.equal(digest.notification?.title, "🏆 Top of the leaderboard");
        assert.equal(digest.notification?.message, "You passed Alex. Nobody's listened more in the past week.");
    });

    it("says nothing about being passed", () => {
        // A nudge about something you did not do is a poor thing to wake a phone
        // for, and a rolling week can drop somebody purely through listening
        // ageing out of it
        const digest = buildDigest({
            previous: standing([], 1),
            currentlyAhead: ["a", "s"],
            position: 3,
            presentNow: ["a", "s"],
            nameFor,
        });

        assert.deepEqual(digest.passed, []);
        assert.equal(digest.notification, undefined);
    });

    it("does not count somebody who has left the board", () => {
        // Unfriended, or activity sharing switched off. They were not passed.
        const digest = buildDigest({
            previous: standing(["a", "s"], 3),
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a"],
            nameFor,
        });

        assert.deepEqual(digest.passed, []);
        assert.equal(digest.notification, undefined);
    });

    it("does not count a friend who was not there last time", () => {
        // Added yesterday, and already behind — never overtaken
        const digest = buildDigest({
            previous: standing(["a"], 2),
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a", "r"],
            nameFor,
        });

        assert.equal(digest.notification, undefined);
    });

    it("reports only those actually passed when others were as well", () => {
        const digest = buildDigest({
            previous: standing(["a", "s"], 3),
            currentlyAhead: ["a"],
            position: 2,
            presentNow: ["a", "s", "k"],
            nameFor,
        });

        assert.deepEqual(digest.passed, ["s"]);
    });

    it("names at most three before summarising", () => {
        const many: { [id: string]: string } = { p1: "One", p2: "Two", p3: "Three", p4: "Four" };

        const digest = buildDigest({
            previous: standing(["p1", "p2", "p3", "p4"], 5),
            currentlyAhead: [],
            position: 1,
            presentNow: ["p1", "p2", "p3", "p4"],
            nameFor: id => many[id] ?? "A friend",
        });

        assert.equal(digest.notification?.message, "You passed One, Two and 2 others. Nobody's listened more in the past week.");
    });

    it("falls back to a neutral name for somebody unknown", () => {
        const digest = buildDigest({
            previous: standing(["ghost"], 2),
            currentlyAhead: [],
            position: 1,
            presentNow: ["ghost"],
            nameFor,
        });

        assert.ok(digest.notification?.message.includes("A friend"));
    });
});
