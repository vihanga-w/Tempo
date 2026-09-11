import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Taste, UserTaste, setSongEmbeddingSource } from "./user-taste";

/**
 * Discover's taste picks, fed from a song-embedding source.
 *
 * The real source is the song model over every described song; this hands in a
 * small set of embeddings by hand so the ranking can be read straight off them.
 * What is under test is the seam: that a source replaces the audio-embedding
 * files, and that generateTasteProfile — Tempo's own weighting, untouched —
 * ranks what the listener has not heard by how close it is to what they play.
 */

const NOW = Date.now();

function listenerOf(songId: string): UserTaste {
    const day = new Array(24).fill(0);
    const week = new Array(7).fill(day);

    return {
        songData: { [songId]: { rating: 0, skipCount: 0, playbackCount: 5, replayCount: 1 } },
        history: [{ songId, sessionDuration: 1, skipped: false, replayed: true, timestamp: NOW - 60e3 }],
        streakHistory: [],
        affinityHistory: [],
        tasteEvolution: [],
        hourlyListenershipAggregate: [[week, 0], [week, 0], [week, 0], [week, 0]] as any,
    };
}

describe("taste picks from a song-embedding source", () => {
    it("ranks songs the listener has not heard by closeness to what they play", async () => {
        setSongEmbeddingSource(() => ({ played: [1, 0], near: [0.9, 0.1], far: [0, 1] }));

        try {
            const picks = await new Taste("u1").generateTasteProfile({
                includeListenedMusic: false,
                taste: listenerOf("played"),
            });

            assert.deepEqual(picks.map(p => p.songId), ["near", "far"]);
        } finally {
            setSongEmbeddingSource(null);
        }
    });

    it("gives no picks, rather than failing, before anything has been described", async () => {
        setSongEmbeddingSource(() => ({}));

        try {
            const picks = await new Taste("u1").generateTasteProfile({
                includeListenedMusic: false,
                taste: listenerOf("played"),
            });

            assert.deepEqual(picks, []);
        } finally {
            setSongEmbeddingSource(null);
        }
    });
});
