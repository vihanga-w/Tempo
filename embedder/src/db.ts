import { Collection, Db, MongoClient } from 'mongodb';

import { SpotifyUser } from './spotify';
import { UserTaste } from './user-taste';
import { EventEmitter } from 'stream';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Recap } from './recap-scheduler';
import { Mutex } from 'async-mutex';
import { MONGODB_URI, MONGODB_DB, DATA_DIR } from './env';

// Define types for documents
export type EmbeddingDocType = {
    songId: string;
    embedding: number[];
}
export type UserDocType = SpotifyUser;
export type TasteDocType = UserTaste;

const MAX_CACHE_DURATION = 1e3;
const MAX_CACHE_SIZE = 1000;

/**
 * Paths keep the AceBase shape they had when this talked to the distributed-db
 * service: the first segment is the document id, the rest is a field path
 * inside it. Preserving that is what lets the ~90 call sites stay untouched.
 *
 *   "abc123"                     -> document abc123
 *   "abc123/meta/tokenVersion"   -> field meta.tokenVersion of document abc123
 */
function splitPath(path: string): { id: string; field: string | undefined } {
    const segments = path.split("/").filter(v => v !== "");

    return {
        id: segments[0] ?? "",
        field: segments.length > 1 ? segments.slice(1).join(".") : undefined,
    };
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return (typeof value === "object" && value !== null && !Array.isArray(value));
}

/** Walks a dotted field path, returning undefined if any link is missing. */
function readFieldPath(doc: any, field: string | undefined) {
    if (field === undefined)
        return doc;

    let cursor = doc;

    for (const segment of field.split(".")) {
        if (cursor === null || cursor === undefined || typeof cursor !== "object")
            return undefined;

        cursor = cursor[segment];
    }

    return cursor;
}

/** `_id` is ours, not the caller's — strip it so documents match their types. */
function stripId<T>(doc: any): T | null {
    if (!doc)
        return null;

    const { _id, ...rest } = doc;

    return rest as T;
}

export class DataStore extends EventEmitter {
    private client: MongoClient;
    private db: Db;
    private connected = false;
    /**
     * The read-cache sweeper, kept so shutdown can stop it.
     *
     * An interval nobody holds keeps the event loop alive for ever. The server
     * never noticed, because it does not intend to exit -- but every one-off
     * script that opens a datastore and shuts it down again hung on this after
     * finishing its work, which on a terminal looks like a slow query and in a
     * pipe looks like nothing at all, because the output was still buffered.
     */
    private cacheSweeper: NodeJS.Timeout;
    private readResponseCache: {[key: string]: {
        timestamp: number;
        data: any;
        lastAccessed: number;
        mutex: Mutex;
    }} = {};

    constructor() {
        super();

        this.client = new MongoClient(MONGODB_URI, {
            // Fail fast rather than hanging a request while Mongo is unreachable
            serverSelectionTimeoutMS: 5e3,
            retryWrites: true,
        });

        this.db = this.client.db(MONGODB_DB);

        this.cacheSweeper = setInterval(() => {
            const d = Date.now();

            const keys = Object.keys(this.readResponseCache);

            keys.forEach(v => {
                if (d - this.readResponseCache[v].timestamp > MAX_CACHE_DURATION)
                    delete this.readResponseCache[v];
            });
        }, 2500);

        this._connect()
        .then(() => {
            this.connected = true;

            console.log(`Connected to MongoDB database "${MONGODB_DB}"`);

            this.emit("ready");
        })
        .catch(ex => {
            console.error("Failed to connect to MongoDB:", ex);

            process.exit(1);
        });
    }

    private async _connect() {
        await this.client.connect();

        // Mirrors the indexes the AceBase store created on startup. createIndex
        // is idempotent, so running this every boot is fine.
        await this.db.collection("friends").createIndex({ u1Id: 1 });
        await this.db.collection("friends").createIndex({ u2Id: 1 });
    }

    private _collection(collectionId: string): Collection {
        const name = collectionId.split("/")[0];

        if (!name)
            throw new Error("Unknown collectionId: " + collectionId);

        return this.db.collection(name);
    }

    private async _updateCachedObjectLastAccessed(cachePath: string) {
        await this.readResponseCache[cachePath].mutex.acquire();
        this.readResponseCache[cachePath].lastAccessed = Date.now();
        this.readResponseCache[cachePath].mutex.release();
    }

    private async _getCachedObjectGet<T>(collectionId: string, path?: string) {
        const cachePath = (collectionId + ":" + (path ?? "") + "get");

        if (!this.readResponseCache[cachePath])
            return null;

        if (Date.now() - this.readResponseCache[cachePath].timestamp <= MAX_CACHE_DURATION) {
            await this._updateCachedObjectLastAccessed(cachePath);

            return this.readResponseCache[cachePath].data as T;
        }

        return null;
    }

