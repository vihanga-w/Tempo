import { describe, it } from "node:test";
import assert from "node:assert";

import { NOW_SLOT_MS } from "./playlist-builder";
import { REFRESH_EVERY_MS, dueForRefresh, nextRefreshAt, refreshEvery } from "./playlist-refresh";

const NOW = 1_800_000_000_000;

describe("the weekly refresh", () => {
    it("is due once a week has passed since the playlist last changed", () => {
        assert.equal(dueForRefresh({ recipe: "mix", updatedAt: NOW - REFRESH_EVERY_MS + 1 }, NOW), false);
        assert.equal(dueForRefresh({ recipe: "mix", updatedAt: NOW - REFRESH_EVERY_MS }, NOW), true);
    });

    it("says when it will next be looked at", () => {
        assert.equal(nextRefreshAt({ recipe: "mix", updatedAt: NOW }), NOW + REFRESH_EVERY_MS);
    });
});

/**
 * The dynamic recipe keeps the builder's own pace: it is due when its turn of
 * the shuffle is over, and not before, so a rebuild always has something new
 * to say rather than writing back the list it already had.
 */
describe("the dynamic recipe's refresh", () => {
    const turn = Math.floor(NOW / NOW_SLOT_MS) * NOW_SLOT_MS;

    it("stands for the rest of its turn, however long ago it was built", () => {
        assert.equal(dueForRefresh({ recipe: "now", updatedAt: turn }, turn + NOW_SLOT_MS - 1), false);
        assert.equal(dueForRefresh({ recipe: "now", updatedAt: turn }, turn + NOW_SLOT_MS), true);
    });

    it("is due several times a day, where the others are due once a week", () => {
        assert.equal(refreshEvery("now"), NOW_SLOT_MS);
        assert.equal(refreshEvery("mix"), REFRESH_EVERY_MS);
        assert.ok(refreshEvery("now") < refreshEvery("mix") / 24);
    });

    it("is next looked at when the turn it was built in ends", () => {
        assert.equal(nextRefreshAt({ recipe: "now", updatedAt: turn + 60e3 }), turn + NOW_SLOT_MS);
    });
});
