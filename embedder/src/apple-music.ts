import { existsSync, readFileSync } from "node:fs";

import jwt from "jsonwebtoken";

import { APPLE_MUSIC_KEY_ID, APPLE_MUSIC_KEY_PATH, APPLE_MUSIC_TEAM_ID } from "./env";
import { SongData } from "./song-data-cache";
import { songIdFor } from "./song-identity";

/**
 * Talking to the Apple Music API.
 *
 * Every request carries two tokens. The developer token is Tempo's, signed here
 * with a MusicKit key, and is the same for everybody. The music user token is
 * the listener's: the app gets one from MusicKit on their device when they link
 * Apple Music, and sends it here. Apple issues no refresh token and no user id —
 * a user token simply stops working one day, and the app sends a new one each
 * time it opens.
 */

const API_BASE = "https://api.music.apple.com";

/**
 * How long a developer token is signed for. Apple allows six months; a shorter
 * one leaks for less long if it ever does, and costs nothing to re-sign.
 */
const DEVELOPER_TOKEN_LIFETIME_S = 30 * 24 * 3600;

/** Re-signed once this much of a token's life is gone, so none handed out is about to expire. */
const DEVELOPER_TOKEN_RENEW_AFTER_S = 20 * 24 * 3600;

export interface AppleMusicConfig {
    keyId: string;
    teamId: string;
    /** The MusicKit .p8 from the developer account. */
    keyPath: string;
}

/** The MusicKit key from the environment, or undefined when Apple Music is not set up. */
export function appleMusicConfigFromEnv(env: {
    APPLE_MUSIC_KEY_ID?: string;
    APPLE_MUSIC_TEAM_ID?: string;
    APPLE_MUSIC_KEY_PATH?: string;
} = {
    APPLE_MUSIC_KEY_ID,
    APPLE_MUSIC_TEAM_ID,
    APPLE_MUSIC_KEY_PATH,
}): AppleMusicConfig | undefined {
    const keyId = env.APPLE_MUSIC_KEY_ID?.trim();
    const teamId = env.APPLE_MUSIC_TEAM_ID?.trim();

    if (!keyId || !teamId)
        return undefined;

    return {
        keyId,
        teamId,
        // Beside the APNs key, named the way Apple names the download
        keyPath: env.APPLE_MUSIC_KEY_PATH?.trim() || `./keys/AuthKey_${keyId}.p8`,
    };
}

export class AppleMusicDeveloperToken {
    private key: string;
    private token?: { value: string; issuedAt: number; expiresAt: number };

    constructor(private config: AppleMusicConfig, private now: () => number = Date.now) {
        if (!existsSync(config.keyPath))
            throw new Error(`MusicKit key not found at ${config.keyPath}`);

        this.key = readFileSync(config.keyPath, "utf8");
    }

    /** The developer token and when it expires, reused until it is getting old. */
    current(): { token: string; expiresAt: number } {
        const nowS = Math.floor(this.now() / 1000);

        if (!this.token || nowS - this.token.issuedAt >= DEVELOPER_TOKEN_RENEW_AFTER_S) {
            const expiresAt = nowS + DEVELOPER_TOKEN_LIFETIME_S;

            const value = jwt.sign({ iss: this.config.teamId, iat: nowS, exp: expiresAt }, this.key, {
                algorithm: "ES256",
                keyid: this.config.keyId,
            });

            this.token = { value, issuedAt: nowS, expiresAt };
        }

        return { token: this.token.value, expiresAt: this.token.expiresAt * 1000 };
    }
}

/**
 * Why a request failed, in the terms that decide what to do next.
 *
 * - "user-token": the listener's token is no longer accepted, and nothing will
 *   work until the app sends a new one.
 * - "rate-limited": Apple's limit is per developer token, so shared by every
 *   listener — back off everybody.
 * - "unavailable": anything else; try again later.
 */
export type AppleMusicFailure = "user-token" | "rate-limited" | "unavailable";

export class AppleMusicError extends Error {
    constructor(public failure: AppleMusicFailure, public status: number, message: string) {
        super(message);
    }
}

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<any>;
}>;

/** A song as the Apple Music API describes it. Only what Tempo reads. */
export interface AppleMusicSongResource {
    id: string;
    type: string;
    attributes?: {
        name?: string;
        artistName?: string;
        albumName?: string;
        durationInMillis?: number;
        isrc?: string;
        contentRating?: string;
        releaseDate?: string;
        artwork?: { url?: string };
        playParams?: { id?: string; catalogId?: string; isLibrary?: boolean };
    };
    relationships?: {
        artists?: { data?: { id: string; attributes?: { name?: string } }[] };
        albums?: { data?: { id: string }[] };
    };
}

export class AppleMusicClient {
    constructor(private developerToken: () => string, private fetchImpl: Fetch = fetch as unknown as Fetch) { }

