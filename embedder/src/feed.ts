import { createHash } from "crypto";
import { SongData } from "./song-data-cache";

export interface FeedItem {
    type: "history" | "discover" | "alert";
    data: {
        userId: string;
        username: string;
        pfpUrl?: string;
        item: {
            track: SongData;
            sessionDuration: number;
            skipped: boolean;
            replayed: boolean;
        };
        timestamp: number;
    } | {
        id: string;
        title: string;
        artists: string[];
        album: string;
        imageUrl: string;
        likeness: number;
    } | {
        alertType: "ListenerTypeChange";
        content: any;
    };
}

export function generateFeedWithSeed<T extends FeedItem>(
    seed: string,
    items: T[],
    options?: {
        typeProbabilities?: Partial<Record<FeedItem["type"], number>>;
    }
): T[] {
    function mulberry32(a: number) {
        return function () {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function stringToSeed(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    const rng = mulberry32(stringToSeed(seed));
    const typeProbabilities = options?.typeProbabilities ?? {};

    // Group by type
    const grouped: Record<FeedItem["type"], T[]> = {
        history: [],
        discover: [],
        alert: []
    };

    for (const item of items) {
        grouped[item.type].push(item);
    }

    // Shuffle each type group independently
    for (const type in grouped) {
        const group = grouped[type as FeedItem["type"]];
        for (let i = group.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [group[i], group[j]] = [group[j], group[i]];
        }
    }

    // Calculate type quotas
    const totalAvailable = Object.values(grouped).reduce((sum, group) => sum + group.length, 0);
    const allTypes = Object.keys(grouped).filter(t => grouped[t as FeedItem["type"]].length > 0);
    const totalWeight = allTypes.reduce((sum, type) => {
        return sum + (typeProbabilities[type as FeedItem["type"]] ?? 1);
    }, 0);

    const selected: T[] = [];

    for (const type of allTypes) {
        const group = grouped[type as FeedItem["type"]];
        const weight = typeProbabilities[type as FeedItem["type"]] ?? 1;
        const count = Math.round((weight / totalWeight) * totalAvailable);
        selected.push(...group.slice(0, count));
    }

    // Final deterministic shuffle of selected pool
    for (let i = selected.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [selected[i], selected[j]] = [selected[j], selected[i]];
    }

    return selected;
}

export function getQuarterHourSeed(entropy?: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const hour = now.getHours();
    const quarter = Math.floor(now.getMinutes() / 15);

    const hash = createHash("sha256").update(`${entropy}-${year}-${month}-${day}-${hour}-Q${quarter}`).digest("hex");

    return hash;
}

export function paginateFeed<T>(feed: T[], page: number, pageSize: number = 20): T[] {
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    return feed.slice(start, end);
}

export function getUserFeed(
    userId: string,
    feedItems: FeedItem[],
    page: number,
    options?: {
        typeProbabilities?: Partial<Record<FeedItem["type"], number>>;
        maxItems?: number;
    }
) {
    const seed = getQuarterHourSeed(userId);
    const itemsPerPage = options?.maxItems ?? 20;

    const feed = paginateFeed<FeedItem>(
        generateFeedWithSeed<FeedItem>(seed, feedItems, {
            ...options,
        }),
        page,
        itemsPerPage
    );

    return feed;
}
/**
 * A number that changes every quarter hour, per account.
 *
 * The same clock generateFeedWithSeed has always shuffled against, exposed for
 * callers that want to rotate something rather than shuffle it. Stable while a
 * listener pages through their feed, moved on by the time they come back — and
 * keyed to the account, so two friends of the same person are not handed the
 * same rotation at the same moment.
 */
export function friendRotationFor(userId: string, at = new Date()): number {
    const quarter = Math.floor(at.getMinutes() / 15);
    const stamp = `${userId}-${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}-${at.getHours()}-Q${quarter}`;

    return parseInt(createHash("sha256").update(stamp).digest("hex").slice(0, 8), 16);
}
