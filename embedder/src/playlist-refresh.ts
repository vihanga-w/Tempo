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
 */

export const REFRESH_EVERY_MS = 7 * 24 * 3600e3;

/** Whether a playlist has gone a week without being rebuilt or changed. */
export function dueForRefresh(record: Pick<PlaylistRecord, "updatedAt">, now: number): boolean {
    return now - record.updatedAt >= REFRESH_EVERY_MS;
}

/** When it will next be looked at, for the app to say so. */
export function nextRefreshAt(record: Pick<PlaylistRecord, "updatedAt">): number {
    return record.updatedAt + REFRESH_EVERY_MS;
}
