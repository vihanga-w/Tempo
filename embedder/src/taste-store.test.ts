import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    isUsableTaste,
    MongoTasteStore,
    isValidTasteUserId,
    migrateTasteProfiles,
    TasteFile,
    TastePersistence,
    tasteMatches,
    TASTE_SIZE_WARN_BYTES,
    TasteLoadResult,
} from "./taste-store";
import type { DataStore } from "./db";
import type { UserTaste } from "./user-taste";

/** A profile with just enough shape to be usable. */
function taste(overrides: Partial<UserTaste> = {}): UserTaste {
    return {
        songData: { s1: { rating: 0.5, skipCount: 1, playbackCount: 4, replayCount: 0 } },
        history: [
            { songId: "s1", sessionDuration: 1, skipped: false, replayed: false, timestamp: 1_700_000_000_000 },
        ],
        streakHistory: [{ duration: 600e3, timestamp: 1_700_000_000_000 }],
        affinityHistory: [],
        ...overrides,
    } as unknown as UserTaste;
}

class FakeStore implements TastePersistence {
    profiles = new Map<string, UserTaste>();
    failWritesFor = new Set<string>();
    /** Reports success without storing, as a lost write would. */
    silentlyDropWritesFor = new Set<string>();
    /** Stores a profile that comes back short, as a truncated write would. */
    truncateWritesFor = new Set<string>();

    async get(userId: string) {
        return this.profiles.get(userId) ?? null;
    }

    async load(userId: string): Promise<TasteLoadResult> {
        const stored = this.profiles.get(userId);

        return (stored ? { status: "loaded", taste: { ...stored } } : { status: "absent" });
    }

    async set(userId: string, value: UserTaste) {
        if (this.failWritesFor.has(userId))
            return false;

        if (this.silentlyDropWritesFor.has(userId))
            return true;

        if (this.truncateWritesFor.has(userId)) {
            this.profiles.set(userId, { ...value, history: [] } as UserTaste);

            return true;
        }

        this.profiles.set(userId, value);

        return true;
    }

    async exists(userId: string) {
        return this.profiles.has(userId);
    }
}

function file(userId: string, value = taste(), bytes = 30_000): TasteFile {
    return { userId, taste: value, path: `/tempodb/data/tastes/${userId}.json`, bytes };
}

async function migrate(files: TasteFile[], store: TastePersistence) {
    const removed: string[] = [];

    const report = await migrateTasteProfiles({ files, store, removeFile: p => removed.push(p) });

    return { report, removed };
}

describe("isValidTasteUserId", () => {
    it("accepts a Spotify id", () => {
        assert.equal(isValidTasteUserId("yh1q376ly901c0qk03n9kaphh"), true);
    });

    it("refuses anything that could address a field inside a document", () => {
        assert.equal(isValidTasteUserId("someid/history"), false);
        assert.equal(isValidTasteUserId("../../etc"), false);
        assert.equal(isValidTasteUserId(""), false);
    });
});

describe("isUsableTaste", () => {
    it("accepts a profile", () => {
        assert.equal(isUsableTaste(taste()), true);
    });

    it("accepts a profile with no listening yet", () => {
        assert.equal(isUsableTaste(taste({ history: [], songData: {} } as Partial<UserTaste>)), true);
    });

    it("refuses something that is merely present", () => {
        assert.equal(isUsableTaste(null), false);
        assert.equal(isUsableTaste(undefined), false);
        assert.equal(isUsableTaste({}), false);
        assert.equal(isUsableTaste({ history: "not an array", songData: {} }), false);
        assert.equal(isUsableTaste({ history: [] }), false);
    });
});

