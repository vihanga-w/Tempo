import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { AppleMusicLinkPersistence, AppleMusicLinkStore } from "./apple-music-links";
import type { AppleMusicLink } from "./linked-accounts";

function memory(initial: Record<string, AppleMusicLink> = {}, failWrites = false) {
    const stored = new Map(Object.entries(initial));
    let reads = 0;

    const persistence: AppleMusicLinkPersistence = {
        async get(id) { reads++; return stored.get(id) ?? null; },
        async set(id, link) { if (failWrites) return false; stored.set(id, link); return true; },
        async remove(id) { if (failWrites) return false; stored.delete(id); return true; },
    };

    return { persistence, stored, reads: () => reads };
}

const link = (userToken: string): AppleMusicLink =>
    ({ linkedAt: 1, userToken, tokenUpdatedAt: 1, storefront: "us", state: "linked" });

const tick = () => new Promise(resolve => setImmediate(resolve));

describe("AppleMusicLinkStore", () => {
    it("reads each account from the database once", async () => {
        const db = memory({ a: link("t") });
        const store = new AppleMusicLinkStore(db.persistence);

        assert.equal((await store.get("a"))?.userToken, "t");
        assert.equal(await store.get("b"), undefined);
        await store.get("a");
        await store.get("b");

        assert.equal(db.reads(), 2);
    });

    it("stores a change and answers with it", async () => {
        const db = memory();
        const store = new AppleMusicLinkStore(db.persistence);

        assert.equal((await store.update("a", () => link("t")))?.userToken, "t");
        assert.equal(db.stored.get("a")?.userToken, "t");
        assert.equal((await store.get("a"))?.userToken, "t");
    });

    it("removes a link", async () => {
        const db = memory({ a: link("t") });
        const store = new AppleMusicLinkStore(db.persistence);

        await store.update("a", () => undefined);

        assert.equal(db.stored.has("a"), false);
        assert.equal(await store.get("a"), undefined);
    });

    it("keeps nothing it could not store", async () => {
        const db = memory({ a: link("t") }, true);
        const store = new AppleMusicLinkStore(db.persistence);

        await assert.rejects(store.update("a", () => link("new")));
        assert.equal((await store.get("a"))?.userToken, "t");
    });

    it("makes one change at a time, each against the link as the last left it", async () => {
        const store = new AppleMusicLinkStore(memory({ a: link("old") }).persistence);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });

        // The reader, which found "old" refused, is still working when the app
        // sends a new token
        const reader = store.update("a", current => current);
        const slow = store.get("a").then(async () => { await held; });
        const app = store.update("a", () => link("new"));

        await tick();
        release();
        await Promise.all([reader, slow, app]);

        const marked = await store.update("a", current =>
            (current && current.userToken === "old" ? { ...current, state: "needs-token" } : current));

        // The refusal was of a token that is no longer the link's
        assert.equal(marked?.userToken, "new");
        assert.equal(marked?.state, "linked");
    });

    it("does not bring back a link removed while a change to it waited", async () => {
        const store = new AppleMusicLinkStore(memory({ a: link("t") }).persistence);

        const removal = store.update("a", () => undefined);
        const refresh = store.update("a", current => (current ? { ...current, userToken: "fresh" } : current));

        await Promise.all([removal, refresh]);

        assert.equal(await store.get("a"), undefined);
    });
});
