import { AceBase } from 'acebase';

import { SpotifyUser } from './spotify';
import { UserTaste } from './user-taste';
import { EventEmitter } from 'stream';
import { existsSync, readdirSync, readFileSync, unlinkSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { ncp } from 'ncp';
import { createHash, createPrivateKey, createSign, generateKeyPairSync, KeyObject, randomBytes, sign } from 'crypto';
import { Recap } from './recap-scheduler';
import { join } from 'path';
import { Mutex } from 'async-mutex';

// Define types for documents
export type EmbeddingDocType = {
    songId: string;
    embedding: number[];
}
export type UserDocType = SpotifyUser;
export type TasteDocType = UserTaste;

export interface DDBQuery {
    type: "get" | "set" | "update" | "query" | "ping" | "exists" | "remove" | "all";
    collection: string;
    path: string;
    value: any;
    notNull?: boolean;
    signature: string;
    timestamp: number;
    isObject?: boolean;
};

const IS_DEV = false;
// const DISTRIBUTED_DB_ADDRESS = "http://localhost:2275";
const DISTRIBUTED_DB_ADDRESS = "https://ad85c673-5b98-4a40-95a5-027053f4f5aa-db.tempo-music.co";
const MAX_CACHE_DURATION = 1e3;
const MAX_CACHE_SIZE = 1000;

export class DataStore extends EventEmitter {
    private secret: KeyObject;
    public publicKey: string;
    private readResponseCache: {[key: string]: {
        timestamp: number;
        data: any;
        lastAccessed: number;
        mutex: Mutex;
    }} = {};

    constructor() {
        super();

        if (!this._doesKeypairExist())
            this._generateKeypair();

        this.publicKey = readFileSync(join("keys", ".db.public.key.pem")).toString("utf8");

        this.secret = createPrivateKey({
            key: readFileSync(join("keys", ".db.private.key")).toString("utf8"),
            type: 'pkcs8',
            format: 'pem',
            passphrase: readFileSync(join("keys", ".db.p")).toString("utf8"),
        });

        setInterval(() => {
            const d = Date.now();

            const keys = Object.keys(this.readResponseCache);

            keys.forEach(v => {
                if (d - this.readResponseCache[v].timestamp > MAX_CACHE_DURATION)
                    delete this.readResponseCache[v];
            });
        }, 2500);

        this.ping()
        .then((success) => {
            if (success)
                this.emit("ready");
            else
                console.warn("Database ping unsuccessful!");
        });
    }

    private _doesKeypairExist() {
        const pubExists = existsSync("./keys/.db.public.key.pem");
        const secExists = existsSync("./keys/.db.private.key");
        const phrExists = existsSync("./keys/.db.p");

        return (phrExists && secExists && pubExists);
    }

    private _generateKeypair() {
        if (!existsSync("./keys"))
            mkdirSync("./keys/");

        const passphrase = randomBytes(16).toString("hex");

        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
                cipher: 'aes-256-cbc',
                passphrase
            }
        });

        writeFileSync(join('keys', '.db.private.key'), privateKey);
        writeFileSync(join('keys', '.db.public.key.pem'), publicKey);
        writeFileSync(join('keys', '.db.p'), passphrase);

        console.log("Generated a new JWT signing keypair");
    }

    private async _query<T>(q: Partial<DDBQuery>) {
        if (typeof q.value == "object" || ({} as T) instanceof Object)
            q.isObject = true;
        
        let data: DDBQuery = {
            type: q.type ?? "get",
            collection: q.collection ?? "",
            path: q.path ?? "",
            value: q.value ?? "",
            timestamp: Date.now(),
            signature: "",
        }
        
        const hashBuffer = createHash("sha512").update(
            data.type.toLowerCase() + data.collection + data.path + data.value + (data.notNull ? "nn" : "nnf") + (data.isObject ? "io" : "no") + data.timestamp
        ).digest();
        
        data.signature = sign(null, hashBuffer, this.secret).toString("hex");

        try {
            const req = await fetch(DISTRIBUTED_DB_ADDRESS + "/query", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(data),
            });
            const res = await req.text();

            if (req.status == 400)
                throw new Error("Invalid DDB response (400): " + res);

            if (req.status == 403)
                throw new Error("Invalid DDB response (403): " + res);

            if (req.status == 500)
                throw new Error("Invalid DDB response (500): " + res);

            if (data.type == "get")
                return (JSON.parse(res) as { data: T | null }).data;

            if ((data.type == "set" || data.type == "update") && res == "OK")
                return true;
            else if (data.type == "set" || data.type == "update")
                return false;

            if (data.type == "remove" && res == "OK")
                return true;
            else if (data.type == "remove")
                return false;

            if (data.type == "ping" && res == "pong")
                return true;

            if (data.type == "exists")
                return (JSON.parse(res) as { exists: boolean }).exists;

            if (data.type == "all")
                return (JSON.parse(res) as { data: T[] }).data;
        } catch (ex) {
            console.error("Failed to run database query:", q, "error:", ex);

            throw new Error("Database query failed, check terminal for errors");
        }
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

    private async _setCachedObjectGet(collectionId: string, value: any, path?: string, skipIfNonExist?: boolean) {
        if (!this.readResponseCache[collectionId + ":" + (path ?? "") + "get"] && skipIfNonExist)
            return;

        const mutex = (this.readResponseCache[collectionId + ":" + (path ?? "") + "get"]?.mutex ?? new Mutex());

        await mutex.acquire();

        if (Object.keys(this.readResponseCache).length >= MAX_CACHE_SIZE) {
            const keys = Object.keys(this.readResponseCache);

            const oldestKey = keys.reduce((oldest, key) => {
                return this.readResponseCache[key].lastAccessed < this.readResponseCache[oldest].lastAccessed ? key : oldest;
            }, keys[0]);

            delete this.readResponseCache[oldestKey];
        }

        if (value == undefined) {
            delete this.readResponseCache[collectionId + ":" + (path ?? "") + "get"];
            mutex.release();
            return;
        }

        this.readResponseCache[collectionId + ":" + (path ?? "") + "get"] = {
            timestamp: Date.now(),
            data: value,
            lastAccessed: Date.now(),
            mutex,
        };

        mutex.release();
    }

    private async _setCachedObjectExists(collectionId: string, value: boolean, path?: string, skipIfNonExist?: boolean) {
        if (!this.readResponseCache[collectionId + ":" + (path ?? "") + "exists"] && skipIfNonExist)
            return;

        const mutex = (this.readResponseCache[collectionId + ":" + (path ?? "") + "exists"]?.mutex ?? new Mutex());

        await mutex.acquire();

        if (Object.keys(this.readResponseCache).length >= MAX_CACHE_SIZE) {
            const keys = Object.keys(this.readResponseCache);

            const oldestKey = keys.reduce((oldest, key) => {
                return this.readResponseCache[key].lastAccessed < this.readResponseCache[oldest].lastAccessed ? key : oldest;
            }, keys[0]);

            delete this.readResponseCache[oldestKey];
        }

        this.readResponseCache[collectionId + ":" + (path ?? "") + "exists"] = {
            timestamp: Date.now(),
            data: value,
            lastAccessed: Date.now(),
            mutex,
        };

        mutex.release();
    }

    async exists(collectionId: string, path?: string, dontFail?: boolean) {
        const cDat = await this._getCachedObjectExists(collectionId, path);

        try {
            const exists = cDat ?? ((await this._query({
                type: "exists",
                collection: collectionId,
                path,
            })) as boolean);

            if (!cDat)
                await this._setCachedObjectExists(collectionId, exists, path);

            return exists;
        } catch (ex) {
            if (dontFail)
                return false;

            throw ex;
        }
    }

    async get<T>(collectionId: string, path?: string, notNull?: boolean, dontFail?: boolean) {
        const cDat = await this._getCachedObjectGet<T>(collectionId, path);

        try {
            const res = cDat ?? ((await this._query<T>({
                type: "get",
                collection: collectionId,
                path,
                notNull,
            })) as T | null);

            if (!cDat)
                await this._setCachedObjectGet(collectionId, res, path);

            return res;
        } catch (ex) {
            if (dontFail)
                return null;

            throw ex;
        }
    }

    async set<T>(collectionId: string, path?: string, value?: T) {
        const res = (await this._query<T>({
            type: "set",
            collection: collectionId,
            path,
            value,
        })) as boolean;

        // Remove from cache as we cannot guarantee the data is still valid
        if (res) {
            await this._setCachedObjectGet(collectionId, value, path, true);
            await this._setCachedObjectExists(collectionId, true, path, true);
        }

        return res;
    }

    async update<T>(collectionId: string, path?: string, value?: Partial<T>) {
        const res = (await this._query<T>({
            type: "update",
            collection: collectionId,
            path,
            value,
        })) as boolean;

        if (res) {
            await this._setCachedObjectGet(collectionId, undefined, path, true);
            await this._setCachedObjectExists(collectionId, false, path, true);
        }

        return res;
    }

    async remove<T>(collectionId: string, path: string) {
        const res = (await this._query<T>({
            type: "remove",
            collection: collectionId,
            path,
        })) as boolean;

        if (res) {
            await this._setCachedObjectGet(collectionId, undefined, path, true);
            await this._setCachedObjectExists(collectionId, false, path, true);
        }

        return res;
    }

    async all<T>(collectionId: string) {
        const res = (await this._query<T>({
            type: "all",
            collection: collectionId,
        })) as T[];

        return res;
    }

    async getRecap(userId: string, type: "daily" | "weekly", ignoreViewedState?: boolean): Promise<null | Recap> {
        const recapPath = `/tempodb/recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;

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
        const res = (await this._query({
            type: "ping"
        })) as boolean;

        return res;
    }
}