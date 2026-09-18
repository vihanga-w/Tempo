import { NOW_SLOT_MS, nowSlot, type PlaylistRecipe } from "./playlist-builder";
import type { PlaylistRecord } from "./playlist-store";

/**
 * Keeping playlists fresh without being asked.
 *
 * A playlist is a recipe run at a moment: "on repeat with friends" is what
 * they were playing that week, "on repeat with Tempo" is what the listener
 * had come back to by then. Left alone it goes stale, and nobody comes back
 * to refresh a playlist by hand. So each one is rebuilt once a week from its
 * recipe, keeping out whatever was taken out by hand as a manual refresh
 * does, and its copy on Spotify is brought up to date with it.
 *
 * Weekly rather than daily: a playlist that changed under somebody every
 * morning would never be the one they had in their head, and a week is the
 * horizon the friends recipe already looks back over.
 *
 * "Right about now" is the exception, and deliberately so. Its whole claim is
 * that it is the playlist for this hour, which a week-old one plainly is not,
 * so it is rebuilt every turn of the builder's shuffle — a few hours — and its
 * turn, not its age, is what decides. Keeping the two in step matters: a
 * rebuild in the same turn would only write back the list it already had.
 */

export const REFRESH_EVERY_MS = 7 * 24 * 3600e3;
/** How long the dynamic recipe's playlist stands before it is built again. */
export const NOW_REFRESH_EVERY_MS = NOW_SLOT_MS;

/** How long a recipe's playlist is good for. */
export function refreshEvery(recipe: PlaylistRecipe): number {
    return recipe === "now" ? NOW_REFRESH_EVERY_MS : REFRESH_EVERY_MS;
}

/** Whether a playlist has gone its recipe's time without being rebuilt or changed. */
export function dueForRefresh(record: Pick<PlaylistRecord, "updatedAt" | "recipe">, now: number): boolean {
    if (record.recipe === "now")
        return nowSlot(now) !== nowSlot(record.updatedAt);

    return now - record.updatedAt >= REFRESH_EVERY_MS;
}

/** When it will next be looked at, for the app to say so. */
export function nextRefreshAt(record: Pick<PlaylistRecord, "updatedAt" | "recipe">): number {
    if (record.recipe === "now")
        return (nowSlot(record.updatedAt) + 1) * NOW_SLOT_MS;

    return record.updatedAt + REFRESH_EVERY_MS;
}
