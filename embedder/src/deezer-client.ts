/**
 * Deezer, asked politely.
 *
 * Where the song vector's metadata comes from: a track by its ISRC, then its
 * album for genres and release date, then its artist for fan count. No key is
 * needed, but the public API allows about fifty requests in five seconds per
 * address, and the preview lookups in deezer-helper.ts spend from the same
 * allowance. So the two share a DeezerBudget: the fetcher takes one request
 * every quarter of a second at most and never the last half of the budget, and
 * a feed page's previews burst into what is left.
 *
 * Deezer answers most failures with HTTP 200 and an `error` object in the body,
 * so the status alone says nothing. The body decides between the three outcomes
 * a caller cares about: found; missing, which for a new release usually means
 * "not yet"; and failed, which means "ask again soon".
 */

import { REQ_USER_AGENT } from "./const";
import type { FetchLike } from "./artist-origin";
import {
    Lookup, DeezerTrackFields, DeezerAlbumFields, DeezerArtistFields,
    parseDeezerTrack, parseDeezerAlbum, parseDeezerArtist, isValidIsrc,
} from "./song-features";

export const DEEZER_BASE = "https://api.deezer.com/2.0";

/** A fifth of Deezer's allowance, so previews are never starved by this. */
export const DEEZER_MIN_INTERVAL_MS = 250;

/** How many times a busy or rate-limited answer is retried before giving up for now. */
export const DEEZER_MAX_ATTEMPTS = 3;

/** Deezer counts its allowance over five seconds, so any shorter wait just spends an attempt. */
export const DEEZER_QUOTA_BACKOFF_MS = 5000;

/**
 * How long a request may go unanswered.
 *
 * Without a deadline, a connection Deezer accepts and never answers holds the
 * fetcher's one lookup for ever, and every tick after it finds the fetcher
 * busy. Aborted, the request takes the network-failure path and is retried.
 */
export const DEEZER_TIMEOUT_MS = 15_000;

/** Deezer's own error codes, as they arrive in the body of a 200. */
export const DEEZER_ERROR = {
    /** "Quota limit exceeded". */
    QUOTA: 4,
    /** "Service busy". */
    BUSY: 700,
    /** "no data": asked about something Deezer does not have. */
    NO_DATA: 800,
} as const;

function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/** Deezer's allowance per address: fifty requests in any five seconds. */
export const DEEZER_BUDGET_LIMIT = 50;
export const DEEZER_BUDGET_WINDOW_MS = 5000;

/** How much of the allowance the background fetcher always leaves for somebody waiting. */
export const BACKGROUND_RESERVE = 25;

/**
 * Deezer's allowance, shared by everything in the process that asks it.
 *
 * Counted the way Deezer counts it: every request of the last five seconds,
 * and never more than fifty of them. A bucket that refills as it goes lets a
 * burst of fifty through and then more straight after it, which is over the
 * limit within the same five seconds.
 *
 * Two kinds of caller share it and are not alike: a feed page wants a dozen
 * previews at once with somebody waiting on them, while the metadata fetcher
 * can wait all day. So the fetcher never takes the last half of the window, and
 * a page's previews can always burst into it.
 */
export class DeezerBudget {
    /** When each request of the current window went, oldest first. */
    private sent: number[] = [];
    private blockedUntil = 0;

    constructor(
        private limit: number = DEEZER_BUDGET_LIMIT,
        private windowMs: number = DEEZER_BUDGET_WINDOW_MS,
        private now: () => number = () => Date.now(),
        private sleep: (ms: number) => Promise<void> =
            ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) {}

    /** Forgets requests that have left the window. */
    private prune(now: number) {
        let expired = 0;

        while (expired < this.sent.length && this.sent[expired] <= now - this.windowMs)
            expired++;

        if (expired > 0)
            this.sent.splice(0, expired);
    }

    get available(): number {
        const now = this.now();

        this.prune(now);

        return now < this.blockedUntil ? 0 : this.limit - this.sent.length;
    }

    /** Resolves when a request may go, leaving `reserve` of the allowance to others. */
    async take(reserve = 0): Promise<void> {
        // A reserve of the whole allowance would never let anything through
        const allowed = Math.max(1, this.limit - reserve);

        for (;;) {
            const now = this.now();

            this.prune(now);

            if (now < this.blockedUntil) {
                await this.sleep(this.blockedUntil - now);

                continue;
            }

            if (this.sent.length < allowed) {
                this.sent.push(now);

                return;
            }

            // Until enough of the oldest have left the window to make room for one
            const oldest = this.sent[this.sent.length - allowed];

            await this.sleep(Math.max(1, oldest + this.windowMs - now));
        }
    }

    /** A request that may go now, or false: for callers who would rather do without than wait. */
    tryTake(): boolean {
        const now = this.now();

        this.prune(now);

        if (now < this.blockedUntil || this.sent.length >= this.limit)
            return false;

        this.sent.push(now);

        return true;
    }

    /** Deezer says the allowance is spent: nobody goes until its window has passed. */
    drain(windowMs: number) {
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + windowMs);
    }
}

/**
 * How a client asks.
 *
 * "background" queues, keeps its gap, retries, and leaves BACKGROUND_RESERVE of
 * a shared budget alone. "interactive" is for somebody waiting: it does not
 * queue, asks once, and gives up at once rather than wait on the budget — a
 * missing preview is better than a slow page.
 */
