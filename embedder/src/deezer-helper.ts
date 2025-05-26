import { REQ_USER_AGENT } from "./const"

interface DeezerTrack {
    id: number
    readable: boolean
    title: string
    title_short: string
    title_version: string
    isrc: string
    link: string
    share: string
    duration: number
    track_position: number
    disk_number: number
    rank: number
    release_date: string
    explicit_lyrics: boolean
    explicit_content_lyrics: number
    explicit_content_cover: number
    preview?: string
    bpm: number
    gain: number
    available_countries: Array<string>
    contributors: Array<{
        id: number
        name: string
        link: string
        share: string
        picture: string
        picture_small: string
        picture_medium: string
        picture_big: string
        picture_xl: string
        radio: boolean
        tracklist: string
        type: string
        role: string
    }>
    md5_image: string
    track_token: string
    artist: {
        id: number
        name: string
        link: string
        share: string
        picture: string
        picture_small: string
        picture_medium: string
        picture_big: string
        picture_xl: string
        radio: boolean
        tracklist: string
        type: string
    }
    album: {
        id: number
        title: string
        link: string
        cover: string
        cover_small: string
        cover_medium: string
        cover_big: string
        cover_xl: string
        md5_image: string
        release_date: string
        tracklist: string
        type: string
    }
    type: string
};

let previewsCache: {[key: string]: {
    exp: number;
    url: string;
}} = {};

export async function getDeezerTrackWithISRC(isrc: string) {
    const url = `https://api.deezer.com/2.0/track/isrc:${isrc}`;

    const req = await fetch(url, {
        headers: {
            "User-Agent": REQ_USER_AGENT,
        }
    });
    const res = await req.json() as DeezerTrack;

    if (res.preview && res.preview.includes("exp=")) {
        previewsCache[isrc] = {
            exp: parseInt(res.preview.split("exp=")[1].split("~")[0]) * 1e3,
            url: res.preview,
        };
    }

    return res;
}

export async function getPreviewWithISRC(isrc: string) {
    // Check cache before sending request
    if (previewsCache[isrc] && Date.now() < previewsCache[isrc].exp - 30e3)
        return previewsCache[isrc].url;

    try {
        const track = await getDeezerTrackWithISRC(isrc);

        if (track.preview)
            return track.preview;

        return null;
    } catch (ex) {
        console.warn("Failed to fetch track preview from Deezer, error:", ex, "isrc:", isrc);

        return null;
    }
}