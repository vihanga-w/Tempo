/**
 * Compares the two figures Tempo reports for a week of listening.
 *
 * The leaderboard and the profile's past week stat are computed by different
 * code over what should be the same history, and they disagree. This runs both
 * against one stored profile and shows where the difference comes from, so the
 * cause is read rather than guessed at.
 *
 *     node build/compare-week-totals.js <spotifyUserId>
 *
 * Read-only.
 */

import { DataStore, UserDocType } from "./db";
import { MongoTasteStore } from "./taste-store";
import { SongDataCache } from "./song-data-cache";
import { listeningTimeMs } from "./leaderboard";

function minutes(ms: number): string {
    return `${Math.round(ms / 60e3)}m (${(ms / 3600e3).toFixed(2)}h)`;
}

async function main() {
    const userId = process.argv[2];

    if (!userId) {
        console.error("Usage: node build/compare-week-totals.js <spotifyUserId>");
        process.exit(1);
    }

    const db = new DataStore();

    await new Promise<void>(resolve => db.once("ready", resolve));

    const store = new MongoTasteStore(db);
    const songs = new SongDataCache();

    const taste = await store.get(userId);
    const account = await db.get<UserDocType>("users", userId);

    if (!taste) {
        console.error("No stored taste profile for", userId);
        await db.shutdown();
        process.exit(1);
    }

    console.log("\nAccount:", account?.me?.displayName ?? userId);
    console.log("History entries stored:", taste.history.length);

    const now = Date.now();
    const start = now - (3600e3 * 24 * 7);

    // What the leaderboard counts
    const board = listeningTimeMs(
        taste.history,
        songId => songs.getItem(songId)?.duration,
        { start, end: now },
    );

    // What /profile/:userId/pastWeekStats counts, reproduced exactly
    let profileMs = 0;
    const profileSongs = new Set<string>();

    let inWindow = 0;
    let skippedCount = 0;
    let missingMeta = 0;
    let overOne = 0;
    let future = 0;

    for (const item of taste.history) {
        if (item.timestamp < start)
            continue;

        inWindow++;

        if (item.timestamp > now)
            future++;

        const meta = songs.getItem(item.songId);

        if (!meta) {
            missingMeta++;

            continue;
        }

        if (item.skipped) {
            skippedCount++;

            continue;
        }

        if (item.sessionDuration > 1)
            overOne++;

        profileMs += item.sessionDuration * meta.duration;
        profileSongs.add(item.songId);
    }

    console.log("\nIn the past seven days");
    console.log("  entries in window     :", inWindow);
    console.log("  skipped (both ignore) :", skippedCount);
    console.log("  no cached song data   :", missingMeta);
    console.log("  sessionDuration > 1   :", overOne);
    console.log("  timestamped in future :", future);

    const newest = taste.history.reduce((max, v) => Math.max(max, v.timestamp ?? 0), 0);

    console.log("\nStored profile freshness");
    console.log("  newest entry :", newest > 0 ? new Date(newest).toISOString() : "(none)");
    console.log("  written      :", newest > 0 ? Math.round((now - newest) / 60e3) + "m ago" : "-");

    console.log("\nTotals");
    console.log("  leaderboard :", minutes(board.listeningMs), `over ${board.uniqueSongs} song(s)`);
    console.log("  profile     :", minutes(profileMs), `over ${profileSongs.size} song(s)`);
    console.log("  difference  :", minutes(Math.abs(profileMs - board.listeningMs)));

    if (Math.abs(profileMs - board.listeningMs) < 1000) {
        console.log(`
Both agree on this stored profile, so the formulas are not the difference.

The profile endpoint reads history from the live session in memory, while the
leaderboard reads it from the database. If the two disagree in the app but agree
here, what differs is which copy each one saw — check how recently this account's
profile was last written.
`);
    } else {
        console.log(`
They disagree on the same data, so the difference is in the counting. The
figures above say which of the two rules did it: entries with no cached song
data are dropped by both, but a sessionDuration over 1 is clamped by the
leaderboard and not by the profile, and the leaderboard also ignores anything
timestamped in the future.
`);
    }

    await db.shutdown();
}

main().catch(async ex => {
    console.error("Comparison failed:", ex);
    process.exit(1);
});