describe("MongoTasteStore hands out its own copy", () => {
    /**
     * Stands in for DataStore, reproducing the behaviour that matters: reads are
     * served from a cache, so the same object comes back each time.
     */
    function cachingDataStore(stored: UserTaste) {
        const shared = stored;

        return {
            async get() { return shared; },
            async set() { return true; },
            async exists() { return true; },
            async all() { return [shared]; },
            async remove() { return true; },
        };
    }

    it("does not let a caller narrow what the next one reads", async () => {
        // The shape of a bug that reached production: one caller filtered the
        // history in place and every other holder of that object lost the rest
        const profile = taste({
            history: Array.from({ length: 10 }, (_, i) => ({
                songId: `s${i}`, sessionDuration: 1, skipped: false, replayed: false, timestamp: i,
            })),
        } as Partial<UserTaste>);

        const store = new MongoTasteStore(cachingDataStore(profile) as never);

        const first = await store.get("alice");

        first!.history = first!.history.slice(0, 2);

        const second = await store.get("alice");

        assert.equal(second?.history.length, 10);
    });

    it("does not let a caller add to what the next one reads", async () => {
        const profile = taste();
        const store = new MongoTasteStore(cachingDataStore(profile) as never);

        const first = await store.get("alice");

        first!.streakHistory = [...first!.streakHistory, { duration: 1, timestamp: 1 }];

        assert.equal((await store.get("alice"))?.streakHistory.length, 1);
    });

    it("still refuses something that is not a profile", async () => {
        const store = new MongoTasteStore(cachingDataStore({ nonsense: true } as unknown as UserTaste) as never);

        assert.equal(await store.get("alice"), null);
    });
});

describe("MongoTasteStore.load tells absence and failure apart", () => {
    function dataStore(behaviour: "throws" | "empty" | "invalid" | UserTaste) {
        return {
            async get() {
                if (behaviour === "throws")
                    throw new Error("database fell over");

                if (behaviour === "empty")
                    return null;

                if (behaviour === "invalid")
                    return { some: "unrelated document" };

                return behaviour;
            },
            async set() { return true; },
            async exists() { return behaviour !== "empty"; },
            async all() { return []; },
            async remove() { return true; },
        };
    }

    it("reports a stored profile as loaded", async () => {
        const store = new MongoTasteStore(dataStore(taste()) as unknown as DataStore);
        const result = await store.load("alice");

        assert.equal(result.status, "loaded");
    });

    it("reports a missing profile as absent, which invites starting fresh", async () => {
        const store = new MongoTasteStore(dataStore("empty") as unknown as DataStore);

        assert.deepEqual(await store.load("alice"), { status: "absent" });
    });

    it("reports a database failure as an error, never as absence", async () => {
        // The distinction this method exists for: a session that mistakes this
        // for absence starts fresh and saves nothing over months of history
        const store = new MongoTasteStore(dataStore("throws") as unknown as DataStore);

        assert.deepEqual(await store.load("alice"), { status: "error" });
    });

    it("reports a present-but-unusable document as an error, not absence", async () => {
        // Whatever this is, it is somebody's stored data; refusing beats erasing
        const store = new MongoTasteStore(dataStore("invalid") as unknown as DataStore);

        assert.deepEqual(await store.load("alice"), { status: "error" });
    });

    it("refuses an id that would address inside another document", async () => {
        const store = new MongoTasteStore(dataStore(taste()) as unknown as DataStore);

        assert.deepEqual(await store.load("alice/settings"), { status: "error" });
    });
});

describe("tasteMatches", () => {
    it("accepts a profile that came back whole", () => {
        assert.equal(tasteMatches(taste(), taste()), true);
    });

    it("rejects one that came back with history missing", () => {
        assert.equal(tasteMatches(taste(), taste({ history: [] } as Partial<UserTaste>)), false);
    });

    it("rejects one that came back with tracks missing", () => {
        assert.equal(tasteMatches(taste(), taste({ songData: {} } as Partial<UserTaste>)), false);
    });

    it("rejects one that lost its finished streaks", () => {
        assert.equal(tasteMatches(taste(), taste({ streakHistory: [] } as Partial<UserTaste>)), false);
    });

    it("rejects nothing at all", () => {
        assert.equal(tasteMatches(taste(), null), false);
    });
});

