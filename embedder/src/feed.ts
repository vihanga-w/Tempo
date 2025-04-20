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
        maxItems?: number; // total feed size
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
    const maxItems = options?.maxItems ?? items.length;

    // Global shuffle to randomize items before grouping
    const shuffledItems = [...items];
    for (let i = shuffledItems.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffledItems[i], shuffledItems[j]] = [shuffledItems[j], shuffledItems[i]];
    }

    // Group by type and user
    const grouped: Record<string, Record<string, T[]>> = {};
    for (const item of shuffledItems) {
        if (!grouped[item.type]) grouped[item.type] = {};
        const userGroup = grouped[item.type];
        const userId = (item.data as any).userId || "unknown";
        if (!userGroup[userId]) userGroup[userId] = [];
        userGroup[userId].push(item);
    }

    // Normalize type weights
    const allTypes = Object.keys(grouped);
    const totalWeight = allTypes.reduce((sum, type) => {
        return sum + (typeProbabilities[type as FeedItem["type"]] ?? 1.0);
    }, 0);

    // Determine how many items to include from each type
    const selected: T[] = [];
    for (const type of allTypes) {
        const group = Object.values(grouped[type]).flat();
        const weight = typeProbabilities[type as FeedItem["type"]] ?? 1.0;
        const targetCount = Math.min(group.length, Math.round((weight / totalWeight) * maxItems));

        // Deterministically shuffle and select targetCount items
        const tempGroup = [...group];
        for (let i = tempGroup.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [tempGroup[i], tempGroup[j]] = [tempGroup[j], tempGroup[i]];
        }

        selected.push(...tempGroup.slice(0, targetCount));
    }

    // Flatten grouped items into queues for interleaving
    const typeQueues = Object.values(grouped).flatMap(typeGroup =>
        Object.values(typeGroup).map(userGroup => [...userGroup])
    );

    const interleaved: T[] = [];
    let queueIndex = 0;

    while (interleaved.length < selected.length) {
        const queue = typeQueues[queueIndex];

        if (queue && queue.length > 0) {
            interleaved.push(queue.shift()!);
        }

        queueIndex = (queueIndex + 1) % typeQueues.length;
    }

    return interleaved.slice(0, maxItems);
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
            maxItems: itemsPerPage,
        }),
        page,
        itemsPerPage
    );

    return feed;
}