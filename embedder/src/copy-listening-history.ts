/**
 * Copies one account's listening profile onto another.
 *
 * Written for App Review. Apple's reviewers are handed an account that has
 * never played anything, so the parts of Tempo that are built out of a listening
 * history — the leaderboard, recaps, and now the Passport — are empty for them,
 * and a reviewer cannot test what they cannot see. Giving the review account a
 * real history is the difference between them assessing the feature and
 * assessing a blank page.
 *
 *     docker compose exec app node ./build/copy-listening-history.js <from> <to>
 *     docker compose exec app node ./build/copy-listening-history.js <from> <to> --apply
 *
 * Read-only without --apply: it names both accounts and reports what would be
 * written, and touches nothing. Run it that way first, because a display name
 * is not unique and copying onto the wrong account destroys somebody's history.
 *
 * Only the taste profile moves. Credentials, the Spotify identity, friendships,
 * settings and streaks are all left alone — the review account stays its own
 * account, with somebody else's listening behind it.
 *
 * The target's existing profile is written to DATA_DIR/backups first, always,
 * even when it is empty. Restoring is the same command with the arguments the
 * other way round.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { DataStore, UserDocType } from "./db";
import { DATA_DIR } from "./env";
import { MongoTasteStore, isUsableTaste } from "./taste-store";
import type { UserTaste } from "./user-taste";

/** Resolves an id or a display name to exactly one account. */
async function resolveAccount(db: DataStore, identifier: string): Promise<UserDocType | null> {
    // The id first: it is what the logs print, and a display name is not
    // unique, so an id that also happens to match a name must win.
    const byId = await db.get<UserDocType>("users", identifier, false, true);

    if (byId)
        return byId;

    const all = await db.all<UserDocType>("users");
    const matches = all.filter(
        v => (v.me?.displayName ?? "").toLowerCase() === identifier.toLowerCase(),
    );

    if (matches.length > 1) {
        console.error(`"${identifier}" matches ${matches.length} accounts. Use one of these ids:`);
        matches.forEach(v => console.error("   ", v.me?.id, "-", v.me?.displayName));

        return null;
    }

    return matches[0] ?? null;
}

/** What a profile amounts to, for a human deciding whether to go ahead. */
function describe(taste: UserTaste | null): string {
    if (!taste)
        return "no profile at all";

    const plays = taste.history?.length ?? 0;
    const songs = Object.keys(taste.songData ?? {}).length;

    if (plays === 0)
        return "a profile with no plays in it";

    // Reduced rather than spread: a long enough history overflows the argument
    // limit, and this is the one line standing between somebody and a decision
    // about overwriting their listening.
    let first = Infinity;
    let last = -Infinity;

    for (const play of taste.history) {
        if (play.timestamp < first) first = play.timestamp;
        if (play.timestamp > last) last = play.timestamp;
    }

    return `${plays} plays of ${songs} songs, `
        + `${new Date(first).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)}`;
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const [from, to] = args.filter(a => !a.startsWith("--"));

    if (!from || !to) {
        console.error("Usage: copy-listening-history <from> <to> [--apply]");
        console.error("  Reports what would happen unless --apply is given.");
        process.exit(1);
    }

    if (from === to) {
        console.error("Source and target are the same account.");
        process.exit(1);
    }

    const db = new DataStore();

    await new Promise<void>(resolve => db.once("ready", resolve));

    const store = new MongoTasteStore(db);

    const source = await resolveAccount(db, from);
    const target = await resolveAccount(db, to);

    if (!source || !target) {
        if (!source) console.error("No account found for:", from);
        if (!target) console.error("No account found for:", to);

        await db.shutdown();
        process.exit(1);
    }

    const sourceId = source.meta?.serviceId ?? source.me?.id ?? "";
    const targetId = target.meta?.serviceId ?? target.me?.id ?? "";

    console.log("");
    console.log("  from:", source.me?.displayName ?? "(no name)", `<${sourceId}>`);
    console.log("    to:", target.me?.displayName ?? "(no name)", `<${targetId}>`);
    console.log("");

    if (sourceId === targetId) {
        console.error("Both names resolved to the same account. Nothing to do.");

        await db.shutdown();
        process.exit(1);
    }

    // Loaded through load(), not get(): get() returns null both for "no profile"
    // and for "the database fell over", and the difference decides whether an
    // empty backup is the truth or the prelude to destroying one.
    const sourceLoad = await store.load(sourceId);
    const targetLoad = await store.load(targetId);

    if (sourceLoad.status === "error" || targetLoad.status === "error") {
        console.error("Could not read one of the profiles. Refusing to guess at it.");

        await db.shutdown();
        process.exit(1);
    }

    const sourceTaste = sourceLoad.status === "loaded" ? sourceLoad.taste : null;
    const targetTaste = targetLoad.status === "loaded" ? targetLoad.taste : null;

    console.log("  source has", describe(sourceTaste));
    console.log("  target has", describe(targetTaste));
    console.log("");

    if (!sourceTaste || !isUsableTaste(sourceTaste) || (sourceTaste.history?.length ?? 0) === 0) {
        console.error("The source has nothing worth copying.");

        await db.shutdown();
        process.exit(1);
    }

    if (!apply) {
        console.log("  Nothing was written. Re-run with --apply to copy.");
        console.log("");

        await db.shutdown();
        return;
    }

    // Always, even when the target is empty: an empty backup costs nothing and
    // is the only thing that makes this reversible.
    const backupDir = join(DATA_DIR, "backups");

    mkdirSync(backupDir, { recursive: true });

    const backupPath = join(backupDir, `taste-${targetId}-${Date.now()}.json`);

    writeFileSync(backupPath, JSON.stringify(targetTaste ?? null));

    console.log("  Backed up the target's profile to", backupPath);

    const written = await store.set(targetId, sourceTaste);

    if (!written) {
        console.error("  The write was refused. The target is unchanged.");

        await db.shutdown();
        process.exit(1);
    }

    const check = await store.load(targetId);
    const now = check.status === "loaded" ? check.taste : null;

    console.log("  Target now has", describe(now));
    console.log("");

    await db.shutdown();
}

main().catch(async ex => {
    console.error("Failed:", ex);
    process.exit(1);
});
