/**
 * Every described song, as the song model sees it.
 *
 * The bridge between the metadata the fetcher gathers (song-feature-service.ts)
 * and the embeddings Discover ranks with (user-taste.ts). Each song with a
 * description goes through the model. One Deezer never matched has none and is
 * simply not a candidate — as a song the old audio catalogue lacked was not.
 *
 * A song with gaps is still embedded: the vector carries a presence bit for
 * everything that can be missing, and the model was trained on songs with gaps.
 */

import type { SongFeatureRecord } from "./song-feature-store";
import type { SongModel } from "./song-model";

export function embedDescribedSongs(
    records: Iterable<SongFeatureRecord>,
    model: Pick<SongModel, "embed">,
): { [songId: string]: number[] } {
    const out: { [songId: string]: number[] } = {};

    for (const record of records) {
        if (record.features)
            out[record.songId] = model.embed(record.features);
    }

    return out;
}
