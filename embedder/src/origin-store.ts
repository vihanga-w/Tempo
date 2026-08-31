/**
 * Where resolved artist origins live.
 *
 * An artist's country of origin is immutable, so this is a permanent cache
 * rather than an expiring one: once an artist is resolved, MusicBrainz is never
 * asked about them again. That is what keeps a service limited to one request a
 * second able to back a feature that reads thousands of plays.
 *
 * Failures are recorded too. An artist MusicBrainz has never heard of is a fact
 * worth storing — without it the resolver would retry the same unresolvable
 * artist forever and never reach the ones it can answer.
 */

import type { DataStore } from "./db";

export const ORIGIN_COLLECTION = "artistOrigins";

/**
 * How long before an unresolved artist is worth trying again.
 *
 * Not never: an artist missing from MusicBrainz today may be added, and a
 * lookup that failed on a transient error should not be permanent. Two weeks is
 * long enough that retries cost nothing and short enough to pick up additions.
 */
export const ORIGIN_RETRY_MS = 14 * 24 * 60 * 60e3;

export interface ArtistOriginRecord {
    /** Spotify artist id, and the document key. */
    artistId?: string;
    /** ISO 3166-1 alpha-2, or null when MusicBrainz had no country for them. */
    countryCode: string | null;
    /** Display name, carried so a destination can name artists without a second read. */
    name?: string;
    city: string | null;
    genres: string[];
    mbid: string | null;
    /** False when the lookup ran and came back with nothing usable. */
    resolved: boolean;
    updatedAt: number;
}

export interface OriginPersistence {
    get(artistId: string): Promise<ArtistOriginRecord | null>;
    set(artistId: string, record: ArtistOriginRecord): Promise<boolean>;
    all(): Promise<ArtistOriginRecord[]>;
}

/**
 * Artist ids become document paths, and the datastore reads "/" as a field
 * separator, so anything that is not a plain id is refused rather than allowed
 * to address part of a document.
 */
export function isValidArtistId(artistId: string): boolean {
    return /^[A-Za-z0-9._-]{1,128}$/.test(artistId);
}

/** Whether a stored record should be looked up again. */
export function isStale(record: ArtistOriginRecord | null, now: number): boolean {
    if (!record)
        return true;

    // A resolved artist is never re-read. Their birthplace is not going to move.
    if (record.resolved)
        return false;

    return (now - (record.updatedAt ?? 0)) > ORIGIN_RETRY_MS;
}

export class MongoOriginStore implements OriginPersistence {
    constructor(private db: DataStore) {}

    async get(artistId: string): Promise<ArtistOriginRecord | null> {
        if (!isValidArtistId(artistId))
            return null;

        const record = await this.db.get<ArtistOriginRecord>(
            ORIGIN_COLLECTION, artistId, false, true,
        );

        if (!record || typeof record.resolved !== "boolean")
            return null;

        return {
            artistId,
            countryCode: record.countryCode ?? null,
            name: record.name,
            city: record.city ?? null,
            genres: Array.isArray(record.genres) ? record.genres : [],
            mbid: record.mbid ?? null,
            resolved: record.resolved,
            updatedAt: record.updatedAt ?? 0,
        };
    }

    async set(artistId: string, record: ArtistOriginRecord): Promise<boolean> {
        if (!isValidArtistId(artistId))
            return false;

        return this.db.set<ArtistOriginRecord>(ORIGIN_COLLECTION, artistId, {
            ...record,
            artistId,
        });
    }

    async all(): Promise<ArtistOriginRecord[]> {
        const records = await this.db.all<ArtistOriginRecord>(ORIGIN_COLLECTION);

        return Array.isArray(records) ? records.filter(Boolean) : [];
    }
}
