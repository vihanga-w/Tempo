/**
 * Where a listening streak lives between restarts.
 *
 * It used to be a file per user under DATA_DIR, restored only if a separate
 * liveliness file said the server had been up within the last ten minutes. That
 * had the same shape as the VAPID key before it moved: state on a volume, lost
 * whenever the volume is rebuilt, and quietly discarded whenever a deploy took
 * longer than the window allowed. Files were also unlinked as they were read, so
 * a crash between reading and the next write lost them outright.
 *
 * The database has none of those properties, and it already holds everything
 * else a streak has to agree with.
 */

import type { DataStore } from "./db";

export const STREAK_COLLECTION = "streaks";

/**
 * How stale a stored streak may be and still be picked back up.
 *
 * The record is rewritten on every song change, so one older than this means the
 * listener has not changed track in half an hour and the run is over by the ten
 * minute rule regardless. This only avoids resurrecting something plainly dead —
 * the loss check does the real work, and re-validates whatever is restored
 * against the listening history on the first poll.
 */
export const STREAK_RESTORE_MAX_AGE = 30 * 60e3;

export interface StreakRecord {
    playSessionStart: number;
    /** Refreshed on every song change, so it doubles as a liveliness marker. */
    updatedAt: number;
}

/** The storage operations a streak needs, so the migration can be tested. */
export interface StreakPersistence {
    get(userId: string): Promise<StreakRecord | null>;
    set(userId: string, record: StreakRecord): Promise<boolean>;
    remove(userId: string): Promise<boolean>;
    all(): Promise<({ userId: string } & StreakRecord)[]>;
}

/**
 * User ids become document paths, and the datastore reads "/" as a field
 * separator, so anything that is not a plain id is refused rather than allowed
 * to address part of a document.
 */
export function isValidStreakUserId(userId: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(userId);
}

export class MongoStreakStore implements StreakPersistence {
    constructor(private db: DataStore) {}

    async get(userId: string): Promise<StreakRecord | null> {
        if (!isValidStreakUserId(userId))
            return null;

        const record = await this.db.get<StreakRecord>(STREAK_COLLECTION, userId, false, true);

        if (!record || typeof record.playSessionStart !== "number")
            return null;

        return { playSessionStart: record.playSessionStart, updatedAt: record.updatedAt ?? 0 };
    }

    async set(userId: string, record: StreakRecord): Promise<boolean> {
        if (!isValidStreakUserId(userId))
            return false;

        return await this.db.set<StreakRecord>(STREAK_COLLECTION, userId, record);
    }

    async remove(userId: string): Promise<boolean> {
        if (!isValidStreakUserId(userId))
            return false;

        return await this.db.remove(STREAK_COLLECTION, userId);
    }

    async all(): Promise<({ userId: string } & StreakRecord)[]> {
        const docs = await this.db.all<StreakRecord & { userId?: string }>(STREAK_COLLECTION);

        return docs
            .filter(d => typeof d?.playSessionStart === "number" && typeof d.userId === "string")
            .map(d => ({ userId: d.userId as string, playSessionStart: d.playSessionStart, updatedAt: d.updatedAt ?? 0 }));
    }
}

/** Whether a stored streak is recent enough to pick back up. */
export function isRestorable(record: StreakRecord, now: number): boolean {
    if (record.playSessionStart <= 0)
        return false;

    // A record from the future is a clock problem, not a streak
    if (record.playSessionStart > now)
        return false;

    return (now - record.updatedAt) <= STREAK_RESTORE_MAX_AGE;
}

/** One streak file found on disk, already parsed. */
export interface StreakFile {
    userId: string;
    playSessionStart: number;
    path: string;
}

export type MigrationOutcome =
    | "imported"
    | "already-present"
    | "invalid"
    | "write-failed"
    | "verify-failed";

export interface MigrationReport {
    /** Per user, what happened and whether the file was safe to delete. */
    results: { userId: string; outcome: MigrationOutcome; fileRemoved: boolean }[];
    imported: number;
    removed: number;
    failed: number;
}

/**
 * Moves streaks off disk and into the store, once.
 *
 * Nothing is deleted on trust. Each record is written, read back, and compared
 * against what the file said before its file is removed — a write that silently
 * failed would otherwise take the only copy of the data with it. A file whose
 * record cannot be verified is left exactly where it is, so the migration can be
 * run again after the cause is fixed.
 *
 * A user already present in the store is left alone rather than overwritten: on
 * a second run the store is the newer copy, and clobbering it with a stale file
 * would undo the work of the first.
 */
export async function migrateStreaksFromDisk(options: {
    files: StreakFile[];
    store: StreakPersistence;
    removeFile: (path: string) => void;
    now: number;
}): Promise<MigrationReport> {
    const { files, store, removeFile, now } = options;

    const results: MigrationReport["results"] = [];

    for (const file of files) {
        if (!isValidStreakUserId(file.userId) || typeof file.playSessionStart !== "number" || file.playSessionStart <= 0) {
            results.push({ userId: file.userId, outcome: "invalid", fileRemoved: false });

            continue;
        }

        const existing = await store.get(file.userId);

        // A stored record has to be usable to count as already migrated.
        // Treating a nonsensical one as present would delete the file that
        // could have replaced it.
        if (existing && existing.playSessionStart > 0) {
            // The store already has this user, so the file is the older copy and
            // has nothing left to contribute
            removeFile(file.path);

            results.push({ userId: file.userId, outcome: "already-present", fileRemoved: true });

            continue;
        }

        const written = await store.set(file.userId, {
            playSessionStart: file.playSessionStart,
            updatedAt: now,
        });

        if (!written) {
            results.push({ userId: file.userId, outcome: "write-failed", fileRemoved: false });

            continue;
        }

        const readBack = await store.get(file.userId);

        if (!readBack || readBack.playSessionStart !== file.playSessionStart) {
            results.push({ userId: file.userId, outcome: "verify-failed", fileRemoved: false });

            continue;
        }

        removeFile(file.path);

        results.push({ userId: file.userId, outcome: "imported", fileRemoved: true });
    }

    return {
        results,
        imported: results.filter(r => r.outcome === "imported").length,
        removed: results.filter(r => r.fileRemoved).length,
        failed: results.filter(r => r.outcome === "write-failed" || r.outcome === "verify-failed" || r.outcome === "invalid").length,
    };
}
