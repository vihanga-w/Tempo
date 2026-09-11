/**
 * Every song, described, without anyone asking.
 *
 * Songs arrive through the playback poll and are handed here the moment they
 * are first written (SongDataCache's new-song hook). Each is looked up on Deezer
 * in the background — track, album, artist — and the answer is stored, gaps and
 * all, on the schedule in song-feature-store.ts: a song with something missing
 * is asked about again in a week, and a complete one in three months.
 *
 * Two queues, because there are two kinds of work. A song somebody played today
 * goes to the front; the backlog — every song the server knew about before this
 * existed, and every retry that has come due — fills whatever time is left.
 * Otherwise a new release played on the day it came out would wait behind
 * thousands of old songs.
 *
 * What it gathers is read through describedSongs(): the song model embeds every
 * described song, and those embeddings are Discover's taste candidates (see
 * song-embeddings.ts and user-taste.ts). Every song any listener plays becomes
 * one, so the catalogue grows by itself.
 */

import type { SongData } from "./song-data-cache";
import type { DeezerClient } from "./deezer-client";
import type { SongFeaturePersistence, SongFeatureRecord, LookupOutcome } from "./song-feature-store";
import { isDue, isValidSongId, settle, TRANSIENT_RETRY_MS } from "./song-feature-store";
import { isValidIsrc, durationsAgree, Lookup, DeezerAlbumFields, DeezerArtistFields } from "./song-features";

/**
 * How often one song is taken off the queue.
 *
 * A song costs up to three requests at a quarter of a second each, so this is
 * about as fast as the client will go anyway; the resolving flag stops ticks
 * from stacking when Deezer is slow.
 */
export const FEATURE_TICK_MS = 1000;

/** How often the backlog is refilled with songs that have come due. */
export const FEATURE_SWEEP_MS = 10 * 60e3;

/** A ceiling on pending work. Ids only, so this is small; the sweep picks up any overflow later. */
export const FEATURE_QUEUE_MAX = 50_000;

/**
 * How long a looked-up album or artist is reused for.
 *
 * A backfill reads whole albums one track at a time, so without this the same
 * album would be fetched a dozen times in a row. Short enough that a retry a
 * week later always asks again.
 */
export const LOOKUP_MEMO_MS = 6 * 3600e3;
const LOOKUP_MEMO_MAX = 5000;

interface Pending {
    songId: string;
    isrc: string;
    /** Spotify's length in ms, which a Deezer match has to agree with. */
    durationMs?: number;
}

type DeezerLookups = Pick<DeezerClient, "trackByIsrc" | "album" | "artist">;

export interface SongSource {
    listSongs(): SongData[];
}

/** Only tracks with an ISRC can be matched to Deezer. Podcast episodes and local files cannot. */
function eligible(song: SongData | null | undefined): song is SongData & { isrc: string } {
    return !!song
        && (song.type ?? "track") === "track"
        && isValidSongId(song.id)
        && isValidIsrc(song.isrc);
}

export class SongFeatureService {
    private records = new Map<string, SongFeatureRecord>();
    private fresh = new Map<string, Pending>();
    private backlog = new Map<string, Pending>();
    /** Lookups that got no answer, waiting out TRANSIENT_RETRY_MS in memory only. */
    private deferred = new Map<string, { entry: Pending; until: number }>();
    private albums = new Map<number, { value: DeezerAlbumFields; at: number }>();
    private artists = new Map<number, { value: DeezerArtistFields; at: number }>();
    private tickTimer: NodeJS.Timeout | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;
    private loaded = false;

    /**
     * Whether a lookup is in flight.
     *
     * A song takes longer than a tick when Deezer is slow or backing off, and
     * the interval does not wait, so without this the lookups would stack.
     */
    private resolving = false;
    private inFlight: string | null = null;

    constructor(
        private store: SongFeaturePersistence,
        private deezer: DeezerLookups,
        private songs: SongSource,
        private now: () => number = () => Date.now(),
    ) {}

