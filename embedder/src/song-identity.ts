/**
 * Which music services a song is on, and how to open it in each.
 *
 * A song's id has always been its Spotify track id, and everything that holds
 * a song — history, taste, playlists, the song cache's file names — holds that.
 * Those ids stay what they are. A song first heard somewhere else needs an id
 * that cannot be mistaken for a Spotify one, so it carries its service in a
 * prefix, and a Spotify id is the one without a prefix.
 *
 * One recording is one song wherever it was played: an Apple Music play of a
 * recording already known from Spotify resolves to the Spotify-keyed song (the
 * song cache's ISRC key does that), and the Apple Music id is recorded on it as
 * a link. So the id says where a song was first heard, and its links say every
 * service it can be opened in.
 */

export type MusicService = "spotify" | "appleMusic";

export const MUSIC_SERVICES: readonly MusicService[] = ["spotify", "appleMusic"];

/** A song's own id on each service it is known to be on. */
export type SongLinks = Partial<Record<MusicService, string>>;

/** A track id on one service. */
export interface ServiceTrack {
    service: MusicService;
    id: string;
}

const APPLE_MUSIC_PREFIX = "am:";

/**
 * Apple Music catalog ids are all digits. A library id ("i.…") names one
 * person's copy rather than the recording, and its dot would split a stored
 * field path, so only a catalog id can become a song.
 */
const APPLE_MUSIC_CATALOG_ID = /^\d{1,20}$/;

/** Spotify's base-62 track and episode ids. */
const SPOTIFY_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * The song id for a track first heard on `service`, or undefined for an id
 * that service does not issue.
 */
export function songIdFor(track: ServiceTrack): string | undefined {
    switch (track.service) {
        case "spotify":
            return (SPOTIFY_ID.test(track.id) ? track.id : undefined);
        case "appleMusic":
            return (APPLE_MUSIC_CATALOG_ID.test(track.id) ? APPLE_MUSIC_PREFIX + track.id : undefined);
    }
}

/** The service a song was first heard on, and its id there. */
export function serviceTrackOf(songId: string): ServiceTrack {
    if (songId.startsWith(APPLE_MUSIC_PREFIX))
        return { service: "appleMusic", id: songId.slice(APPLE_MUSIC_PREFIX.length) };

    return { service: "spotify", id: songId };
}

/**
 * Every service a song can be opened in.
 *
 * Songs written before links were recorded have none stored, and are on the
 * service their id comes from — which for all of them is Spotify.
 */
export function linksOf(song: { id: string; links?: SongLinks }): SongLinks {
    const own = serviceTrackOf(song.id);

    return { [own.service]: own.id, ...song.links };
}

/**
 * `links` with `track` recorded, or `links` itself when that service already
 * has one.
 *
 * An existing link is kept. Spotify gives a music video its own track id, and
 * the video resolves to the same song as the audio release — the audio release
 * is the one to open.
 */
export function withLink(links: SongLinks | undefined, track: ServiceTrack): SongLinks {
    if (links?.[track.service])
        return links;

    return { ...links, [track.service]: track.id };
}

/** Every link in `extra` that `links` lacks, added to `links`. */
export function mergedLinks(links: SongLinks | undefined, extra: SongLinks | undefined): SongLinks {
    let merged: SongLinks = { ...links };

    for (const service of MUSIC_SERVICES) {
        const id = extra?.[service];

        if (id)
            merged = withLink(merged, { service, id });
    }

    return merged;
}

export interface OpenLink {
    /** Opens the service's app directly. */
    app: string;
    /** Opens the app where it is installed, and the web player where not. */
    web: string;
}

/**
 * Where to open a track on its service.
 *
 * Apple Music's links name a storefront, and any storefront's link opens in the
 * listener's own — so a fixed one does, until the listener's is known.
 */
export function openLinkFor(track: ServiceTrack, kind: "track" | "episode" = "track"): OpenLink {
    switch (track.service) {
        case "spotify":
            return {
                app: `spotify://${kind}/${track.id}`,
                web: `https://open.spotify.com/${kind}/${track.id}`,
            };
        case "appleMusic":
            return {
                app: `music://music.apple.com/us/song/${track.id}`,
                web: `https://music.apple.com/us/song/${track.id}`,
            };
    }
}

/** Where to open a song on every service it is on. */
export function openLinksOf(song: { id: string; links?: SongLinks; type?: "track" | "episode" }): Partial<Record<MusicService, OpenLink>> {
    const links = linksOf(song);
    const open: Partial<Record<MusicService, OpenLink>> = {};

    for (const service of MUSIC_SERVICES) {
        const id = links[service];

        if (id)
            open[service] = openLinkFor({ service, id }, song.type ?? "track");
    }

    return open;
}
