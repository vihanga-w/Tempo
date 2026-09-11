/**
 * Thirty-second previews, by ISRC.
 *
 * Asked of Deezer through an interactive DeezerClient, which shares the
 * process's Deezer budget with the metadata fetcher (see deezer-client.ts). A
 * feed page's previews go at once and ask once, and a preview that cannot be
 * had right now is left off rather than holding the page up — which is also
 * what happened before whenever a lookup failed.
 *
 * Previews used to be fetched here directly, with no limit on how many at once,
 * and a Deezer error (which arrives as a 200 with an error body) went unread.
 */

import type { FetchLike } from "./artist-origin";
import { DeezerClient } from "./deezer-client";

type PreviewLookup = Pick<DeezerClient, "previewByIsrc">;

let client: PreviewLookup | null = null;

/** The client previews are asked through. Set at startup, so they share the fetcher's budget. */
export function usePreviewClient(lookup: PreviewLookup) {
    client = lookup;
}

const previewsCache: { [isrc: string]: { exp: number; url: string } } = {};

/** When a signed preview URL lapses, from its exp= parameter (seconds), or null. */
export function previewExpiry(url: string): number | null {
    const match = /exp=(\d+)/.exec(url);

    return match ? parseInt(match[1], 10) * 1e3 : null;
}

export async function getPreviewWithISRC(isrc: string): Promise<string | null> {
    const cached = previewsCache[isrc];

    // Not the last thirty seconds: a URL handed out then could lapse before it plays
    if (cached && Date.now() < cached.exp - 30e3)
        return cached.url;

    // Without one set (a script, a test), a client of its own — still one that never waits
    client ??= new DeezerClient(fetch as unknown as FetchLike, 0, undefined, undefined, undefined, null, "interactive");

    try {
        const url = await client.previewByIsrc(isrc);

        if (!url)
            return null;

        const exp = previewExpiry(url);

        if (exp)
            previewsCache[isrc] = { exp, url };

        return url;
    } catch (ex) {
        console.warn("Failed to fetch track preview from Deezer, error:", ex, "isrc:", isrc);

        return null;
    }
}
