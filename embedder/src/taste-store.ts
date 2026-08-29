/**
 * Where a user's taste profile lives.
 *
 * It was a JSON file per user under DATA_DIR — the same volume-bound storage the
 * VAPID key and the listening streak have already moved off. The exposure here
 * is larger than either: a profile holds every track a listener has played,
 * every rating and skip, and the streaks they have finished. A rebuilt volume
 * loses months of it, and recaps read from it, so its absence is visible.
 */

import type { DataStore } from "./db";
import type { UserTaste } from "./user-taste";

export const TASTE_COLLECTION = "tastes";

/**
 * A profile approaching this is worth knowing about.
 *
 * MongoDB refuses a document over 16MB. Profiles are a few tens of kilobytes
 * today, but history grows with every track played and nothing prunes it, so
 * the ceiling is a real one eventually rather than a theoretical one. Warning
 * well short of it leaves room to split history out before anything breaks.
 */
export const TASTE_SIZE_WARN_BYTES = 8 * 1024 * 1024;

/** A load that says why it has nothing, not just that it has nothing. */
export type TasteLoadResult =
    | { status: "loaded"; taste: UserTaste }
    | { status: "absent" }
    | { status: "error" };

export interface TastePersistence {
    get(userId: string): Promise<UserTaste | null>;
    /**
     * Like get, but absence and failure are told apart.
     *
     * get collapses "this person has no profile yet" and "the database fell
     * over" into the same null, which is fine for a read-only endpoint - it
     * renders empty either way - and catastrophic for a session: a session
     * adopts what it loads as its live profile and saves it back, so a null
     * born of a transient error became an empty profile written over months of
     * history. Anything that will later WRITE the profile back must load it
     * through this and refuse to run on "error".
     */
    load(userId: string): Promise<TasteLoadResult>;
    set(userId: string, taste: UserTaste): Promise<boolean>;
    exists(userId: string): Promise<boolean>;
}

/**
 * User ids become document paths, and the datastore reads "/" as a field
 * separator, so anything that is not a plain id is refused rather than allowed
 * to address part of a document.
 */
export function isValidTasteUserId(userId: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(userId);
}

/** Whether a value has the shape of a profile rather than merely being present. */
export function isUsableTaste(taste: unknown): taste is UserTaste {
    const candidate = taste as UserTaste | null;

    return (
        !!candidate &&
        typeof candidate === "object" &&
        Array.isArray(candidate.history) &&
        typeof candidate.songData === "object" &&
        candidate.songData !== null
    );
}

export class MongoTasteStore implements TastePersistence {
    constructor(private db: DataStore) {}

    async get(userId: string): Promise<UserTaste | null> {
        if (!isValidTasteUserId(userId))
            return null;

        const taste = await this.db.get<UserTaste>(TASTE_COLLECTION, userId, false, true);

        if (!isUsableTaste(taste))
            return null;

        // Copied, because the datastore serves reads from a short lived cache and
        // returns the same object each time within it. A caller that keeps what
        // it is given — a session adopts this as its live profile, and then adds
        // to it for as long as that session lasts — would otherwise be writing
        // into something another caller is reading, and narrowing it would
        // narrow theirs. That is exactly how a request for a day of top songs
        // once left the past week reading a day.
        //
        // Shallow is enough: every writer replaces a top level array rather than
        // pushing into one.
        return { ...taste };
    }

    async load(userId: string): Promise<TasteLoadResult> {
        if (!isValidTasteUserId(userId))
            return { status: "error" };

        let stored: UserTaste | null;

        try {
            // dontFail deliberately NOT set: a database error must surface here
            // rather than masquerade as an empty result
            stored = await this.db.get<UserTaste>(TASTE_COLLECTION, userId, false);
        } catch {
            return { status: "error" };
        }

        if (stored === null)
            return { status: "absent" };

        // Present but not shaped like a profile. Absence would invite the
        // caller to start fresh and save over it - and whatever this is, it is
        // somebody's stored data, so refusing to run beats erasing it.
        if (!isUsableTaste(stored))
            return { status: "error" };

        // Copied for the same reason get() copies; see above.
        return { status: "loaded", taste: { ...stored } };
    }

