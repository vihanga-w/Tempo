import { describe, it } from "node:test";
import assert from "node:assert";

import { REFRESH_EVERY_MS, dueForRefresh, nextRefreshAt } from "./playlist-refresh";

const NOW = 1_800_000_000_000;

describe("the weekly refresh", () => {
    it("is due once a week has passed since the playlist last changed", () => {
        assert.equal(dueForRefresh({ updatedAt: NOW - REFRESH_EVERY_MS + 1 }, NOW), false);
        assert.equal(dueForRefresh({ updatedAt: NOW - REFRESH_EVERY_MS }, NOW), true);
    });

    it("says when it will next be looked at", () => {
        assert.equal(nextRefreshAt({ updatedAt: NOW }), NOW + REFRESH_EVERY_MS);
    });
});
