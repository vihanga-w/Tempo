import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    isRestorable,
    isValidStreakUserId,
    migrateStreaksFromDisk,
    StreakFile,
    StreakPersistence,
    StreakRecord,
    STREAK_RESTORE_MAX_AGE,
} from "./streak-store";

const NOW = 1_700_000_000_000;

/** An in-memory stand-in, with hooks for the ways storage can let you down. */
class FakeStore implements StreakPersistence {
    records = new Map<string, StreakRecord>();
    failWritesFor = new Set<string>();
    /** Writes that report success but do not persist, as a lost write would. */
    silentlyDropWritesFor = new Set<string>();
    /** Reads back a different value than was written. */
    corruptReadsFor = new Set<string>();

    async get(userId: string) {
        if (this.corruptReadsFor.has(userId))
            return { playSessionStart: -999, updatedAt: NOW };

        return this.records.get(userId) ?? null;
    }

    async set(userId: string, record: StreakRecord) {
        if (this.failWritesFor.has(userId))
            return false;

        if (this.silentlyDropWritesFor.has(userId))
            return true;

        this.records.set(userId, record);

        return true;
    }

    async remove(userId: string) {
        return this.records.delete(userId);
    }

    async all() {
        return [...this.records.entries()].map(([userId, r]) => ({ userId, ...r }));
    }
}

function file(userId: string, playSessionStart = NOW - 60e3): StreakFile {
    return { userId, playSessionStart, path: `/tempodb/streaks/${userId}` };
}

/** Runs a migration, recording which files were deleted. */
async function migrate(files: StreakFile[], store: StreakPersistence) {
    const removed: string[] = [];

    const report = await migrateStreaksFromDisk({
        files,
        store,
        removeFile: p => removed.push(p),
        now: NOW,
    });

    return { report, removed };
}

describe("isValidStreakUserId", () => {
    it("accepts a Spotify id", () => {
        assert.equal(isValidStreakUserId("yh1q376ly901c0qk03n9kaphh"), true);
    });

    it("refuses anything that could address a field inside a document", () => {
        assert.equal(isValidStreakUserId("someid/playSessionStart"), false);
        assert.equal(isValidStreakUserId("../../etc"), false);
        assert.equal(isValidStreakUserId(""), false);
    });
});

describe("isRestorable", () => {
    it("picks up a streak refreshed moments ago", () => {
        assert.equal(isRestorable({ playSessionStart: NOW - 60e3, updatedAt: NOW - 1000 }, NOW), true);
    });

    it("leaves a streak nothing has touched in a long time", () => {
        assert.equal(
            isRestorable({ playSessionStart: NOW - 3600e3, updatedAt: NOW - STREAK_RESTORE_MAX_AGE - 1 }, NOW),
            false,
        );
    });

    it("accepts one exactly at the limit", () => {
        assert.equal(
            isRestorable({ playSessionStart: NOW - 3600e3, updatedAt: NOW - STREAK_RESTORE_MAX_AGE }, NOW),
            true,
        );
    });

    it("refuses a streak that never started", () => {
        assert.equal(isRestorable({ playSessionStart: -1, updatedAt: NOW }, NOW), false);
        assert.equal(isRestorable({ playSessionStart: 0, updatedAt: NOW }, NOW), false);
    });

    it("refuses a streak that starts in the future", () => {
        assert.equal(isRestorable({ playSessionStart: NOW + 60e3, updatedAt: NOW }, NOW), false);
    });
});