    private async _getCachedObjectExists(collectionId: string, path?: string) {
        const cachePath = (collectionId + ":" + (path ?? "") + "exists");

        if (!this.readResponseCache[cachePath])
            return null;

        if (Date.now() - this.readResponseCache[cachePath].timestamp <= MAX_CACHE_DURATION) {
            await this._updateCachedObjectLastAccessed(cachePath);

            return this.readResponseCache[cachePath].data as boolean;
        }

        return null;
    }

    private async _setCachedObject(kind: "get" | "exists", collectionId: string, value: any, path?: string, skipIfNonExist?: boolean) {
        const cachePath = collectionId + ":" + (path ?? "") + kind;

        if (!this.readResponseCache[cachePath] && skipIfNonExist)
            return;

        const mutex = (this.readResponseCache[cachePath]?.mutex ?? new Mutex());

        await mutex.acquire();

        try {
            if (Object.keys(this.readResponseCache).length >= MAX_CACHE_SIZE) {
                const keys = Object.keys(this.readResponseCache);

                const oldestKey = keys.reduce((oldest, key) => {
                    return this.readResponseCache[key].lastAccessed < this.readResponseCache[oldest].lastAccessed ? key : oldest;
                }, keys[0]);

                delete this.readResponseCache[oldestKey];
            }

            if (value === undefined) {
                delete this.readResponseCache[cachePath];

                return;
            }

            this.readResponseCache[cachePath] = {
                timestamp: Date.now(),
                data: value,
                lastAccessed: Date.now(),
                mutex,
            };
        } finally {
            mutex.release();
        }
    }

    /**
     * Drops every cached view of the document a write touched.
     *
     * Invalidating only the exact path written is not enough: writing
     * "u1/meta/state" leaves a cached copy of "u1" holding the old value, so a
     * read of the parent inside the cache window returns stale data. Anything
     * keyed to the same document id goes.
     *
     * This also replaces the previous behaviour of writing `exists = false`
     * after a successful update, which made exists() wrongly report a missing
     * document for the following second.
     */
    private _invalidate(collectionId: string, path?: string) {
        if (!path) {
            for (const key of Object.keys(this.readResponseCache)) {
                if (key.startsWith(collectionId + ":"))
                    delete this.readResponseCache[key];
            }

            return;
        }

        const { id } = splitPath(path);
        const documentPrefix = collectionId + ":" + id;

        for (const key of Object.keys(this.readResponseCache)) {
            if (!key.startsWith(documentPrefix))
                continue;

            // Guard against "u1" matching "u10" — the next character must end
            // the id or begin a field path
            const next = key.charAt(documentPrefix.length);

            if (next === "/" || next === "g" || next === "e")
                delete this.readResponseCache[key];
        }
    }

    async exists(collectionId: string, path?: string, dontFail?: boolean) {
        try {
            const cached = await this._getCachedObjectExists(collectionId, path);

            if (cached !== null)
                return cached;

            const collection = this._collection(collectionId);

            let result: boolean;

            if (!path) {
                // Collection-level check: is there anything in here at all
                result = (await collection.countDocuments({}, { limit: 1 })) > 0;
            } else {
                const { id, field } = splitPath(path);

                if (!field) {
                    result = (await collection.countDocuments({ _id: id as any }, { limit: 1 })) > 0;
                } else {
                    const doc = await collection.findOne(
                        { _id: id as any },
                        { projection: { [field]: 1 } }
                    );

                    result = readFieldPath(doc, field) !== undefined;
                }
            }

            await this._setCachedObject("exists", collectionId, result, path);

            return result;
        } catch (ex) {
            console.error("Failed to run database exists check:", collectionId, path, "error:", ex);

            if (dontFail)
                return false;

            throw ex;
        }
    }

    /**
     * Reads a value. Returns null when the document or field does not exist.
     *
     * `notNull` is accepted for call-site compatibility but does not cause a
     * throw — see the note at the return below.
     */
    async get<T>(collectionId: string, path?: string, notNull?: boolean, dontFail?: boolean) {
        try {
            if (!path)
                return null;

            const cached = await this._getCachedObjectGet<T>(collectionId, path);

            if (cached !== null)
                return cached;

            const { id, field } = splitPath(path);

            const doc = await this._collection(collectionId).findOne(
                { _id: id as any },
                field ? { projection: { [field]: 1 } } : undefined
            );

            const value = field ? readFieldPath(doc, field) : stripId<T>(doc);

            // A missing value always returns null.
            //
            // `notNull` originally meant "throw if absent", but the flag was
            // never actually transmitted to the old database service, so it has
            // never had any effect and every one of the ~19 call sites passing
            // it is written to handle null — several as `(await get(..., true))
            // ?? []`. Honouring it now would turn those into throws on paths
            // that do not catch, which is exactly what hung token verification.
            // The parameter is kept so call sites compile unchanged.
            if (value === undefined || value === null)
                return null;

            await this._setCachedObject("get", collectionId, value, path);

            return value as T;
        } catch (ex) {
            console.error("Failed to run database get:", collectionId, path, "error:", ex);

            if (dontFail)
                return null;

            throw ex;
        }
    }

