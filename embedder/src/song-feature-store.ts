/**
 * Where each song's metadata lives, and when to ask about it again.
 *
 * One record per Spotify track: what Deezer said about it, what was still
 * missing, and when it is next worth asking. Failures are recorded as firmly as
 * successes, as they are for artist origins — a song Deezer has never heard of
 * is a fact worth keeping, or the fetcher would ask about it on every pass and
 * never reach the ones it can answer.
 *
 * The schedule is the point of this file. A song first played on the day it
 * came out is routinely thinner than it will be a week later, so a gap is not
 * an answer: it is a reason to come back.
 */

import type { DataStore } from "./db";
import { FeatureGap, Lookup, SongFeatures, DeezerTrackFields, DeezerAlbumFields, DeezerArtistFields, gapsIn } from "./song-features";
import { isSongId } from "./song-identity";

export const FEATURE_COLLECTION = "songFeatures";

const DAY_MS = 24 * 60 * 60e3;

/** How long before a song with something missing is asked about again. */
export const RETRY_AFTER_MS = 7 * DAY_MS;

/**
 * How many weekly retries before they slow to monthly.
 *
 * Two months of weekly checks covers a release filling in; anything still
 * missing after that is unlikely to arrive soon, but catalogues do backfill, so
 * it is asked about less often rather than never.
 */
export const RETRY_WEEKLY_ATTEMPTS = 8;

export const RETRY_SLOW_MS = 30 * DAY_MS;

/**
 * How long a complete description stands.
 *
 * Rank and fan counts are part of the vector and they drift as a song and its
 * artist rise or fade, so even a complete record is read again eventually.
 */
export const REFRESH_COMPLETE_MS = 90 * DAY_MS;

/**
 * How long a lookup that got no answer at all waits.
 *
 * A timeout or a spent quota says nothing about the song, so it waits minutes
 * rather than the week a real "not there" earns, and is not written down.
 */
export const TRANSIENT_RETRY_MS = 30 * 60e3;

/**
 * Which fetcher wrote a record.
 *
 * Raised whenever what is fetched changes, so records written by an older one
 * are due at once rather than on whatever schedule the old one set.
 *
 *   1  Deezer track by ISRC, then its album and artist
 *   2  and a match is refused when its length disagrees with Spotify's
 */
export const FEATURE_STRATEGY = 2;

/** A Deezer track found by ISRC and refused, because its length says it is another recording. */
export interface RejectedMatch {
    deezerTrackId: number;
    deezerDurationMs: number;
    spotifyDurationMs: number;
}

export interface SongFeatureRecord {
    /** Spotify track id, and the document key. */
    songId: string;
    isrc: string;
    /**
     * Spotify's length for the song, in ms: what a Deezer match is checked
     * against. Kept so a retry that comes due with no play in hand can check.
     */
    durationMs?: number;
    /** The last match refused for disagreeing on length; why a song may have no description. */
    rejected?: RejectedMatch | null;
    /** What Deezer had, or null when it had nothing for this ISRC. */
    features: SongFeatures | null;
    /** What is still missing that could still arrive. Empty when complete. */
    gaps: FeatureGap[];
    /** Consecutive lookups that left gaps; what spaces the retries out. */
    attempts: number;
    strategy: number;
    updatedAt: number;
    nextAttemptAt: number;
}

/** What one round of asking Deezer came back with. */
export interface LookupOutcome {
    track: Lookup<DeezerTrackFields>;
    album?: Lookup<DeezerAlbumFields>;
    artist?: Lookup<DeezerArtistFields>;
    /** Set when Deezer did have a track for the ISRC but it was not this song. The track then reads as missing. */
    rejected?: RejectedMatch;
}

export interface SongFeaturePersistence {
    set(songId: string, record: SongFeatureRecord): Promise<boolean>;
    all(): Promise<SongFeatureRecord[]>;
}

/** When a record with these gaps, after this many gappy lookups in a row, is next due. */
export function scheduleAfter(now: number, gaps: FeatureGap[], attempts: number): number {
    if (gaps.length === 0)
        return now + REFRESH_COMPLETE_MS;

    return now + (attempts <= RETRY_WEEKLY_ATTEMPTS ? RETRY_AFTER_MS : RETRY_SLOW_MS);
}

/** Whether a song should be looked up now. */
export function isDue(record: SongFeatureRecord | null | undefined, now: number): boolean {
    if (!record)
        return true;

    if ((record.strategy ?? 0) < FEATURE_STRATEGY)
        return true;

    return now >= record.nextAttemptAt;
}

/**
 * The record a lookup leaves behind, or null when it should not leave one.
 *
 * Null whenever any part of the lookup got no answer: writing down a half-read
 * song as if it were all Deezer has would park it for a week over a timeout.
 *
 * A retry never makes a record worse. If the track has vanished, or its album
 * or artist comes back empty this time, what was known before is kept — as
 * long as it is still about the same album and artist.
 */
export function settle(
    previous: SongFeatureRecord | null,
    outcome: LookupOutcome,
    key: { songId: string; isrc: string; durationMs?: number },
    now: number,
): SongFeatureRecord | null {
    if (outcome.track.kind === "failed"
        || outcome.album?.kind === "failed"
        || outcome.artist?.kind === "failed")
        return null;

    let features: SongFeatures | null;

    if (outcome.track.kind === "missing") {
        // A match refused on length says the ISRC now leads somewhere else, so
        // nothing kept from before is trusted: the song goes back to having no
        // description, and so back onto the weekly retry. A plain "Deezer has
        // nothing" keeps what it had.
        features = outcome.rejected ? null : (previous?.features ?? null);
    } else {
        const track = outcome.track.value;
        const before = previous?.features;

        const keep = <T extends { id: number }>(
            fresh: Lookup<T> | undefined,
            old: T | null | undefined,
            id: number | null,
        ): T | null => {
            if (fresh?.kind === "found")
                return fresh.value;

            return (old && old.id === id) ? old : null;
        };

        features = {
            track,
            album: keep(outcome.album, before?.album, track.album_id),
            artist: keep(outcome.artist, before?.artist, track.artist_id),
        };
    }

    const gaps = gapsIn(features);
    const attempts = gaps.length === 0 ? 0 : (previous?.attempts ?? 0) + 1;

    return {
        songId: key.songId,
        isrc: key.isrc,
        durationMs: key.durationMs ?? previous?.durationMs,
        rejected: outcome.rejected ?? null,
        features,
        gaps,
        attempts,
        strategy: FEATURE_STRATEGY,
        updatedAt: now,
        nextAttemptAt: scheduleAfter(now, gaps, attempts),
    };
}

export class MongoSongFeatureStore implements SongFeaturePersistence {
    constructor(private db: DataStore) {}

    async set(songId: string, record: SongFeatureRecord): Promise<boolean> {
        if (!isSongId(songId))
            return false;

        return this.db.set<SongFeatureRecord>(FEATURE_COLLECTION, songId, { ...record, songId });
    }

    async all(): Promise<SongFeatureRecord[]> {
        const records = await this.db.all<SongFeatureRecord>(FEATURE_COLLECTION);

        if (!Array.isArray(records))
            return [];

        // Anything malformed is dropped, and so looked up again as if it had never been
        return records.filter(r =>
            r
            && isSongId(r.songId)
            && typeof r.isrc === "string"
            && Array.isArray(r.gaps)
            && typeof r.nextAttemptAt === "number");
    }
}