    async set(userId: string, taste: UserTaste): Promise<boolean> {
        if (!isValidTasteUserId(userId))
            return false;

        return await this.db.set<UserTaste>(TASTE_COLLECTION, userId, taste);
    }

    async exists(userId: string): Promise<boolean> {
        if (!isValidTasteUserId(userId))
            return false;

        return await this.db.exists(TASTE_COLLECTION, userId, true);
    }
}

/** One profile found on disk, already parsed. */
export interface TasteFile {
    userId: string;
    taste: UserTaste;
    path: string;
    /** Serialised size, for the ceiling warning. */
    bytes: number;
}

export type TasteMigrationOutcome =
    | "imported"
    | "already-present"
    | "invalid"
    | "write-failed"
    | "verify-failed";

export interface TasteMigrationReport {
    results: {
        userId: string;
        outcome: TasteMigrationOutcome;
        fileRemoved: boolean;
        /** Set when the profile is large enough to be worth watching. */
        oversized?: boolean;
    }[];
    imported: number;
    removed: number;
    failed: number;
}

/**
 * Compares what was read back against what was written.
 *
 * Not a deep equality check: the point is to catch a write that did not land or
 * landed truncated, not to re-validate every field. History length and the
 * number of tracks known are the two things that would differ if the document
 * were incomplete, and both are cheap to compare.
 */
export function tasteMatches(written: UserTaste, readBack: UserTaste | null): boolean {
    if (!isUsableTaste(readBack))
        return false;

    if (readBack.history.length !== written.history.length)
        return false;

    if (Object.keys(readBack.songData).length !== Object.keys(written.songData).length)
        return false;

    const writtenStreaks = written.streakHistory?.length ?? 0;
    const readStreaks = readBack.streakHistory?.length ?? 0;

    return (writtenStreaks === readStreaks);
}

/**
 * Moves taste profiles off disk and into the store, once.
 *
 * Nothing is deleted on trust. Each profile is written, read back, and compared
 * before its file is removed — a profile is months of listening and there is no
 * second copy of it anywhere, so a write that silently failed must not take it.
 * A file that cannot be verified is left where it is and reported, so the
 * migration can be run again once the cause is fixed.
 *
 * A user already present in the store is left alone: on a second run the store
 * holds the newer profile, and overwriting it with a stale file would discard
 * whatever has been played since.
 */
export async function migrateTasteProfiles(options: {
    files: TasteFile[];
    store: TastePersistence;
    removeFile: (path: string) => void;
}): Promise<TasteMigrationReport> {
    const { files, store, removeFile } = options;

    const results: TasteMigrationReport["results"] = [];

    for (const file of files) {
        const oversized = (file.bytes >= TASTE_SIZE_WARN_BYTES ? true : undefined);

        if (!isValidTasteUserId(file.userId) || !isUsableTaste(file.taste)) {
            results.push({ userId: file.userId, outcome: "invalid", fileRemoved: false, oversized });

            continue;
        }

        if (await store.exists(file.userId)) {
            // The store already holds this user, so the file is the older copy
            removeFile(file.path);

            results.push({ userId: file.userId, outcome: "already-present", fileRemoved: true, oversized });

            continue;
        }

        if (!await store.set(file.userId, file.taste)) {
            results.push({ userId: file.userId, outcome: "write-failed", fileRemoved: false, oversized });

            continue;
        }

        if (!tasteMatches(file.taste, await store.get(file.userId))) {
            results.push({ userId: file.userId, outcome: "verify-failed", fileRemoved: false, oversized });

            continue;
        }

        removeFile(file.path);

        results.push({ userId: file.userId, outcome: "imported", fileRemoved: true, oversized });
    }

    return {
        results,
        imported: results.filter(r => r.outcome === "imported").length,
        removed: results.filter(r => r.fileRemoved).length,
        failed: results.filter(r => r.outcome !== "imported" && r.outcome !== "already-present").length,
    };
}
