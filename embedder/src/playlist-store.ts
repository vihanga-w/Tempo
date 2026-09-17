import type { DataStore } from "./db";
import type { PlaylistPick, PlaylistReason, PlaylistRecipe } from "./playlist-builder";

/**
 * Where a listener's playlists live.
 *
 * One document per listener holding all of them, as tastes are held: a
 * listener has a handful at most, every read wants all of them, and a single
 * document needs no index and no query. The playlist id is only ever looked
 * up inside its owner's document, so nobody can reach another listener's
 * playlist by guessing an id.
 */

export const PLAYLIST_COLLECTION = "playlists";
/** As many as a listener may keep. Enough to try every recipe a few times over. */
export const MAX_PLAYLISTS = 20;
export const MAX_NAME_LENGTH = 60;

export interface PlaylistSongRecord {
    songId: string;
    reason: PlaylistReason;
    /** When it first arrived in this playlist; a rebuild keeps it. */
    addedAt: number;
}

export interface PlaylistRecord {
    id: string;
    name: string;
    recipe: PlaylistRecipe;
    createdAt: number;
    updatedAt: number;
    songs: PlaylistSongRecord[];
    /** Songs taken out by hand, and kept out however many times the playlist is rebuilt. */
    removed: string[];
    /** Its copy on Spotify, once one has been written. */
    spotify?: { id: string; url: string; syncedAt: number };
}

export interface PlaylistsRecord {
    /** Stored inside the document as well as being its key: the key does not survive being read back. */
    userId: string;
    playlists: PlaylistRecord[];
}

/** The storage operations playlists need, so the routes can be tested against a fake. */
export interface PlaylistPersistence {
    get(userId: string): Promise<PlaylistRecord[]>;
    set(userId: string, playlists: PlaylistRecord[]): Promise<boolean>;
    /** Every listener with playlists, for the weekly refresh. */
    all(): Promise<PlaylistsRecord[]>;
}

/**
 * User ids become document paths, and the datastore reads "/" as a field
 * separator, so anything that is not a plain id is refused rather than allowed
 * to address part of a document.
 */
export function isValidPlaylistUserId(userId: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(userId);
}

export function isValidPlaylistId(id: string): boolean {
    return /^[a-f0-9]{16}$/.test(id);
}

/** A name as it will be kept: trimmed, one line, and no longer than the limit. */
export function cleanName(name: unknown, fallback: string): string {
    const cleaned = (typeof name === "string" ? name : "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);

    return cleaned || fallback;
}

/**
 * The playlist after a rebuild.
 *
 * What the recipe found now, minus anything the listener took out by hand.
 * A song that was there before keeps the date it arrived, so the list does
 * not read as brand new every time it is refreshed; its reason is the newest
 * one, since that is what is true of it now.
 */
export function rebuilt(record: PlaylistRecord, picks: readonly PlaylistPick[], now: number): PlaylistRecord {
    const removed = new Set(record.removed);
    const before = new Map(record.songs.map(song => [song.songId, song]));

    const songs: PlaylistSongRecord[] = picks
        .filter(pick => !removed.has(pick.songId))
        .map(pick => ({
            songId: pick.songId,
            reason: pick.reason,
            addedAt: before.get(pick.songId)?.addedAt ?? now,
        }));

    return { ...record, songs, updatedAt: now };
}

/** The playlist without a song, which stays out of every rebuild after. */
export function withoutSong(record: PlaylistRecord, songId: string, now: number): PlaylistRecord {
    if (!record.songs.some(song => song.songId === songId))
        return record;

    return {
        ...record,
        songs: record.songs.filter(song => song.songId !== songId),
        removed: record.removed.includes(songId) ? record.removed : [...record.removed, songId],
        updatedAt: now,
    };
}

function isRecord(value: unknown): value is PlaylistRecord {
    const record = value as PlaylistRecord;

    return typeof record?.id === "string"
        && typeof record.name === "string"
        && typeof record.recipe === "string"
        && Array.isArray(record.songs)
        && Array.isArray(record.removed);
}

export class MongoPlaylistStore implements PlaylistPersistence {
    constructor(private db: DataStore) {}

    async get(userId: string): Promise<PlaylistRecord[]> {
        if (!isValidPlaylistUserId(userId))
            return [];

        /*
         * A read that fails throws, rather than answering "none". Every
         * change is this read, a change, and the whole document written back:
         * an empty answer to a failed read would be written back as an empty
         * document, and take every playlist the listener had with it.
         */
        const record = await this.db.get<PlaylistsRecord>(PLAYLIST_COLLECTION, userId, false, false);

        // Copied out: the datastore hands the same object to every reader for a
        // second, and a route that edited it in place would edit everyone's
        return (record?.playlists ?? []).filter(isRecord).map(playlist => ({
            ...playlist,
            songs: playlist.songs.map(song => ({ ...song })),
            removed: [...playlist.removed],
        }));
    }

    async set(userId: string, playlists: PlaylistRecord[]): Promise<boolean> {
        if (!isValidPlaylistUserId(userId))
            return false;

        return await this.db.set<PlaylistsRecord>(PLAYLIST_COLLECTION, userId, { userId, playlists });
    }

    async all(): Promise<PlaylistsRecord[]> {
        const docs = await this.db.all<PlaylistsRecord>(PLAYLIST_COLLECTION);

        return docs
            .filter(doc => typeof doc?.userId === "string" && Array.isArray(doc.playlists))
            .map(doc => ({ userId: doc.userId, playlists: doc.playlists.filter(isRecord) }));
    }
}