    private async get(path: string, userToken?: string): Promise<any> {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.developerToken()}` };

        if (userToken)
            headers["Music-User-Token"] = userToken;

        let res: Awaited<ReturnType<Fetch>>;

        try {
            res = await this.fetchImpl(API_BASE + path, { headers });
        } catch (ex) {
            throw new AppleMusicError("unavailable", 0, `Apple Music could not be reached: ${ex}`);
        }

        if (res.ok)
            return res.json();

        // 401 is the developer token, which is ours and is not the listener's
        // fault; 403 is theirs
        if (res.status === 403 && userToken)
            throw new AppleMusicError("user-token", res.status, "Apple Music no longer accepts this listener's token");

        if (res.status === 429)
            throw new AppleMusicError("rate-limited", res.status, "Apple Music is limiting requests");

        throw new AppleMusicError("unavailable", res.status, `Apple Music answered ${res.status} for ${path}`);
    }

    /** The listener's storefront ("us", "gb", …). Also how a user token is checked. */
    async storefront(userToken: string): Promise<string> {
        const body = await this.get("/v1/me/storefront", userToken);
        const id = body?.data?.[0]?.id;

        if (typeof id !== "string" || !/^[a-z]{2}$/.test(id))
            throw new AppleMusicError("unavailable", 200, "Apple Music gave no storefront");

        return id;
    }

    /** The last 30 tracks the listener played, newest first. */
    async recentlyPlayedTracks(userToken: string): Promise<AppleMusicSongResource[]> {
        const body = await this.get("/v1/me/recent/played/tracks?types=songs,library-songs&limit=30", userToken);

        return (Array.isArray(body?.data) ? body.data : []);
    }

    /** Catalog songs with their artists, for the ISRC and artist ids a played track lacks. */
    async catalogSongs(storefront: string, ids: string[]): Promise<AppleMusicSongResource[]> {
        const wanted = ids.filter(id => /^\d{1,20}$/.test(id));

        if (wanted.length === 0 || !/^[a-z]{2}$/.test(storefront))
            return [];

        const songs: AppleMusicSongResource[] = [];

        // The API takes up to 300 ids a request; 30 is all a poll ever has
        for (let i = 0; i < wanted.length; i += 100) {
            const body = await this.get(`/v1/catalog/${storefront}/songs?ids=${wanted.slice(i, i + 100).join(",")}&include=artists`);

            if (Array.isArray(body?.data))
                songs.push(...body.data);
        }

        return songs;
    }
}

/**
 * The catalog id of a played track, or undefined for one only in the
 * listener's library.
 *
 * A song from the catalog is listed under its catalog id; one the listener
 * added to their library is listed under a library id ("i.…") with the catalog
 * id in its play parameters, when it has one. Uploads have none, and cannot be
 * a Tempo song: nobody else could ever open them.
 */
export function catalogIdOf(resource: AppleMusicSongResource): string | undefined {
    const id = (resource.type === "songs" ? resource.id : resource.attributes?.playParams?.catalogId);

    return (typeof id === "string" && /^\d{1,20}$/.test(id) ? id : undefined);
}

/**
 * A played Apple Music track as a Tempo song, or undefined when it cannot be one.
 *
 * @param catalog the same song from the catalog, which is what carries its
 *                ISRC and artist ids; the played track is used where it is absent
 *
 * The ISRC is what makes it the same song as the one Spotify listeners played.
 * Artist ids are Apple's, prefixed so they cannot collide with Spotify's.
 */
export function songDataFromAppleMusic(played: AppleMusicSongResource, catalog: AppleMusicSongResource | undefined, now: number): SongData | undefined {
    const catalogId = catalogIdOf(played);
    const songId = (catalogId ? songIdFor({ service: "appleMusic", id: catalogId }) : undefined);

    if (!catalogId || !songId)
        return undefined;

    const attributes = { ...played.attributes, ...catalog?.attributes };

    if (!attributes.name)
        return undefined;

    const artistResources = catalog?.relationships?.artists?.data ?? [];

    const artists = (artistResources.length > 0
        ? artistResources.map(artist => ({
            id: "am:" + artist.id,
            name: artist.attributes?.name ?? attributes.artistName ?? "",
            url: `https://music.apple.com/us/artist/${artist.id}`,
            uri: "",
        }))
        : [{ id: "", name: attributes.artistName ?? "", url: "", uri: "" }]);

    const releaseDate = (attributes.releaseDate ? new Date(attributes.releaseDate).getTime() : -1);

    return {
        id: songId,
        name: attributes.name,
        artists,
        duration: attributes.durationInMillis ?? 0,
        explicit: attributes.contentRating === "explicit",
        album: {
            id: catalog?.relationships?.albums?.data?.[0]?.id ? "am:" + catalog.relationships.albums.data[0].id : "",
            name: attributes.albumName ?? "",
            releaseDate: (Number.isFinite(releaseDate) ? releaseDate : -1),
            artUrl: attributes.artwork?.url ?? "",
        },
        isrc: attributes.isrc,
        type: "track",
        meta: {
            updatedAt: now,
        },
    };
}
