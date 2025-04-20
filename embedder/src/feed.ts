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

    // Shuffle each type deterministically
    for (const type in grouped) {
        const group = grouped[type as FeedItem["type"]];
        for (let i = group.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [group[i], group[j]] = [group[j], group[i]];
        }
    }

    // Calculate how many items to draw from each type, proportionally
    const totalItems = items.length;
    const allTypes = Object.keys(grouped).filter(t => grouped[t as FeedItem["type"]].length > 0);
    const totalWeight = allTypes.reduce((sum, type) => {
        return sum + (typeProbabilities[type as FeedItem["type"]] ?? 1);
    }, 0);

    const finalFeed: T[] = [];

    // Calculate type quotas based on ratios
    const typeTargets: Record<string, number> = {};
    
    for (const type of allTypes) {
        const weight = typeProbabilities[type as FeedItem["type"]] ?? 1;
        const target = Math.round((weight / totalWeight) * totalItems);
        typeTargets[type] = Math.min(grouped[type as FeedItem["type"]].length, target);
    }

    let typeIndex = 0;
    const typeOrder = allTypes;

    while (finalFeed.length < totalItems) {
        const currentType = typeOrder[typeIndex % typeOrder.length];
        const group = grouped[currentType as FeedItem["type"]];
        if (typeTargets[currentType] > 0 && group.length > 0) {
            finalFeed.push(group.shift()!);
            typeTargets[currentType]--;
        }
        typeIndex++;
        
        if (Object.values(typeTargets).every(count => count <= 0)) break;
    }

    return finalFeed;
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