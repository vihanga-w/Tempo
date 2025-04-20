import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFile, writeFileSync } from "fs";
import { DataStore, UserDocType } from "./db";
import { NotificationHandler } from "./notification-handler";
import { SongData, SongDataCache } from "./song-data-cache";
import { loadUserTasteFromFile, Taste, UserTaste } from "./user-taste";
import { createHash, randomBytes } from "crypto";

interface RecapSortItem {
    id: string;
    title: string;
    artists: string[];
    index: number;
    explicit: boolean;
    playCount: number;
    listenDuration: number;
    imageUrl: string;
};

export interface Recap {
    id: string;
    userId: string;
    playCountSort: RecapSortItem[];
    listenDurationSort: RecapSortItem[];
    timestamp: number;
};

export class UserListenershipRecapScheduler {
    private lastProcessedTime = "";
    private db: DataStore;
    private songMetaCache: SongDataCache;
    private notify: NotificationHandler;
    private dayAvailableIds: string[];
    private weekAvailableIds: string[];

    constructor(db: DataStore, songMetaCache: SongDataCache, notify: NotificationHandler) {
        this.db = db;
        this.songMetaCache = songMetaCache;
        this.notify = notify;
        this.dayAvailableIds = [];
        this.weekAvailableIds = [];

        db.all<UserDocType>("users")
        .then(async users => {
            for (const user of users) {
                const id = user.me?.id ?? user.meta?.serviceId;
                if (!id) continue;
        
                const daily = this.getRecap(id, "daily");
                const weekly = this.getRecap(id, "weekly");
        
                if (daily) {
                    const isValid = Date.now() <= (daily.timestamp + 24 * 60 * 60 * 1000);
                    if (isValid) {
                        await this.db.update<UserDocType["meta"]["dayRecapAvailableDate"]>(
                            "users", id + "/meta/dayRecapAvailableDate", daily.timestamp
                        );
                        this.dayAvailableIds.push(id);
                        console.log("Backfilled available daily recap", daily.id, "for user", id);
                    }
                }
        
                if (weekly) {
                    const isValid = Date.now() <= (weekly.timestamp + 7 * 24 * 60 * 60 * 1000);
                    const alreadySet = !!user.meta?.weekRecapAvailableDate;
                    const isTodayMonday = new Date().getDay() === 1;
        
                    if (isValid && (isTodayMonday || !alreadySet)) {
                        await this.db.update<UserDocType["meta"]["weekRecapAvailableDate"]>(
                            "users", id + "/meta/weekRecapAvailableDate", weekly.timestamp
                        );
                        this.weekAvailableIds.push(id);
                        console.log("Backfilled available weekly recap", weekly.id, "for user", id);
                    }
                }
            }
        });

        this._orchestrate();

        const loop = setInterval(() => {
            this._orchestrate();
        }, 5e3);
    }

    getRecap(userId: string, type: "daily" | "weekly") {
        const path = `/tempodb/recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;

        if (!existsSync(path))
            return undefined;

        try {
            const data = JSON.parse(readFileSync(path).toString()) as Recap;

            return data;
        } catch (ex) {
            console.error("Failed to load", type, "recap for user", userId, "error:", ex);

            return undefined;
        }
    }

    private _saveRecap(type: "daily" | "weekly", userId: string, recap: Recap) {
        if (!existsSync("/tempodb/recaps/"))
            mkdirSync("/tempodb/recaps/");

        const path = `/tempodb/recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;

        try {
            writeFileSync(path, JSON.stringify(recap));

            return (this.getRecap(userId, type) !== undefined);
        } catch (ex) {
            console.error("Failed to save", type, "recap for user", userId, "to disk, error:", ex, "recap:", recap);

            return false;
        }
    }