    /** Reads every record into memory once, so deciding what is due costs nothing. */
    async load(): Promise<void> {
        if (this.loaded)
            return;

        try {
            for (const record of await this.store.all())
                this.records.set(record.songId, record);

            this.loaded = true;

            console.log("[songfeatures] Loaded", this.records.size, "song description(s)");
        } catch (ex) {
            console.warn("[songfeatures] Could not load song descriptions:", ex);
        }
    }

    start(): void {
        if (this.tickTimer)
            return;

        this.tickTimer = setInterval(() => {
            this.resolveNext().catch(ex => console.warn("[songfeatures] Tick failed:", ex));
        }, FEATURE_TICK_MS);

        this.sweepTimer = setInterval(() => this.sweep(), FEATURE_SWEEP_MS);

        const queued = this.sweep();

        console.log("[songfeatures] Fetcher started with", queued, "song(s) to look up");
    }

    stop(): void {
        if (this.tickTimer)
            clearInterval(this.tickTimer);

        if (this.sweepTimer)
            clearInterval(this.sweepTimer);

        this.tickTimer = null;
        this.sweepTimer = null;
    }

    get pendingCount(): number {
        return this.fresh.size + this.backlog.size;
    }

    /** What is known about a song, for whatever comes to read it. */
    record(songId: string): SongFeatureRecord | null {
        return this.records.get(songId) ?? null;
    }

    /** Every song looked up so far, described or not. */
    describedSongs(): IterableIterator<SongFeatureRecord> {
        return this.records.values();
    }

    private waiting(songId: string, now: number): boolean {
        const deferred = this.deferred.get(songId);

        return !!deferred && deferred.until > now;
    }

    private queued(songId: string): boolean {
        return this.fresh.has(songId) || this.backlog.has(songId) || this.inFlight === songId;
    }

    /**
     * A song has just been seen for the first time.
     *
     * Called from the playback poll, so it has to be cheap: two map reads and,
     * at most, one write. Returns whether the song was queued.
     */
    noteSong(song: SongData | null | undefined): boolean {
        if (!eligible(song))
            return false;

        const now = this.now();

        if (!isDue(this.records.get(song.id), now) || this.waiting(song.id, now))
            return false;

        if (this.fresh.has(song.id) || this.inFlight === song.id)
            return false;

        // Already waiting in the backlog: somebody is listening now, so it moves up
        this.backlog.delete(song.id);

        if (this.pendingCount >= FEATURE_QUEUE_MAX)
            return false;

        this.fresh.set(song.id, { songId: song.id, isrc: song.isrc, durationMs: song.duration });

        return true;
    }

    private enqueueBacklog(entry: Pending, now: number): boolean {
        if (this.queued(entry.songId) || this.waiting(entry.songId, now))
            return false;

        if (this.pendingCount >= FEATURE_QUEUE_MAX)
            return false;

        this.backlog.set(entry.songId, entry);

        return true;
    }

    /**
     * Refill the backlog: retries that have come due, lookups that failed and
     * have waited long enough, and songs that have never been looked up.
     *
     * The last of those is the backfill. On the first sweep it is every song the
     * server already knew about; afterwards, only ever the ones the new-song
     * hook missed, since it catches everything played from then on.
     */
    sweep(): number {
        const now = this.now();
        let added = 0;

        for (const [songId, deferred] of this.deferred) {
            if (deferred.until > now)
                continue;

            this.deferred.delete(songId);

            if (this.enqueueBacklog(deferred.entry, now))
                added++;
        }

        for (const record of this.records.values()) {
            if (isDue(record, now) && this.enqueueBacklog({ songId: record.songId, isrc: record.isrc, durationMs: record.durationMs }, now))
                added++;
        }

        let songs: SongData[] = [];

        try {
            songs = this.songs.listSongs();
        } catch (ex) {
            console.warn("[songfeatures] Could not list known songs:", ex);
        }

        for (const song of songs) {
            if (eligible(song) && !this.records.has(song.id) && this.enqueueBacklog({ songId: song.id, isrc: song.isrc, durationMs: song.duration }, now))
                added++;
        }

        return added;
    }