describe("migrateStreaksFromDisk", () => {
    it("does nothing when there is nothing on disk", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate([], store);

        assert.equal(report.imported, 0);
        assert.equal(removed.length, 0);
        assert.equal(store.records.size, 0);
    });

    it("imports a streak and only then deletes its file", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate([file("alice", NOW - 120e3)], store);

        assert.equal(report.imported, 1);
        assert.equal(report.failed, 0);
        assert.deepEqual(removed, ["/tempodb/streaks/alice"]);
        assert.equal(store.records.get("alice")?.playSessionStart, NOW - 120e3);
    });

    it("preserves the start time rather than restamping it", async () => {
        const store = new FakeStore();
        const started = NOW - (9 * 3600e3);

        await migrate([file("alice", started)], store);

        assert.equal(store.records.get("alice")?.playSessionStart, started);
        // updatedAt is the migration, since the file carried no such marker
        assert.equal(store.records.get("alice")?.updatedAt, NOW);
    });

    it("imports every user it finds", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate(
            [file("alice"), file("bob"), file("carol")], store);

        assert.equal(report.imported, 3);
        assert.equal(removed.length, 3);
        assert.equal(store.records.size, 3);
    });

    it("keeps the file when the write fails", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "write-failed");
        assert.equal(report.failed, 1);
        assert.deepEqual(removed, []);
    });

    it("keeps the file when a write reports success but stored nothing", async () => {
        // The case the read-back exists for: deleting here would destroy the
        // only copy of the data
        const store = new FakeStore();
        store.silentlyDropWritesFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "verify-failed");
        assert.deepEqual(removed, []);
    });

    it("keeps the file when the value read back does not match", async () => {
        const store = new FakeStore();
        store.corruptReadsFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "verify-failed");
        assert.equal(report.failed, 1);
        assert.deepEqual(removed, []);
    });

    it("carries on past a user that failed", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("bob");

        const { report, removed } = await migrate(
            [file("alice"), file("bob"), file("carol")], store);

        assert.equal(report.imported, 2);
        assert.equal(report.failed, 1);
        assert.deepEqual(removed.sort(), [
            "/tempodb/streaks/alice",
            "/tempodb/streaks/carol",
        ]);
    });

    it("refuses a file whose name could address a document field", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate([file("alice/playSessionStart")], store);

        assert.equal(report.results[0].outcome, "invalid");
        assert.equal(store.records.size, 0);
        assert.deepEqual(removed, []);
    });

    it("refuses a file with no usable start time", async () => {
        const store = new FakeStore();
        const { report } = await migrate([file("alice", -1)], store);

        assert.equal(report.results[0].outcome, "invalid");
        assert.equal(store.records.size, 0);
    });

    it("does not overwrite a user the store already holds", async () => {
        const store = new FakeStore();
        const live = { playSessionStart: NOW - 60e3, updatedAt: NOW };

        store.records.set("alice", live);

        const { report, removed } = await migrate([file("alice", NOW - (5 * 3600e3))], store);

        assert.equal(report.results[0].outcome, "already-present");
        assert.deepEqual(store.records.get("alice"), live);
        // The file is the older copy and has nothing left to contribute
        assert.deepEqual(removed, ["/tempodb/streaks/alice"]);
    });

    it("is safe to run twice", async () => {
        const store = new FakeStore();
        const files = [file("alice", NOW - 120e3), file("bob", NOW - 240e3)];

        const first = await migrate(files, store);
        const second = await migrate(files, store);

        assert.equal(first.report.imported, 2);
        assert.equal(second.report.imported, 0);
        assert.equal(second.report.failed, 0);
        assert.equal(store.records.get("alice")?.playSessionStart, NOW - 120e3);
        assert.equal(store.records.get("bob")?.playSessionStart, NOW - 240e3);
    });

    it("can be re-run to pick up what failed the first time", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("bob");

        const first = await migrate([file("alice"), file("bob")], store);

        assert.equal(first.report.failed, 1);
        assert.deepEqual(first.removed, ["/tempodb/streaks/alice"]);

        // Whatever was wrong is fixed, and the file is still there to retry
        store.failWritesFor.clear();

        const second = await migrate([file("bob")], store);

        assert.equal(second.report.imported, 1);
        assert.deepEqual(second.removed, ["/tempodb/streaks/bob"]);
        assert.equal(store.records.size, 2);
    });
});