    private _deleteRecapFile(userId: string, type: "daily" | "weekly") {
        const path = `/tempodb/recaps/${createHash("sha256").update(userId + "-" + type).digest("hex")}.json`;
    
        if (existsSync(path)) {
            try {
                unlinkSync(path);
                console.log(`Deleted ${type} recap file for user ${userId}`);
            } catch (err) {
                console.error(`Failed to delete ${type} recap for user ${userId}:`, err);
            }
        }
    }    

    private async _orchestrate() {
        const time = this._getTimeNorm();

        // This time period has already been processed
        if (!time)
            return;

        // TODO: Account for a user's region (through last connected IP or fallback to Spotify account region)
        if (time[0] == 9 && time[1] == 0) {
            // Empty array and start iterating over available recaps
            const dailyAvailable = this.dayAvailableIds.splice(0, this.dayAvailableIds.length);
            const weeklyAvailable = this.weekAvailableIds.splice(0, this.weekAvailableIds.length);

            // We are assuming that the user has a daily available recap if they have a weekly available
            const inBoth = dailyAvailable.filter(id => weeklyAvailable.includes(id));

            inBoth.forEach(async userId => {
                await this.db.update<UserDocType["meta"]["dayRecapAvailableDate"]>(
                    "users", userId + "/meta/dayRecapAvailableDate", Date.now()
                );
            
                this.notify.notifyUser(userId, {
                    title: "Daily and weekly recaps ready",
                    message: "Both your daily and weekly recaps are now available. Check them out!"
                }).then(() => {
                    console.log("Sent combined recap notification for user", userId);
                }).catch(ex => {
                    console.error("Failed to notify user", userId, "about combined recaps, error:", ex);
                });
            });

            // We dont want to send another notification if we already just sent one
            dailyAvailable.filter(id => !inBoth.includes(id)).forEach(async userId => {
                await this.db.update<UserDocType["meta"]["dayRecapAvailableDate"]>("users", userId + "/meta/dayRecapAvailableDate", Date.now());

                if (!inBoth.includes(userId)) {
                    this.notify.notifyUser(userId, {
                        title: "Daily recap ready",
                        message: "Your daily recap is now available. Take a look! 👀"
                    })
                    .then(() => {
                        console.log("Sent daily recap notification for user", userId);
                    })
                    .catch(ex => {
                        console.error("Failed to notify user", userId, "about daily recap, error:", ex);
                    });
                }
            });
        }

        // Conditions must be met for loop to continue
        if (time[0] !== 0 || time[1] !== 1)
            return;

        // Begin compiling everyone's recap for yesterday, ready to show in the morning
        if (!(await this.db.exists("users"))) {
            console.error("Unable to orchestrate recap processing as the users database was not found!");

            return;
        }
        
        const users = await this.db.all<UserDocType>("users");
    
        users.forEach(async data => {
            try {
                const currentTime = new Date();

                const currentTimeDayStart = currentTime.getTime() - (currentTime.getHours() * 3600e3) - (currentTime.getMinutes() * 60e3) - (currentTime.getSeconds() * 1e3) - currentTime.getMilliseconds()

                const dayPeriodStart = (currentTimeDayStart - (1e3 * 3600 * 24));
                const weekPeriodStart = (currentTimeDayStart - (1e3 * 3600 * 24 * 7));

                const userTasteDay = loadUserTasteFromFile(data.meta.serviceId, {
                    start: dayPeriodStart,
                    end: currentTimeDayStart,
                });
                const userTasteWeek = loadUserTasteFromFile(data.meta.serviceId, {
                    start: weekPeriodStart,
                    end: currentTimeDayStart,
                });

                const processDataGivenTaste = (taste: UserTaste) => {
                    // Not enough data to process for this user
                    if (taste.history.length < 5)
                        return null;

                    const processed = taste.history.map(v => {
                        const item = this.songMetaCache.getItem(v.songId);
                        
                        return {
                            ...v,
                            songData: item
                        };
                    });

                    const filteredSessions = processed.filter(v => {
                        if (v.sessionDuration < 0.5)
                            return false;
                
                        if (!v.songData)
                            return false;
                
                        if (v.songData.type !== "track")
                            return false;
                
                        return true;
                    });

                    let playCountTotals: {[key: string]: {
                        c: number;
                        d: number;
                        i: SongData;
                    }} = {};
                
                    // Aggregate the sessions
                    filteredSessions.forEach((v) => {
                        if (v.skipped)
                            return;
                
                        if (!v.songData)
                            return;
                
                        if (!playCountTotals[v.songId]) {
                            playCountTotals[v.songId] = {
                                c: 1,
                                d: v.sessionDuration * v.songData.duration,
                                i: v.songData,
                            };
                        } else {
                            playCountTotals[v.songId].c += 1;
                            playCountTotals[v.songId].d += (v.sessionDuration * v.songData.duration);
                        }
                    });

                    // Sort by playcount
                    const playCountSort = Object.entries(playCountTotals)
                    .sort(([, countA], [, countB]) => countB.c - countA.c);

                    // Sort by listen duration
                    const seshDurationSort = Object.entries(playCountTotals)
                    .sort(([, countA], [, countB]) => countB.d - countA.d);

                    // TODO: Aggregate top artists

                    const getProcessedItem = (index: number, count: {
                        c: number;
                        d: number;
                        i: SongData;
                    }) => {
                        return {
                            id: count.i.id,
                            title: count.i.name,
                            artists: count.i.artists.map(v => v.name),
                            index: index,
                            explicit: count.i.explicit,
                            playCount: count.c,
                            listenDuration: count.d,
                            imageUrl: count.i.album.artUrl,
                        };
                    }

                    const periodRecap: Recap = {
                        id: createHash("sha256").update(randomBytes(6).toString("hex")).digest("hex"),
                        userId: (data.me?.id ?? data.meta?.serviceId),
                        playCountSort: playCountSort.map(([, count], i) => {
                            return getProcessedItem(i, count);
                        }).slice(0, 10),    // Limit to 10 items max
                        listenDurationSort: seshDurationSort.map(([, count], i) => {
                            return getProcessedItem(i, count);
                        }).slice(0, 10),    // Limit to 10 items max
                        timestamp: Date.now(),
                    };

                    return periodRecap;
                }

                const dayRecap = processDataGivenTaste(userTasteDay);

                if (dayRecap && this._saveRecap("daily", data.meta.serviceId, dayRecap)) {
                    // Mark this user as having their daily recap ready
                    this.dayAvailableIds.push(data.meta.serviceId);

                    console.log("Marked user", data.meta.serviceId, "available for daily recap");
                } else {
                    this._deleteRecapFile(data.meta.serviceId, "daily");
                }

                // Only process weekly recaps on monday
                if (new Date().getDay() === 1) {
                    const weekRecap = processDataGivenTaste(userTasteWeek);

                    if (weekRecap && this._saveRecap("weekly", data.meta.serviceId, weekRecap)) {
                        // Mark this user as having their weekly recap ready
                        await this.db.update<UserDocType["meta"]["weekRecapAvailableDate"]>("users", data.meta.serviceId + "/meta/weekRecapAvailableDate", Date.now());
                        this.weekAvailableIds.push(data.meta.serviceId);

                        console.log("Marked user", data.meta.serviceId, "available for weekly recap");
                    } else {
                        this._deleteRecapFile(data.meta.serviceId, "weekly");
                    }
                }
            } catch (ex) {
                console.error("Failed to process recap for", data.meta?.serviceId ?? data.me?.id, "error:", ex);
            }
        });
    }

    private _getTimeNorm() {
        const time = new Date();
        const tArr = [time.getHours(), time.getMinutes()];

        if (tArr.join("") == this.lastProcessedTime)
            return null;

        this.lastProcessedTime = tArr.join("");
        
        return [time.getHours(), time.getMinutes()];
    }
}