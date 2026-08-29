import { describe, it } from "node:test";
import assert from "node:assert";

import { AffinityEntry, rejectedSongs } from "./affinity-cooldown";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600e3;

const rating = (songId: string, affinity: number, agoMs: number): AffinityEntry =>
    ({ songId, affinity, timestamp: NOW - agoMs });

describe("rejectedSongs", () => {
    it("keeps a song nobody has rated", () => {
        assert.equal(rejectedSongs([], NOW)("song"), false);
    });

    it("drops a song rated down today", () => {
        assert.equal(rejectedSongs([rating("song", -1, 2 * 3600e3)], NOW)("song"), true);
    });

    /*
     * One bad swipe is not a life sentence. A single negative clears it for the
     * day and no longer, so somebody who taps the wrong card sees it tomorrow.
     */
    it("lets one dislike expire after a day", () => {
        assert.equal(rejectedSongs([rating("song", -1, 2 * DAY)], NOW)("song"), false);
    });

    it("holds a song out for the week once it is rejected repeatedly", () => {
        const history = [
            rating("song", -1, 2 * DAY), rating("song", -1, 3 * DAY),
            rating("song", -1, 4 * DAY), rating("song", -1, 5 * DAY),
        ];

        assert.equal(rejectedSongs(history, NOW)("song"), true);
    });

    it("lets a liked song through even after an early dislike", () => {
        const history = [rating("song", -1, 20 * 3600e3), rating("song", 3, 1 * 3600e3)];

        assert.equal(rejectedSongs(history, NOW)("song"), false);
    });

    it("ignores a rating dated in the future", () => {
        assert.equal(rejectedSongs([rating("song", -5, -3600e3)], NOW)("song"), false);
    });

    it("forgets a rating older than the longest window", () => {
        const ancient = Array.from({ length: 20 }, (_, i) => rating("song", -1, 60 * DAY + i));

        assert.equal(rejectedSongs(ancient, NOW)("song"), false);
    });
});
