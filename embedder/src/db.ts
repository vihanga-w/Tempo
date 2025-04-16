import { AceBase } from 'acebase';

import { SpotifyUser } from './spotify';
import { UserTaste } from './user-taste';
import { EventEmitter } from 'stream';
import { existsSync, readdirSync, readFileSync, unlinkSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { ncp } from 'ncp';
import { createHash } from 'crypto';
import { Recap } from './recap-scheduler';

// Define types for documents
export type EmbeddingDocType = {
    songId: string;
    embedding: number[];
}
export type UserDocType = SpotifyUser;
export type TasteDocType = UserTaste;

const IS_DEV = false;

export class DataStore extends EventEmitter {
    public embeddingsDb: AceBase;
    public tastesDb: AceBase;
    public usersDb: AceBase;
    public friendsDb: AceBase;

    constructor() {
        super();

        this.embeddingsDb = new AceBase(
            "tempo-embeddings",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
            }
        );

        this.tastesDb = new AceBase(
            "tempo-tastes",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
            }
        );

        this.usersDb = new AceBase(
            "tempo-users",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
            }
        );

        this.friendsDb = new AceBase(
            "tempo-friends",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
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

    async set<T>(collectionId: string, path?: string, value?: T) {
        if (!path)
            return;

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        return await db.ref(dbPath).set(value);
    }

    async update<T>(collectionId: string, path?: string, value?: Partial<T>) {
        if (!path || !value)
            return;

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        return await db.ref(dbPath).update(value);
    }

    async remove<T>(collectionId: string, path: string) {
        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        return await db.ref(dbPath).remove();
    }

    async exists(collectionId: string, path?: string) {
        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path ?? []].join("/");

        const data = await db.ref(dbPath).get();

        return data.exists();
    }

    async get<T>(collectionId: string, path?: string, notNull?: boolean) {
        if (!path)
            return null;

        const db = this._getDb(collectionId);
        const dbPath = [collectionId, path].join("/");

        const data = await db.ref(dbPath).get();

        if (!data.exists() && !notNull)
            return null;
        else if (!data.exists())
            throw new Error("Attempted to access database with notNull parameter but the target element was a nullish value");

        const val = data.val<T>();

        return val;
    }

    async markRecapSeen(userId: string, type: "daily" | "weekly") {
        const user = await this.get<UserDocType>("users", userId);

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

    async getRecap(userId: string, type: "daily" | "weekly", ignoreViewedState?: boolean): Promise<null | Recap> {
        const recapPath = `./recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;

        if (!existsSync(recapPath))
            return null;
        
        const user = await this.get<UserDocType>("users", userId);

        if (!user || (type == "daily" && !user?.meta.dayRecapAvailableDate) || (type == "weekly" && !user?.meta.weekRecapAvailableDate))
            return null;

        const date = (type == "daily" ? user.meta.dayRecapAvailableDate : user.meta.weekRecapAvailableDate);

        if (date == -1)
            return null;

        const hourOffset = (23 - new Date(date).getHours());
        const minOffset = (59 - new Date(date).getMinutes());
        const secOffset = (59 - new Date(date).getSeconds());
        const msOffset = (1e3 - new Date(date).getMilliseconds());

        const totalDayTimeRemaining = ((hourOffset * 3600e3) + (minOffset * 60e3) + (secOffset * 1e3) + msOffset) + (3600e3 * 24 * 6 * (type == "daily" ? 0 : 1));
        const periodExpiryDate = date + totalDayTimeRemaining;

        if (Date.now() > periodExpiryDate)
            return null;

        const recapData: Recap = JSON.parse(readFileSync(recapPath).toString());

        // Dont return recaps that have already been viewed
        if (!ignoreViewedState && type == "daily" && user.meta.viewedDailyRecap == recapData.id)
            return null;

        if (!ignoreViewedState && type == "weekly" && user.meta.viewedWeeklyRecap == recapData.id)
            return null;

        return recapData;
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

    private _importOldFilesystemDB() {
        if (existsSync("./auth/") && readdirSync("./auth/").length > 0) {
            const files = readdirSync("./auth/").filter(v => v.endsWith("_auth.json"));

            console.log("Found", files.length, "file system db user profiles, importing them into AceBase");

            const importedCount = this._importFiles<UserDocType>(
                this.usersDb,
                "./auth/",
                "users",
                files,
                (d) => {
                    return d.meta.serviceId;
                },
                (ex) => {
                    console.error("Failed to import user profile, error:", ex);
                },
            );

            console.log("Imported", importedCount, "file system db user profiles");
        }

        if (existsSync("./user-tastes/") && readdirSync("./user-tastes/").length > 0) {
            const files = readdirSync("./user-tastes/").filter(v => v.endsWith(".json"));

            console.log("Found", files.length, "file system db user tastes, importing them into AceBase");

            const importedCount = this._importFiles<TasteDocType>(
                this.tastesDb,
                "./user-tastes/",
                "tastes",
                files,
                (_, f) => {
                    return f?.split(".json")[0];
                },
                (ex) => {
                    console.error("Failed to import user taste, error:", ex);
                },
            );

            console.log("Imported", importedCount, "file system db user tastes");
        }
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