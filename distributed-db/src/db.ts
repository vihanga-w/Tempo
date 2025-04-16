import { AceBase, DataSnapshot } from 'acebase';

import { existsSync, readdirSync, readFileSync, unlinkSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { ncp } from 'ncp';
import { createHash } from 'crypto';
import EventEmitter from 'events';

const IS_DEV = false;

export class DataStore extends EventEmitter {
    public embeddingsDb: AceBase;
    public tastesDb: AceBase;
    public usersDb: AceBase;
    public friendsDb: AceBase;
    private readCache: {[key: string]: {
        timestamp: number;
        data: DataSnapshot<any>;
    }} = {};

    constructor() {
        super();

        this.embeddingsDb = new AceBase(
            "tempo-embeddings",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
                storage: {
                    path: "/tempodb"
                }
            }
        );

        this.tastesDb = new AceBase(
            "tempo-tastes",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
                storage: {
                    path: "/tempodb"
                }
            }
        );

        this.usersDb = new AceBase(
            "tempo-users",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
                storage: {
                    path: "/tempodb"
                }
            }
        );

        this.friendsDb = new AceBase(
            "tempo-friends",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
                storage: {
                    path: "/tempodb"
                }
            }
        )

        let readyCount = 0;
        const onReady = async () => {
            readyCount++;
            if (readyCount === 4) {
                console.log("All AceBase databases are ready!");

                // await this._migrateOldData();
                // await this._migrateTastesDb();

                this.emit("ready");
            }
        };

        this.embeddingsDb.on("ready", onReady);
        this.tastesDb.on("ready", onReady);
        this.usersDb.on("ready", onReady);
        this.friendsDb.on("ready", async () => {
            await this.friendsDb.indexes.create("*", "u1Id");
            await this.friendsDb.indexes.create("*", "u2Id");
            
            onReady();
        });
    }

    private async _safeCloseDb(id: string) {
        const db = this._getDb(id);

        try {
            await db.close();
        } catch (ex) {
            console.error("Failed to exit database \"" + id + "\", error:", ex);
        }
    }

    public async shutdown() {
        console.log("Attempting to shutdown active AceBase instances...");

        await this._safeCloseDb("embeddings");
        await this._safeCloseDb("tastes");
        await this._safeCloseDb("users");
        await this._safeCloseDb("friends");

        console.log("AceBase instances have been shutdown");
    }

    private _getDb(collectionId: string): AceBase {
        const baseCollectionId = collectionId.split('/')[0];
        switch (baseCollectionId) {
            case "embeddings":
                return this.embeddingsDb;
            case "tastes":
                return this.tastesDb;
            case "users":
                return this.usersDb;
            case "friends":
                return this.friendsDb;
            default:
                throw new Error(`Unknown collectionId: ${collectionId}`);
        }
    }

    private _getCached(collection: string, path: string) {
        if (!this.readCache[collection + ":" + path])
            return null;

        // 750ms short-lived cache
        if (Date.now() - this.readCache[collection + ":" + path].timestamp <= 750)
            return this.readCache[collection + ":" + path].data;

        return null;
    }

    async set<T>(collectionId: string, path?: string, value?: T) {
        if (!path)
            return;

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        console.log("[SET]", collectionId, `(${path})`);

        return await db.ref(dbPath).set(value);
    }

    async update<T>(collectionId: string, path?: string, value?: Partial<T>) {
        if (!path || !value)
            return;

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        console.log("[UPDATE]", collectionId, `(${path})`);

        return await db.ref(dbPath).update(value);
    }

    async remove<T>(collectionId: string, path: string) {
        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        console.log("[REMOVE]", collectionId, `(${path})`);

        return await db.ref(dbPath).remove();
    }

    async exists(collectionId: string, path?: string) {
        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path ?? []].join("/");

        const cDat = this._getCached(collectionId, path ?? "");
        const data = (cDat ?? (await db.ref(dbPath).get()));

        console.log("[EXISTS]", collectionId, `(${path})`);

        return data.exists();
    }

    async get<T>(collectionId: string, path?: string, notNull?: boolean) {
        if (!path)
            return null;

        console.log("[GET]", collectionId, `(${path})`);

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        const cDat = this._getCached(collectionId, path ?? "");
        const data = (cDat ?? (await db.ref(dbPath).get()));

        if (!data.exists() && !notNull)
            return null;
        else if (!data.exists())
            throw new Error("Attempted to access database with notNull parameter but the target element was a nullish value");

        const val = data.val<T>();

        if (!val)
            return null;

        // if (typeof val == "object")
        //     return JSON.stringify(val);

        return val;
    }

    ref(collectionId: string, path?: string) {
        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path ?? []].join("/");

        return db.ref(dbPath);
    }

    query(collectionId: string) {
        const db = this._getDb(collectionId);
        return db.query(collectionId);
    }

    private _importFiles<T>(db: AceBase, path: string, collectionId: string, files: string[], getKey: (data: T, file?: string) => string | undefined, errCb?: (ex: any) => void) {
        let count = 0;

        files.forEach(async v => {
            try {
                const fp = path + (!path.endsWith("/") ? "/" : "") + v;
                const data = JSON.parse(readFileSync(fp).toString()) as T;
                const key = getKey(data, v);

                if (!key)
                    throw new Error("No key was provided for KV pair");

                await this.set<T>(collectionId, key, data);

                unlinkSync(fp);

                count++;
            } catch (ex) {
                if (errCb)
                    errCb(ex);
            }
        });

        return count;
    }

    private async _migrateOldData() {
        if (!existsSync("./tempo-main.acebase")) {
            return;
        }

        console.log("Found old database, attempting data migration");

        const oldDb = new AceBase("tempo-main", { logLevel: IS_DEV ? "verbose" : "warn" });

        await oldDb.ready();

        const migrateCollection = async (oldDb: AceBase, collectionId: string) => {
            const ref = oldDb.ref(collectionId);
            const snapshot = await ref.get();
            if (snapshot.exists()) {
                const data = snapshot.val();
                for (const key in data) {
                    await this.set(collectionId, key, data[key]);
                }
            }
        };

        await migrateCollection(oldDb, "embeddings");
        await migrateCollection(oldDb, "tastes");
        await migrateCollection(oldDb, "users");

        console.log("Data migration completed.");
    }

    private async _migrateTastesDb() {
        const tastesDbDirPath = "./tempo-tastes.acebase";
        const tastesBackupDirPath = "./backup/tempo-tastes-backup.acebase";
        const tastesDataFolderPath = "./data/tastes/";

        if (existsSync(tastesDbDirPath)) {
            console.log("Found tastes database directory, attempting migration.");

            // Ensure the data/tastes folder exists
            if (!existsSync(tastesDataFolderPath)) {
                mkdirSync(tastesDataFolderPath, { recursive: true });
            }

            // Backup the tastes database directory
            if (!existsSync("./backup")) {
                mkdirSync("./backup");
            }
            ncp(tastesDbDirPath, tastesBackupDirPath, (err) => {
                if (err) {
                    return console.error(err);
                }
                console.log('Backup completed.');
            });

            const oldTastesDb = new AceBase("tempo-tastes", { logLevel: IS_DEV ? "verbose" : "warn" });

            await oldTastesDb.ready();

            const ref = oldTastesDb.ref("tastes");
            const snapshot = await ref.get();

            if (snapshot.exists()) {
                const data = snapshot.val();

                for (const key in data) {
                    const filePath = `${tastesDataFolderPath}${key}.json`;
                    
                    // Dont overwrite data we already have!
                    if (!existsSync(filePath))
                        writeFileSync(filePath, JSON.stringify(data[key]));
                }
            }

            console.log("Tastes data migration completed.");

            // Ensure the directory is empty before removing it
            const files = readdirSync(tastesDbDirPath);
            for (const file of files) {
                rmSync(`${tastesDbDirPath}/${file}`, { recursive: true, force: true });
            }

            // Remove the old tastes database directory
            try {
                rmSync(tastesDbDirPath, { recursive: true, force: true });
            } catch (error) {
                console.warn(`Failed to remove old tastes database directory:`, error);
            }
        }
    }
}