describe("migrateTasteProfiles", () => {
    it("does nothing when there is nothing on disk", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate([], store);

        assert.equal(report.imported, 0);
        assert.equal(removed.length, 0);
    });

    it("imports a profile and only then deletes its file", async () => {
        const store = new FakeStore();
        const profile = taste();

        const { report, removed } = await migrate([file("alice", profile)], store);

        assert.equal(report.imported, 1);
        assert.deepEqual(removed, ["/tempodb/data/tastes/alice.json"]);
        assert.deepEqual(store.profiles.get("alice"), profile);
    });

    it("carries the listening history across intact", async () => {
        const store = new FakeStore();
        const profile = taste({
            history: Array.from({ length: 500 }, (_, i) => ({
                songId: `s${i}`, sessionDuration: 1, skipped: false, replayed: false, timestamp: i,
            })),
        } as Partial<UserTaste>);

        await migrate([file("alice", profile)], store);

        assert.equal(store.profiles.get("alice")?.history.length, 500);
    });

    it("carries finished streaks across", async () => {
        const store = new FakeStore();
        const profile = taste({
            streakHistory: [
                { duration: 34_034_762, timestamp: 1 },
                { duration: 600e3, timestamp: 2 },
            ],
        } as Partial<UserTaste>);

        await migrate([file("alice", profile)], store);

        assert.equal(store.profiles.get("alice")?.streakHistory.length, 2);
    });

    it("keeps the file when the write fails", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "write-failed");
        assert.deepEqual(removed, []);
    });

    it("keeps the file when a write reports success but stored nothing", async () => {
        const store = new FakeStore();
        store.silentlyDropWritesFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "verify-failed");
        assert.deepEqual(removed, []);
    });

    it("keeps the file when the profile came back truncated", async () => {
        // Months of listening with the history missing would otherwise be
        // accepted, and the file holding the only complete copy deleted
        const store = new FakeStore();
        store.truncateWritesFor.add("alice");

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "verify-failed");
        assert.deepEqual(removed, []);
    });

    it("carries on past a profile that failed", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("bob");

        const { report, removed } = await migrate(
            [file("alice"), file("bob"), file("carol")], store);

        assert.equal(report.imported, 2);
        assert.equal(report.failed, 1);
        assert.equal(removed.length, 2);
    });

    it("refuses a file whose name could address a document field", async () => {
        const store = new FakeStore();
        const { report, removed } = await migrate([file("alice/history")], store);

        assert.equal(report.results[0].outcome, "invalid");
        assert.equal(store.profiles.size, 0);
        assert.deepEqual(removed, []);
    });

    it("refuses a file that did not parse into a profile", async () => {
        const store = new FakeStore();
        const { report } = await migrate(
            [file("alice", { nonsense: true } as unknown as UserTaste)], store);

        assert.equal(report.results[0].outcome, "invalid");
        assert.equal(store.profiles.size, 0);
    });

    it("does not overwrite a profile the store already holds", async () => {
        const store = new FakeStore();
        const live = taste({
            history: [
                { songId: "new", sessionDuration: 1, skipped: false, replayed: false, timestamp: 2 },
                { songId: "newer", sessionDuration: 1, skipped: false, replayed: false, timestamp: 3 },
            ],
        } as Partial<UserTaste>);

        store.profiles.set("alice", live);

        const { report, removed } = await migrate([file("alice")], store);

        assert.equal(report.results[0].outcome, "already-present");
        // Anything played since the first run survives
        assert.deepEqual(store.profiles.get("alice"), live);
        assert.deepEqual(removed, ["/tempodb/data/tastes/alice.json"]);
    });

    it("is safe to run twice", async () => {
        const store = new FakeStore();
        const files = [file("alice"), file("bob")];

        const first = await migrate(files, store);
        const second = await migrate(files, store);

        assert.equal(first.report.imported, 2);
        assert.equal(second.report.imported, 0);
        assert.equal(second.report.failed, 0);
    });

    it("can be re-run to pick up what failed the first time", async () => {
        const store = new FakeStore();
        store.failWritesFor.add("bob");

        const first = await migrate([file("alice"), file("bob")], store);

        assert.equal(first.report.failed, 1);

        store.failWritesFor.clear();

        const second = await migrate([file("bob")], store);

        assert.equal(second.report.imported, 1);
        assert.equal(store.profiles.size, 2);
    });

    it("flags a profile approaching the document ceiling", async () => {
        const store = new FakeStore();
        const { report } = await migrate([file("alice", taste(), TASTE_SIZE_WARN_BYTES + 1)], store);

        assert.equal(report.results[0].oversized, true);
        // Still imported: it is a warning, not a refusal
        assert.equal(report.results[0].outcome, "imported");
    });

    it("does not flag an ordinary profile", async () => {
        const store = new FakeStore();
        const { report } = await migrate([file("alice", taste(), 30_000)], store);

        assert.equal(report.results[0].oversized, undefined);
    });
});