    /**
     * Writes `value` at `path`, replacing whatever was there.
     *
     * A bare document id replaces the whole document; a nested path sets just
     * that field. Missing documents are created.
     */
    async set<T>(collectionId: string, path?: string, value?: T) {
        if (!path)
            return false;

        try {
            const { id, field } = splitPath(path);
            const collection = this._collection(collectionId);

            if (!field) {
                await collection.replaceOne(
                    { _id: id as any },
                    { ...(value as object), _id: id } as any,
                    { upsert: true }
                );
            } else {
                await collection.updateOne(
                    { _id: id as any },
                    { $set: { [field]: value } },
                    { upsert: true }
                );
            }

            this._invalidate(collectionId, path);

            return true;
        } catch (ex) {
            console.error("Failed to run database set:", collectionId, path, "error:", ex);

            return false;
        }
    }

    /**
     * Merges `value` into `path`.
     *
     * Plain objects merge one level deep, matching the AceBase `ref.update()`
     * this replaced. Arrays and primitives replace the target outright — AceBase
     * merged arrays by index, so filtering an array and writing it back never
     * actually shortened the stored value. User.markPriorityFYPAlertViewed
     * depends on removal working, so that behaviour is now correct.
     */
    async update<T>(collectionId: string, path?: string, value?: Partial<T>) {
        if (!path || value === undefined)
            return false;

        try {
            const { id, field } = splitPath(path);
            const collection = this._collection(collectionId);

            const set: Record<string, any> = {};

            if (isPlainObject(value)) {
                for (const [key, entry] of Object.entries(value)) {
                    set[field ? `${field}.${key}` : key] = entry;
                }
            } else if (field) {
                set[field] = value;
            } else {
                console.warn("Refusing to update a document root with a non-object value:", collectionId, path);

                return false;
            }

            if (Object.keys(set).length === 0)
                return true;

            await collection.updateOne(
                { _id: id as any },
                { $set: set },
                { upsert: true }
            );

            this._invalidate(collectionId, path);

            return true;
        } catch (ex) {
            console.error("Failed to run database update:", collectionId, path, "error:", ex);

            return false;
        }
    }

    async remove<T>(collectionId: string, path: string) {
        if (!path)
            return false;

        try {
            const { id, field } = splitPath(path);
            const collection = this._collection(collectionId);

            if (!field)
                await collection.deleteOne({ _id: id as any });
            else
                await collection.updateOne({ _id: id as any }, { $unset: { [field]: "" } });

            this._invalidate(collectionId, path);

            return true;
        } catch (ex) {
            console.error("Failed to run database remove:", collectionId, path, "error:", ex);

            return false;
        }
    }

    async all<T>(collectionId: string) {
        try {
            const docs = await this._collection(collectionId).find({}).toArray();

            return docs.map(v => stripId<T>(v)).filter(v => v !== null) as T[];
        } catch (ex) {
            console.error("Failed to list database collection:", collectionId, "error:", ex);

            throw ex;
        }
    }

    async getRecap(userId: string, type: "daily" | "weekly", ignoreViewedState?: boolean): Promise<null | Recap> {
        const recapPath = `${DATA_DIR}/recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;

        if (!existsSync(recapPath)) return null;

        const user = await this.get<UserDocType>("users", userId, true);
        if (!user) return null;

        const availableDate = type === "daily"
            ? user.meta?.dayRecapAvailableDate
            : user.meta?.weekRecapAvailableDate;

        if (!availableDate || availableDate === -1) return null;

        const now = Date.now();
        const expiry = availableDate + (type === "daily" ? 1 : 7) * 24 * 60 * 60 * 1000;

        if (now > expiry) return null;

        const recapData: Recap = JSON.parse(readFileSync(recapPath).toString());

        if (!ignoreViewedState) {
            if (type === "daily" && user.meta.viewedDailyRecap === recapData.id) return null;
            if (type === "weekly" && user.meta.viewedWeeklyRecap === recapData.id) return null;
        }

        return recapData;
    }

    async markRecapSeen(userId: string, type: "daily" | "weekly") {
        const user = await this.get<UserDocType>("users", userId, true);

        // no-op if user not found
        if (!user)
            return;

        const recap = await this.getRecap(userId, type);

        // no-op if recap not found
        if (!recap)
            return;

        if (type == "daily")
            await this.update<UserDocType["meta"]["viewedDailyRecap"]>("users", `${userId}/meta/viewedDailyRecap`, recap.id);
        else
            await this.update<UserDocType["meta"]["viewedWeeklyRecap"]>("users", `${userId}/meta/viewedWeeklyRecap`, recap.id);
    }

    public async ping() {
        try {
            await this.db.command({ ping: 1 });

            return true;
        } catch (ex) {
            console.warn("MongoDB ping failed:", ex);

            return false;
        }
    }

    public isConnected() {
        return this.connected;
    }

    public async shutdown() {
        clearInterval(this.cacheSweeper);

        await this.client.close();
    }
}
