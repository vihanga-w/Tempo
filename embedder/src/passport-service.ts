/**
 * The passport, assembled.
 *
 * This is the only place the pure modules meet the outside world: the taste
 * profile comes from the datastore, artist origins from the cache MusicBrainz
 * fills in the background, and the destination's sentence from Groq when it is
 * configured. Everything that decides anything lives in passport.ts and
 * destination.ts, and is tested without any of this.
 *
 * The resolver is deliberately demand-driven. Opening the tab queues that
 * listener's artists, and they fill in over the following minutes at the one
 * request a second MusicBrainz allows. Nothing blocks on it: a passport built
 * before its artists are known is a smaller, honest passport that says how many
 * are still pending, rather than a spinner over an empty page.
 */

import type { DataStore } from "./db";
import type { SongDataCache } from "./song-data-cache";
import type { TastePersistence } from "./taste-store";
import type { OriginPersistence, ArtistOriginRecord } from "./origin-store";
import { isStale } from "./origin-store";
import { MusicBrainzClient } from "./artist-origin";
import { buildPassport, Passport, PassportPlay } from "./passport";
import {
    pickDestination, weekKey, Destination, CatalogueArtist, ListenerArtist,
} from "./destination";
import { writeDestinationCopy } from "./destination-copy";

/** How often the resolver takes one artist off the queue. */
export const RESOLVER_TICK_MS = 1500;

/** A ceiling, so one enormous history cannot fill memory with pending work. */
export const RESOLVER_QUEUE_MAX = 5000;

interface QueueEntry {
    artistId: string;
    name: string;
    isrc: string;
}

export interface PassportResult {
    passport: Passport;
    destination: (Destination & { why: string; generated: boolean }) | null;
    /** Artists from this listener's history still waiting on MusicBrainz. */
    pendingArtists: number;
}

export class PassportService {
    private queue = new Map<string, QueueEntry>();
    private origins = new Map<string, ArtistOriginRecord>();
    private timer: NodeJS.Timeout | null = null;
    private loaded = false;

    /** One destination per listener per week, so it does not move under them. */
    private destinationCache = new Map<string, { week: string; result: PassportResult["destination"] }>();

    constructor(
        private db: DataStore,
        private originStore: OriginPersistence,
        private songMetaCache: SongDataCache,
        private tasteStore: TastePersistence,
        private mb: MusicBrainzClient,
    ) {}

    /** Reads every known origin into memory once; the set is small and hot. */
    async load(): Promise<void> {
        if (this.loaded)
            return;

        try {
            for (const record of await this.originStore.all()) {
                if (record.artistId)
                    this.origins.set(record.artistId, record);
            }

            this.loaded = true;

            console.log("[passport] Loaded", this.origins.size, "artist origin(s)");
        } catch (ex) {
            console.warn("[passport] Could not load artist origins:", ex);
        }
    }

    startResolver(): void {
        if (this.timer)
            return;

        this.timer = setInterval(() => {
            this.resolveNext().catch(ex => console.warn("[passport] Resolver tick failed:", ex));
        }, RESOLVER_TICK_MS);
    }

    stopResolver(): void {
        if (!this.timer)
            return;

        clearInterval(this.timer);
        this.timer = null;
    }

    get pendingCount(): number {
        return this.queue.size;
    }

    /** The country we know an artist is from, for the pure passport builder. */
    countryForArtist = (artistId: string): string | null => {
        return this.origins.get(artistId)?.countryCode ?? null;
    };

    private artistsForSong = (songId: string): string[] | null => {
        const song = this.songMetaCache.getItem(songId);

        if (!song?.artists?.length)
            return null;

        return song.artists.map(a => a.id).filter(Boolean);
    };

    /**
     * Note every artist in a history we cannot place yet.
     *
     * An artist is only queued if one of their tracks carries an ISRC, because
     * the ISRC is the key the whole lookup turns on. Without one there is
     * nothing to ask MusicBrainz.
     */
    private enqueueFromHistory(history: PassportPlay[]): number {
        // Counted as a set of artists rather than a running total of plays: the
        // queue deduplicates by artist, so two hundred plays of one unresolved
        // artist is one artist pending, not two hundred.
        const pending = new Set<string>();

        for (const play of history) {
            if (play.skipped)
                continue;

            const song = this.songMetaCache.getItem(play.songId);
            const artist = song?.artists?.[0];

            if (!artist?.id || !song?.isrc)
                continue;

            if (!isStale(this.origins.get(artist.id) ?? null, Date.now()))
                continue;

            pending.add(artist.id);

            if (this.queue.has(artist.id) || this.queue.size >= RESOLVER_QUEUE_MAX)
                continue;

            this.queue.set(artist.id, {
                artistId: artist.id,
                name: artist.name,
                isrc: song.isrc,
            });
        }

        return pending.size;
    }

