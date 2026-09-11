import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { embedDescribedSongs } from "./song-embeddings";
import type { SongFeatures } from "./song-features";

function record(songId: string, features: SongFeatures | null) {
    return { songId, isrc: "GBAAA2600001", features, gaps: [], attempts: 0, strategy: 2, updatedAt: 0, nextAttemptAt: 0 } as any;
}

const described = (id: number): SongFeatures => ({
    track: {
        id, isrc: null, duration: 200, rank: 1, release_date: null, explicit_lyrics: null,
        explicit_content_lyrics: null, gain: null, bpm: null, contributor_count: 0, album_id: null, artist_id: null,
    },
    album: null,
    artist: null,
});

describe("embedDescribedSongs", () => {
    it("embeds every described song under its Spotify id, and leaves the rest out", () => {
        // A stand-in model, so this checks the bridge rather than the tower
        const model = { embed: (f: SongFeatures) => [f.track.id] };

        const out = embedDescribedSongs([
            record("s1", described(1001)),
            record("s2", null),
            record("s3", described(1003)),
        ], model);

        assert.deepEqual(out, { s1: [1001], s3: [1003] });
    });
});
