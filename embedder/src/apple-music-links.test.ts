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
        const db = memory({ a: link("old") });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let gated = true;

        // The first write waits on the gate, holding the lock while it does
        const store = new AppleMusicLinkStore({
            ...db.persistence,
            async set(id, next) {
                if (gated) {
                    gated = false;
                    await gate;
                }

                return db.persistence.set(id, next);
            },
        });

        const first = store.update("a", current => ({ ...current!, lastReadAt: 5 }));

        // The app sends "new", then the reader marks "old" refused — both
        // while the first write is still out
        const app = store.update("a", () => link("new"));
        const reader = store.update("a", current =>
            (current && current.userToken === "old" ? { ...current, state: "needs-token" } : current));

        await tick();

        // Neither has run: the lock is held
        assert.equal(db.stored.get("a")?.userToken, "old");

        release();

        const [, , marked] = await Promise.all([first, app, reader]);

        // The refusal was of a token that is no longer the link's
        assert.equal(marked?.userToken, "new");
        assert.equal(marked?.state, "linked");
    });

    it("never runs two changes to one link at once", async () => {
        const db = memory({ a: link("t") });
        let inside = 0;
        let most = 0;

        const slowPersistence = {
            ...db.persistence,
            async set(id: string, next: AppleMusicLink) {
                inside++;
                most = Math.max(most, inside);
                await tick();
                inside--;

                return db.persistence.set(id, next);
            },
        };

        const store = new AppleMusicLinkStore(slowPersistence);

        await Promise.all([1, 2, 3].map(n => store.update("a", current => ({ ...current!, userToken: `t${n}` }))));

        assert.equal(most, 1);
    });

    it("does not bring back a link removed while a change to it waited", async () => {
        const store = new AppleMusicLinkStore(memory({ a: link("t") }).persistence);

        const removal = store.update("a", () => undefined);
        const refresh = store.update("a", current => (current ? { ...current, userToken: "fresh" } : current));

        await Promise.all([removal, refresh]);

        assert.equal(await store.get("a"), undefined);
    });
});