    /**
     * Resolve one artist, and remember the answer either way.
     *
     * A failure is written down as firmly as a success. Without that the queue
     * refills with the same unresolvable artists on every pass and the ones that
     * could be answered never come up.
     */
    async resolveNext(): Promise<boolean> {
        const next = this.queue.values().next();

        if (next.done)
            return false;

        const entry = next.value;

        this.queue.delete(entry.artistId);

        const origin = await this.mb.resolveByIsrc(entry.isrc);

        const record: ArtistOriginRecord = {
            artistId: entry.artistId,
            name: entry.name,
            countryCode: origin?.countryCode ?? null,
            city: origin?.city ?? null,
            genres: origin?.genres ?? [],
            mbid: origin?.mbid ?? null,
            resolved: !!origin?.countryCode,
            updatedAt: Date.now(),
        };

        this.origins.set(entry.artistId, record);

        try {
            await this.originStore.set(entry.artistId, record);
        } catch (ex) {
            console.warn("[passport] Could not store the origin for", entry.artistId, ex);
        }

        return true;
    }

    /** Every resolved artist, as candidate destinations. */
    private catalogue(): CatalogueArtist[] {
        const out: CatalogueArtist[] = [];

        for (const record of this.origins.values()) {
            if (!record.resolved || !record.countryCode || !record.artistId)
                continue;

            out.push({
                artistId: record.artistId,
                name: record.name || "an artist",
                countryCode: record.countryCode,
                genres: record.genres ?? [],
            });
        }

        return out;
    }

    /** What this listener plays, with the genres we know for each artist. */
    private listenerArtists(history: PassportPlay[]): ListenerArtist[] {
        const plays = new Map<string, number>();

        for (const play of history) {
            if (play.skipped)
                continue;

            const artist = this.songMetaCache.getItem(play.songId)?.artists?.[0];

            if (!artist?.id)
                continue;

            plays.set(artist.id, (plays.get(artist.id) ?? 0) + 1);
        }

        const out: ListenerArtist[] = [];

        for (const [artistId, count] of plays) {
            const record = this.origins.get(artistId);

            if (!record)
                continue;

            out.push({
                artistId,
                name: record.name || "an artist",
                countryCode: record.countryCode,
                genres: record.genres ?? [],
                plays: count,
            });
        }

        return out;
    }

    /** The whole thing, for one listener. */
    async buildFor(userId: string, now = Date.now()): Promise<PassportResult> {
        await this.load();

        const taste = await this.tasteStore.get(userId);
        const history: PassportPlay[] = (taste?.history ?? []).map(item => ({
            songId: item.songId,
            skipped: item.skipped,
            timestamp: item.timestamp,
        }));

        const pendingArtists = this.enqueueFromHistory(history);

        const passport = buildPassport(
            history, this.artistsForSong, this.countryForArtist, now,
        );

        const destination = await this.destinationFor(userId, history, passport, now);

        return { passport, destination, pendingArtists };
    }

    private async destinationFor(
        userId: string,
        history: PassportPlay[],
        passport: Passport,
        now: number,
    ): Promise<PassportResult["destination"]> {
        const week = weekKey(now);
        const cached = this.destinationCache.get(userId);

        if (cached && cached.week === week)
            return cached.result;

        const visited = new Set(passport.countries.map(c => c.countryCode));

        const choice = pickDestination(
            this.listenerArtists(history), this.catalogue(), visited, now,
        );

        let result: PassportResult["destination"] = null;

        if (choice) {
            const copy = await writeDestinationCopy(choice);

            result = { ...choice, why: copy.text, generated: copy.generated };
        }

        // Only a real choice is cached. Caching null would mean the first read
        // -- taken before any origin has resolved -- decided that this listener
        // gets no destination until the week turns over, however much
        // MusicBrainz fills in behind it a minute later.
        if (result)
            this.destinationCache.set(userId, { week, result });

        return result;
    }
}
