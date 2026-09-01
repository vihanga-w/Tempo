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

/**
 * How long a "nowhere to send you" answer stands before it is worked out again.
 *
 * Not cached at all was wrong: choosing a destination now ends in a MusicBrainz
 * query, so an uncacheable null meant every read of the page fired another one,
 * on a budget of one request a second that the origin resolver is also using.
 * Cached for the week was wrong too, and for the original reason: the first
 * read happens before anything has resolved, and that answer must not decide
 * the whole week. Minutes, so it recovers as origins arrive without being asked
 * again on every refresh.
 */
export const DESTINATION_RETRY_MS = 15 * 60e3;

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

    /**
     * Whether a resolution is already in flight.
     *
     * One artist costs two MusicBrainz requests, which the client spaces a
     * second apart, so a resolution takes longer than the tick that started it.
     * The interval does not await anything, so without this the ticks stacked:
     * every 1.5 seconds another overlapping resolution, each holding a promise
     * until the queue drained.
     */
    private resolving = false;

    /** One destination per listener per week, so it does not move under them. */
    private destinationCache = new Map<string, {
        week: string;
        result: PassportResult["destination"];
        /** When a null answer is worth working out again. Zero for a real one. */
        retryAfter: number;
    }>();

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

    /**
     * Note every artist in a history we cannot place yet.
     *
     * An artist is only queued if one of their tracks carries an ISRC, because
     * the ISRC is the key the whole lookup turns on. Without one there is
     * nothing to ask MusicBrainz.
     */
    private enqueueFromHistory(
        history: PassportPlay[],
        songs: Map<string, { id: string; name: string; isrc?: string }>,
    ): number {
        // Counted as a set of artists rather than a running total of plays: the
        // queue deduplicates by artist, so two hundred plays of one unresolved
        // artist is one artist pending, not two hundred.
        const pending = new Set<string>();

        for (const play of history) {
            if (play.skipped)
                continue;

            const artist = songs.get(play.songId);

            if (!artist || !artist.isrc)
                continue;

            if (!isStale(this.origins.get(artist.id) ?? null, Date.now()))
                continue;

            pending.add(artist.id);

            if (this.queue.has(artist.id) || this.queue.size >= RESOLVER_QUEUE_MAX)
                continue;

            this.queue.set(artist.id, {
                artistId: artist.id,
                name: artist.name,
                isrc: artist.isrc,
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
        if (this.resolving)
            return false;

        const next = this.queue.values().next();

        if (next.done)
            return false;

        this.resolving = true;

        const entry = next.value;

        this.queue.delete(entry.artistId);

        // Everything is inside the finally. A throw before it would leave the
        // flag set and the resolver would never run again for the life of the
        // process -- a failure that looks exactly like an empty queue.
        try {
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

            await this.originStore.set(entry.artistId, record);
        } catch (ex) {
            console.warn("[passport] Could not resolve or store", entry.artistId, ex);
        } finally {
            this.resolving = false;
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
    private listenerArtists(
        history: PassportPlay[],
        songs: Map<string, { id: string; name: string; isrc?: string }>,
    ): ListenerArtist[] {
        const plays = new Map<string, number>();

        for (const play of history) {
            if (play.skipped)
                continue;

            const artist = songs.get(play.songId);

            if (!artist)
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

    /**
     * Every song in a history resolved to its primary artist, once.
     *
     * The three passes below -- queueing, placing and profiling -- each used to
     * call getItem per play. That cache is keyed per song and holds for a day,
     * so it was not re-reading disk, but a listener with thousands of plays
     * still paid three lookups and three object spreads for each one. This does
     * it once and hands the result round.
     */
    private resolveSongs(history: PassportPlay[]): Map<string, { id: string; name: string; isrc?: string }> {
        const byId = new Map<string, { id: string; name: string; isrc?: string }>();

        for (const play of history) {
            if (play.skipped || byId.has(play.songId))
                continue;

            const song = this.songMetaCache.getItem(play.songId);
            const artist = song?.artists?.[0];

            if (!artist?.id)
                continue;

            byId.set(play.songId, { id: artist.id, name: artist.name, isrc: song?.isrc });
        }

        return byId;
    }

    /**
     * Names to offer, from MusicBrainz when Tempo has none.
     *
     * The catalogue is built from what people here already play, so for most
     * places it has nothing the listener has not heard. MusicBrainz is asked
     * for artists from the country in the genres the two sides share — one
     * query, once a week per listener, because the destination is held for the
     * week either way.
     */
    private async withFreshArtists(
        choice: Destination,
        listenerArtists: ListenerArtist[],
    ): Promise<Destination | null> {
        if (choice.fresh.length > 0)
            return choice;

        // What *this* listener has played, not what Tempo has ever resolved.
        // Filtering against the whole catalogue would hide an artist from them
        // because somebody else listens to it, and would hide more of them the
        // more people join.
        const known = new Set(listenerArtists.map(a => a.name.toLowerCase()));

        try {
            const found = await this.mb.artistsFromCountry(
                choice.countryCode, choice.sharedGenres, known,
            );

            const fresh = found
                .slice(0, 3)
                // Not a Spotify id, and nothing looks it up -- it exists so the
                // list has stable keys.
                .map(a => ({ artistId: `mb:${a.mbid}`, name: a.name }));

            if (fresh.length === 0)
                return null;

            return { ...choice, fresh };
        } catch (ex) {
            console.warn("[passport] Could not name artists for", choice.countryCode, ex);

            return null;
        }
    }

    /** Everything the passport needs, without deciding where to send anybody. */
    private async gather(userId: string, now: number) {
        await this.load();

        const taste = await this.tasteStore.get(userId);
        const history: PassportPlay[] = (taste?.history ?? []).map(item => ({
            songId: item.songId,
            skipped: item.skipped,
            timestamp: item.timestamp,
        }));

        const songs = this.resolveSongs(history);
        const pendingArtists = this.enqueueFromHistory(history, songs);

        const passport = buildPassport(
            history,
            songId => {
                const artist = songs.get(songId);

                return artist ? [artist.id] : null;
            },
            this.countryForArtist,
            now,
        );

        return { history, songs, passport, pendingArtists };
    }

    /**
     * The stamps alone, for the sweep that sends notifications.
     *
     * Deliberately not buildFor. That would also pick a destination, and picking
     * one can end in a MusicBrainz search and a Groq call -- for every listener,
     * on a timer, whether or not anybody is looking. Worse than the wasted work,
     * MusicBrainz allows one request a second and the origin resolver is already
     * spending it: a background sweep competing for that budget slows down the
     * very thing that makes new stamps appear.
     *
     * Queueing unresolved artists is kept, and is the point -- it means origins
     * fill in for somebody who has not opened the tab, which is exactly who a
     * notification is for.
     */
    async passportFor(userId: string, now = Date.now()) {
        const { passport, pendingArtists } = await this.gather(userId, now);

        return { passport, pendingArtists };
    }

    /** The whole thing, for one listener. */
    async buildFor(userId: string, now = Date.now()): Promise<PassportResult> {
        const { history, songs, passport, pendingArtists } = await this.gather(userId, now);
        const destination = await this.destinationFor(userId, history, songs, passport, now);

        return { passport, destination, pendingArtists };
    }

    private async destinationFor(
        userId: string,
        history: PassportPlay[],
        songs: Map<string, { id: string; name: string; isrc?: string }>,
        passport: Passport,
        now: number,
    ): Promise<PassportResult["destination"]> {
        const week = weekKey(now);

        // One entry per listener, kept forever, would be a slow leak on a
        // long-running process. Last week's answers are no longer reachable.
        for (const [id, entry] of this.destinationCache) {
            if (entry.week !== week)
                this.destinationCache.delete(id);
        }
        const cached = this.destinationCache.get(userId);
        const visited = new Set(passport.countries.map(c => c.countryCode));

        /*
         * Held for the week, unless they went.
         *
         * A recommendation that changes when you pull to refresh is a slot
         * machine, so a real answer normally stands until the week turns. But
         * arriving is the one thing that has to break it: keeping the card would
         * have gone on offering France as somewhere to go while the grid
         * directly below it showed France stamped, and the card's own gold
         * impression still read NOT YET. Getting there is also the best moment
         * the feature has, and it should end in somewhere new rather than in
         * the app failing to notice.
         *
         * A null answer stands only for the retry window, so it recovers as
         * origins resolve behind it.
         */
        const arrived = !!cached?.result && visited.has(cached.result.countryCode);

        if (cached && cached.week === week && !arrived
            && (cached.result || now < cached.retryAfter))
            return cached.result;
        const mine = this.listenerArtists(history, songs);

        const choice = pickDestination(mine, this.catalogue(), visited, now);

        let result: PassportResult["destination"] = null;

        // Nothing to enrich means nothing was spent, and origins resolving
        // behind this can produce a candidate at any moment -- so that answer
        // is not remembered at all, and the next read gets a fresh look.
        if (!choice)
            return null;

        {
            const filled = await this.withFreshArtists(choice, mine);

            // A destination that cannot name anybody new is not a destination,
            // it is a country. Better to show nothing than a dead end.
            if (filled) {
                const copy = await writeDestinationCopy(filled);

                result = { ...filled, why: copy.text, generated: copy.generated };
            }
        }

        // A candidate that could not be enriched did cost MusicBrainz queries,
        // so that answer is held for a while rather than paid for again on
        // every read.
        this.destinationCache.set(userId, {
            week,
            result,
            retryAfter: result ? 0 : now + DESTINATION_RETRY_MS,
        });

        return result;
    }
}
