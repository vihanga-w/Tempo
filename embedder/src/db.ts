import { AceBase } from 'acebase';

import { SpotifyUser } from './spotify';
import { UserTaste } from './user-taste';
import { EventEmitter } from 'stream';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';

// Define types for documents
export type EmbeddingDocType = {
    songId: string;
    embedding: number[];
}
export type UserDocType = SpotifyUser;
export type TasteDocType = UserTaste;

const IS_DEV = false;

export class DataStore extends EventEmitter {
    public db: AceBase;

    constructor() {
        super()

        this.db = new AceBase(
            "tempo-main",
            {
                logLevel: IS_DEV ? "verbose" : "warn",
            }
        );

        this.db.on("ready", async () => {
            console.log("AceBase is ready!");

            this._importOldFilesystemDB();
            
            if (await this.db.ref("embeddings").exists()) {
                const e = await this.db.ref("embeddings").get()

                console.log(e.val())
            }

            this.emit("ready");
        });
    }

    async set<T>(collectionId: string, path?: string, value?: T) {
        if (!path)
            return;

        const dbPath = [collectionId, path].join("/");

        return await this.db.ref(dbPath).set(value);
    }

    async get<T>(collectionId: string, path?: string, notNull?: boolean) {
        if (!path)
            return null;

        const dbPath = [collectionId, path].join("/");

        const data = await this.db.ref(dbPath).get();

        if (!data.exists() && !notNull)
            return null;
        else if (!data.exists())
            throw new Error("Attempted to access database with notNull paramter but the target element was a nullish value");

        const val = data.val<T>();

        return val;
    }

    ref(collectionId: string, path?: string) {
        const dbPath = [collectionId, path ?? []].join("/");

        return this.db.ref(dbPath);
    }

    async exists(collectionId: string, path?: string) {
        const dbPath = [collectionId, path ?? []].join("/");

        const data = await this.db.ref(dbPath).get();

        return data.exists();
    }

    private _importFiles<T>(path: string, collectionId: string, files: string[], getKey: (data: T, file?: string) => string | undefined, errCb?: (ex: any) => void) {
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
}