import { REQ_USER_AGENT } from "./const";
import { SongData, SongDataCache } from "./song-data-cache";
import { decode } from "he";

// TODO: Store in .env
const API_KEY = "AIzaSyCLJgTKegG2iO-4pQZ71xPKYpfWg6oC-7w"; 

interface YouTubeSearchResult {
    kind: string;
    etag: string;
    nextPageToken: string;
    regionCode: string;
    pageInfo: {
        totalResults: number;
        resultsPerPage: number;
    };
    items: Array<{
        kind: string;
        etag: string;
        id: {
            kind: string;
            videoId: string;
        };
        snippet: {
            publishedAt: string;
            channelId: string;
            title: string;
            description: string;
            channelTitle: string;
            liveBroadcastContent: string;
            publishTime: string;
        };
    }>
};

function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    // increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,    // deletion
                    matrix[i][j - 1] + 1,    // insertion
                    matrix[i - 1][j - 1] + 1 // substitution
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// TODO: Cache this (with dynamic expiration based on release date)
async function fetchYTVideoStats(videoId: string): Promise<{
    viewCount: number;
    likeCount: number | null;
    commentCount: number | null;
    favoriteCount: number | null;
} | null> {
    try {
        const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${API_KEY}`;

        const req = await fetch(url, {
            headers: {
                "User-Agent": REQ_USER_AGENT,
            },
        });

        if (!req.ok) {
            console.error(`YouTube stats request failed with status ${req.status}`);
            return null;
        }

        const data = await req.json();

        if (!data.items || data.items.length === 0) {
            console.warn(`No stats found for video ID: ${videoId}`);
            return null;
        }

        const stats = data.items[0].statistics;

        return {
            viewCount: parseInt(stats.viewCount ?? "0", 10),
            likeCount: stats.likeCount ? parseInt(stats.likeCount, 10) : null,
            commentCount: stats.commentCount ? parseInt(stats.commentCount, 10) : null,
            favoriteCount: stats.favoriteCount ? parseInt(stats.favoriteCount, 10) : null,
        };
    } catch (err) {
        console.error(`Error fetching video stats for ${videoId}:`, err);
        return null;
    }
}

async function lookupYTMusicVideo(song: SongData) {
    const query = `${song.name} - ${song.artists.map(artist => artist.name).join(",")} (Official Music Video)`.replace(/ /g, "+");

    console.log(`Searching for YouTube music video with query: ${query}`);
    
    const req = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&q=${query}&key=${API_KEY}`, {
        headers: {
            "User-Agent": REQ_USER_AGENT,
        },
    });

    if (!req.ok) {
        throw new Error(`YouTube API request failed with status ${req.status}`);
    }

    const data = await req.json() as YouTubeSearchResult;

    if (data.items.length === 0)
        return null;

    const isStandardString = (str: string) => {
        // Check if the string contains only standard characters (no emojis, special characters, etc.)
        
        const isAscii = (str: string): boolean => /^[\x00-\x7F]+$/.test(str);

        // Additional allowed characters
        const allowedChars = "£€$¥$₤¢₨";

        // Dont include the additional allowed characters in the check
        const filteredStr = str.split("").filter(char => !allowedChars.includes(char)).join("");

        return isAscii(filteredStr);
    }

    const isQueryStringStandard = isStandardString(query);

    const musicVideos = (await Promise.all(data.items.map(async item => {
        const sTitle = decode(item.snippet.title.toLowerCase().trim());

        // Check that the title contains "music video"
        if (!sTitle.split(" ").join("").includes("musicvideo") && !sTitle.split(" ").join("").includes("officialvideo"))
            return null;

        // Check that query and result have matching standard string status
        if (isQueryStringStandard !== isStandardString(sTitle))
            return null;

        let matchScore = 0;

        // Count ratio of result title tokens matching query tokens
        const queryTokens = query.toLowerCase().trim().split("+").filter(token => token.length > 0);
        const titleTokens = sTitle.split(" ").filter(token => token.length > 0);

        console.log(`Query tokens: ${queryTokens}, Title tokens: ${titleTokens}`);

        // For each query token, check levenshtein distance to title tokens
        const matchingTokens = queryTokens.filter(queryToken =>
            titleTokens.some(titleToken => {
                const distance = levenshteinDistance(queryToken, titleToken);

                return distance <= Math.max(queryToken.length, titleToken.length) * 0.2; // 20% tolerance
            }
        ));

        const titleMatchRatio = matchingTokens.length / queryTokens.length;

        console.log(`Query: ${query}, Title: ${sTitle}, Matching Ratio: ${titleMatchRatio}`);

        matchScore += titleMatchRatio;

        // Check if the title contains the song name and artist names exactly
        const songNameRegex = new RegExp(`\\b${escapeRegExp(song.name.toLowerCase())}\\b`);
        const songNameMatch = songNameRegex.test(sTitle);
        matchScore += (songNameMatch ? 1 : 0);
        
        if (song.artists.length > 0) {
            const artistIncludes = song.artists.map(a => {
                const artistName = a.name.toLowerCase();
                const artistRegex = new RegExp(`\\b${escapeRegExp(artistName)}\\b`);

                return artistRegex.test(sTitle);
            });

            const artistMatchRatio = artistIncludes.reduce((acc, curr) => acc + (curr ? 1 : 0), 0) / song.artists.length;
            
            // Boost score based on how many artists match
            matchScore += (artistMatchRatio * artistIncludes.filter(v => v).length);
        }

        // Check if channel name is very similar to one of the artists
        const channelName = item.snippet.channelTitle.toLowerCase();
        const unVevoChannelName = channelName.replace(/(vevo|official)/g, "").trim();

        let channelMatchScores: number[] = [];

        for (const artist of song.artists) {
            const artistName = artist.name.toLowerCase();

            const distance = levenshteinDistance(unVevoChannelName, artistName);

            channelMatchScores.push(distance);
        }

        const channelMatch = channelMatchScores.some(score => score <= Math.max(unVevoChannelName.length, song.artists.map(a => a.name.length).reduce((a, b) => Math.max(a, b))) * 0.12);
        matchScore += (channelMatch ? 1 : 0);

        // Heavily promote if channel name is exactly the same as one of the artists
        if (song.artists.some(artist => artist.name.toLowerCase().split(" ").join("") === unVevoChannelName.split(" ").join("")))
            matchScore += 2;

        // Fetch video stats to determine popularity
        const videoId = item.id.videoId;

        // const videoStats = await fetchYTVideoStats(videoId);

        // if (videoStats) {
        //     // Use view count as a proxy for popularity
        //     const viewCount = videoStats.viewCount;

        //     // Scale the match score based on view count
        //     matchScore += Math.log(viewCount + 1) / 10;
        // }

        // Boost score heavily if title contains keyword "official"
        if (sTitle.includes("official"))
            matchScore += 0.75;

        // Boost score if title contains keyword "music video"
        if (sTitle.includes("music video"))
            matchScore += 0.25;

        // Boost if description contains hashtag "#officialmusicvideo" (AW)
        if (item.snippet.description.toLowerCase().includes("#officialmusicvideo") || item.snippet.description.toLowerCase().includes("#officialvideo"))
            matchScore += 0.75;

        // Not as official, but still would rather a music video than a lyric video
        if (item.snippet.description.toLowerCase().includes("#musicvideo"))
            matchScore += 0.35;

        for (const artist of song.artists) {
            // Boost score if description contains links including channel match artist name
            const description = item.snippet.description.toLowerCase();
            const artistNameDescQuery = artist.name.toLowerCase().split(" ").join("");
            const albumNameDescQuery = song.album.name.toLowerCase().split(" ").join("");

            // Extract URLs from description
            const urlRegex = /https?:\/\/[^\s]+/g;
            const urls = description.match(urlRegex) || [];

            console.log(`Checking description for video ${videoId}:`, description, artistNameDescQuery);

            for (const url of urls) {
                // Boost if description contains a lnk.to link
                if (url.includes(".lnk.to/"))
                    matchScore += 0.4;

                const host = new URL(url).hostname.toLowerCase().split("www.").pop() || "";

                if (host == "")
                    continue;

                const hostSections = new URL(url).hostname.toLowerCase().split(".");
                // const pathSections = new URL(url).pathname.toLowerCase().split("/").filter(section => section.length > 0);

                // Check if host contains the artist name
                hostSections.some(section => {
                    const distance = levenshteinDistance(section, artistNameDescQuery);

                    if (distance <= Math.max(section.length, artistNameDescQuery.length) * 0.2) {
                        // Boost is at least 0.5, but increases as match is closer (max 1.0 for perfect match)
                        const closeness = 1 - (distance / Math.max(section.length, artistNameDescQuery.length));
                        const boost = Math.max(0.5, closeness * 1.0);

                        console.log(`Boosting score for video ${videoId} due to artist name in URL host: ${section}, boost: ${boost}`);

                        matchScore += (boost * 1.25);
                        
                        return true;
                    }
                });
            }
        }

        return {
            item,
            matchScore,
            // stats: videoStats,
        };
    }))).filter(s => s !== null)
    // 1st pass sort
    .sort((a, b) => b.matchScore - a.matchScore)
    // Adjust scores for close matchScores based on likeCount difference
    .map((item, idx, arr) => {
        if (idx === 0)
            return item;

        const prev = arr[idx - 1];
        
        // If matchScores are close, adjust score based on likeCount difference
        if (Math.abs(item.matchScore - prev.matchScore) < 0.15) {
            // Check if titles are similar enough
            const itemTitle = decode(item.item.snippet.title.toLowerCase().trim());
            const prevTitle = decode(prev.item.snippet.title.toLowerCase().trim());

            const titleDistance = levenshteinDistance(itemTitle, prevTitle);
            
            if (item.matchScore < prev.matchScore && titleDistance > Math.max(itemTitle.length, prevTitle.length) * 0.25) {
                // Reduce further if item score is lower and titles are not similar enough
                return { ...item, matchScore: item.matchScore - 0.1 };
            } else {
                // Titles are not similar enough, return item as is
                return item;
            }
        }

        return item;
    })
    // 2nd pass sort
    .sort((a, b) => b.matchScore - a.matchScore)
    .map(v => {
        return {
            ...v.item,
            score: v.matchScore,
        }
    });

    if (musicVideos.length === 0)
        return null;

    if (musicVideos.length == 1 && musicVideos[0].score >=8.5)
        return musicVideos[0];

    if (musicVideos[0].score >= 9.5)
        return musicVideos[0];

    return null;
}

export async function findMusicVideo(songId: string, uncachedResolver?: (songId: string) => Promise<SongData | null>) {
    const cache = new SongDataCache();

    const song = (cache.getItem(songId) ?? (uncachedResolver ? await uncachedResolver(songId) : null));

    if (!song) {
        throw new Error(`Song with ID ${songId} not found.`);
    }

    // Scrape music video from youtube api
    const result = await lookupYTMusicVideo(song);

    return result;
}