export type DeezerMode = "background" | "interactive";

export class DeezerClient {
    private tail: Promise<unknown> = Promise.resolve();
    private lastRequestAt = 0;

    constructor(
        private fetchImpl: FetchLike,
        private minIntervalMs: number = DEEZER_MIN_INTERVAL_MS,
        private sleep: (ms: number) => Promise<void> =
            ms => new Promise(resolve => setTimeout(resolve, ms)),
        private now: () => number = () => Date.now(),
        private quotaBackoffMs: number = DEEZER_QUOTA_BACKOFF_MS,
        private timeoutMs: number = DEEZER_TIMEOUT_MS,
        private budget: DeezerBudget | null = null,
        private mode: DeezerMode = "background",
    ) {}

    /** Serialised and spaced. Resolves null rather than throwing. The same chain as MusicBrainzClient's. */
    private schedule<T>(run: () => Promise<T>): Promise<T | null> {
        // Somebody is waiting: no queue, and no waiting on the budget either
        if (this.mode === "interactive") {
            if (this.budget && !this.budget.tryTake())
                return Promise.resolve(null);

            return run().catch(() => null);
        }

        const queued = this.tail.then(async () => {
            const since = this.now() - this.lastRequestAt;

            if (since < this.minIntervalMs)
                await this.sleep(this.minIntervalMs - since);

            await this.budget?.take(BACKGROUND_RESERVE);

            this.lastRequestAt = this.now();

            return run();
        });

        // One failure must not reject every request queued behind it
        this.tail = queued.catch(() => undefined);

        return queued.catch(() => null);
    }

    private async getJson(path: string): Promise<Lookup<unknown>> {
        const attempts = this.mode === "interactive" ? 1 : DEEZER_MAX_ATTEMPTS;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const retry = attempt < attempts;

            const response = await this.schedule(() => this.fetchImpl(`${DEEZER_BASE}${path}`, {
                headers: {
                    "User-Agent": REQ_USER_AGENT,
                    "Accept": "application/json",
                },
                signal: AbortSignal.timeout(this.timeoutMs),
            }));

            // Thrown: the network, not Deezer. Worth another go.
            if (!response) {
                if (retry)
                    await this.sleep(this.minIntervalMs * attempt);

                continue;
            }

            if (response.status === 404)
                return { kind: "missing" };

            if (!response.ok) {
                if (!isRetryableStatus(response.status))
                    return { kind: "failed" };

                if (retry)
                    await this.sleep(this.minIntervalMs * attempt);

                continue;
            }

            let body: any;

            try {
                body = await response.json();
            } catch {
                return { kind: "failed" };
            }

            if (!body?.error)
                return { kind: "found", value: body };

            const code = body.error.code;

            if (code === DEEZER_ERROR.NO_DATA)
                return { kind: "missing" };

            if (code !== DEEZER_ERROR.QUOTA && code !== DEEZER_ERROR.BUSY)
                return { kind: "failed" };

            // Over the allowance, or busy: the window it counts over has to pass,
            // for everybody sharing the budget and not only for this request
            this.budget?.drain(this.quotaBackoffMs);

            if (retry)
                await this.sleep(this.quotaBackoffMs);
        }

        return { kind: "failed" };
    }

    private async lookup<T>(path: string, parse: (body: unknown) => T | null): Promise<Lookup<T>> {
        const answer = await this.getJson(path);

        if (answer.kind !== "found")
            return answer;

        const parsed = parse(answer.value);

        // An answer without an id is not the thing that was asked about
        return parsed ? { kind: "found", value: parsed } : { kind: "missing" };
    }

    /** A track by its ISRC, which is how Spotify's tracks are matched to Deezer's. */
    trackByIsrc(isrc: string): Promise<Lookup<DeezerTrackFields>> {
        if (!isValidIsrc(isrc))
            return Promise.resolve({ kind: "missing" });

        return this.lookup(`/track/isrc:${encodeURIComponent(isrc.toUpperCase())}`, parseDeezerTrack);
    }

    album(id: number): Promise<Lookup<DeezerAlbumFields>> {
        if (!Number.isSafeInteger(id) || id <= 0)
            return Promise.resolve({ kind: "missing" });

        return this.lookup(`/album/${id}`, parseDeezerAlbum);
    }

    artist(id: number): Promise<Lookup<DeezerArtistFields>> {
        if (!Number.isSafeInteger(id) || id <= 0)
            return Promise.resolve({ kind: "missing" });

        return this.lookup(`/artist/${id}`, parseDeezerArtist);
    }

    /**
     * A track's thirty-second preview, by ISRC, or null.
     *
     * The URL is signed and expires, so it is never kept with a song's
     * description; deezer-helper.ts caches it until just before it lapses.
     */
    async previewByIsrc(isrc: string): Promise<string | null> {
        if (!isValidIsrc(isrc))
            return null;

        const answer = await this.getJson(`/track/isrc:${encodeURIComponent(isrc.toUpperCase())}`);
        const preview = answer.kind === "found" ? (answer.value as any)?.preview : null;

        return (typeof preview === "string" && preview.length > 0) ? preview : null;
    }
}