    private async memoised<T>(
        memo: Map<number, { value: T; at: number }>,
        id: number | null,
        fetch: (id: number) => Promise<Lookup<T>>,
    ): Promise<Lookup<T>> {
        if (id === null)
            return { kind: "missing" };

        const now = this.now();
        const hit = memo.get(id);

        if (hit && now - hit.at < LOOKUP_MEMO_MS)
            return { kind: "found", value: hit.value };

        const answer = await fetch(id);

        if (answer.kind === "found") {
            if (memo.size >= LOOKUP_MEMO_MAX)
                memo.clear();

            memo.set(id, { value: answer.value, at: now });
        }

        return answer;
    }

    private async lookup(entry: Pending): Promise<LookupOutcome> {
        const track = await this.deezer.trackByIsrc(entry.isrc);

        if (track.kind !== "found")
            return { track };

        // A placeholder ISRC finds somebody else's song. Refused before its album
        // and artist are asked for, since they would describe the wrong recording.
        if (!durationsAgree(track.value.duration, entry.durationMs)) {
            console.log(
                "[songfeatures] Refused Deezer track", track.value.id, "for", entry.songId,
                `(ISRC ${entry.isrc}: ${track.value.duration}s, against Spotify's ${Math.round((entry.durationMs ?? 0) / 1000)}s)`,
            );

            return {
                track: { kind: "missing" },
                rejected: {
                    deezerTrackId: track.value.id,
                    deezerDurationMs: track.value.duration * 1000,
                    spotifyDurationMs: entry.durationMs ?? 0,
                },
            };
        }

        const album = await this.memoised(this.albums, track.value.album_id, id => this.deezer.album(id));

        // No point spending a request on the artist when the round is already void
        if (album.kind === "failed")
            return { track, album };

        const artist = await this.memoised(this.artists, track.value.artist_id, id => this.deezer.artist(id));

        return { track, album, artist };
    }

    /**
     * Look one song up, and remember the answer whichever way it went.
     *
     * A lookup that got no answer at all is the exception: it waits out
     * TRANSIENT_RETRY_MS in memory and is not written down, because a timeout
     * says nothing about the song.
     */
    async resolveNext(): Promise<boolean> {
        if (this.resolving)
            return false;

        const next = this.fresh.values().next().done
            ? this.backlog.values().next()
            : this.fresh.values().next();

        if (next.done)
            return false;

        const entry = next.value;

        this.fresh.delete(entry.songId);
        this.backlog.delete(entry.songId);

        this.resolving = true;
        this.inFlight = entry.songId;

        // Everything inside the finally, or one throw would leave the flag set and
        // the fetcher silently stopped for the life of the process
        try {
            const outcome = await this.lookup(entry);
            const record = settle(this.records.get(entry.songId) ?? null, outcome, entry, this.now());

            if (!record) {
                this.deferred.set(entry.songId, { entry, until: this.now() + TRANSIENT_RETRY_MS });

                return true;
            }

            // Remembered only once it is stored. Kept in memory alone, the record
            // would not come due again for a week or three months, so a write the
            // database refused would never be tried again.
            if (await this.store.set(entry.songId, record)) {
                this.records.set(entry.songId, record);
            } else {
                console.warn("[songfeatures] Could not store", entry.songId, "- trying again shortly");

                this.deferred.set(entry.songId, { entry, until: this.now() + TRANSIENT_RETRY_MS });
            }
        } catch (ex) {
            console.warn("[songfeatures] Could not look up", entry.songId, ex);

            this.deferred.set(entry.songId, { entry, until: this.now() + TRANSIENT_RETRY_MS });
        } finally {
            this.resolving = false;
            this.inFlight = null;
        }

        return true;
    }
}
