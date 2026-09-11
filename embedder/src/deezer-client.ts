/**
 * Deezer, asked politely.
 *
 * Where the song vector's metadata comes from: a track by its ISRC, then its
 * album for genres and release date, then its artist for fan count. No key is
 * needed, but the public API allows about fifty requests in five seconds per
 * address, and the preview lookups in deezer-helper.ts spend from the same
 * allowance — so this takes one request every quarter of a second at most and
 * leaves the rest for them.
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
    ) {}

    /** Serialised and spaced. Resolves null rather than throwing. The same chain as MusicBrainzClient's. */
    private schedule<T>(run: () => Promise<T>): Promise<T | null> {
        const queued = this.tail.then(async () => {
            const since = this.now() - this.lastRequestAt;

            if (since < this.minIntervalMs)
                await this.sleep(this.minIntervalMs - since);

            this.lastRequestAt = this.now();

            return run();
        });

        // One failure must not reject every request queued behind it
        this.tail = queued.catch(() => undefined);

        return queued.catch(() => null);
    }

    private async getJson(path: string): Promise<Lookup<unknown>> {
        for (let attempt = 1; attempt <= DEEZER_MAX_ATTEMPTS; attempt++) {
            const retry = attempt < DEEZER_MAX_ATTEMPTS;

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

            // Over the allowance, or busy: the window it counts over has to pass
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
}
