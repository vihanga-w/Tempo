import { describe, it } from "node:test";
import assert from "node:assert";

import { FAMILIAR_ARTIST_SHARE, FriendPlay, RECENCY_HALF_LIFE_MS, RECENCY_HORIZON_MS, interleaveByFamiliarity, playConfidence, rankFriendCandidates, sharesListeningActivity } from "./friend-discovery";

const NOW = 1_800_000_000_000;

function play(over: Partial<FriendPlay> = {}): FriendPlay {
    return {
        songId: "song",
        artistIds: ["artist"],
        sessionDuration: 1,
        skipped: false,
        replayed: false,
        timestamp: NOW,
        ...over,
    };
}

function listener(songs: string[] = [], artists: string[] = [], affinity?: [string, number][]) {
    return {
        playedSongIds: new Set(songs),
        playedArtistIds: new Set(artists),
        artistAffinity: affinity && new Map(affinity),
    };
}

describe("playConfidence", () => {
    it("counts how much of the track was heard", () => {
        assert.equal(playConfidence({ sessionDuration: 0.4, skipped: false, replayed: false }), 0.4);
    });

    it("counts a replay for more than a play", () => {
        const once = playConfidence({ sessionDuration: 1, skipped: false, replayed: false });
        const twice = playConfidence({ sessionDuration: 1, skipped: false, replayed: true });

        assert.ok(twice > once);
    });

    /*
     * A skip is evidence against the track, but the listener did hear some of
     * it — so it is discounted rather than thrown away, and how much of it
     * played still matters.
     */
    it("discounts a skip without erasing it", () => {
        const value = playConfidence({ sessionDuration: 0.8, skipped: true, replayed: false });

        assert.ok(value > 0);
        assert.ok(value < 0.8);
    });

    it("does not let a bad reading run away", () => {
        assert.equal(playConfidence({ sessionDuration: 4, skipped: false, replayed: false }), 1);
        assert.equal(playConfidence({ sessionDuration: -2, skipped: false, replayed: false }), 0);
    });
});

describe("rankFriendCandidates", () => {
    it("never recommends something the listener has already played", () => {
        const out = rankFriendCandidates(
            [play({ songId: "known" }), play({ songId: "new" })],
            listener(["known"]),
            NOW,
        );

        assert.deepEqual(out.map(c => c.songId), ["new"]);
    });

    /*
     * The whole finding this module rests on. Ranking friends' plays by how
     * recently they happened beat every taste-similarity ranking measured
     * against the real histories, so a track played an hour ago has to outrank
     * one played a day ago even when the older one was played more.
     */
    it("puts what a friend played an hour ago above what they played yesterday", () => {
        const out = rankFriendCandidates(
            [
                play({ songId: "yesterday", timestamp: NOW - 24 * 3600e3, replayed: true }),
                play({ songId: "recent", timestamp: NOW - 3600e3, sessionDuration: 0.5 }),
            ],
            listener(),
            NOW,
        );

        assert.deepEqual(out.map(c => c.songId), ["recent", "yesterday"]);
    });

    it("halves the weight of a play every half-life", () => {
        const [fresh] = rankFriendCandidates([play({ songId: "a" })], listener(), NOW);
        const [old] = rankFriendCandidates(
            [play({ songId: "a", timestamp: NOW - RECENCY_HALF_LIFE_MS })], listener(), NOW);

        assert.ok(Math.abs(old.score - fresh.score / 2) < 1e-9);
    });

    it("ignores anything past the horizon", () => {
        const out = rankFriendCandidates(
            [play({ songId: "ancient", timestamp: NOW - RECENCY_HORIZON_MS - 1 })],
            listener(),
            NOW,
        );

        assert.deepEqual(out, []);
    });

    /*
     * Clock skew between a friend's device and the server can stamp a play a
     * moment in the future. Left alone the decay would raise it above 1 and
     * make a mis-stamped play the top recommendation.
     */
    it("ignores a play stamped in the future rather than rewarding it", () => {
        const out = rankFriendCandidates(
            [play({ songId: "ahead", timestamp: NOW + 60e3 })], listener(), NOW);

        assert.deepEqual(out, []);
    });

    it("adds up two friends playing the same thing", () => {
        const one = rankFriendCandidates([play({ songId: "a" })], listener(), NOW);
        const both = rankFriendCandidates([play({ songId: "a" }), play({ songId: "a" })], listener(), NOW);

        assert.equal(both.length, 1);
        assert.ok(both[0].score > one[0].score);
    });

    it("reports the most recent time anybody played it", () => {
        const [candidate] = rankFriendCandidates(
            [
                play({ songId: "a", timestamp: NOW - 7200e3 }),
                play({ songId: "a", timestamp: NOW - 600e3 }),
            ],
            listener(),
            NOW,
        );

        assert.equal(candidate.lastPlayedAt, NOW - 600e3);
    });

    it("marks whether the listener already knows the artist", () => {
        const out = rankFriendCandidates(
            [
                play({ songId: "familiar", artistIds: ["known", "other"] }),
                play({ songId: "fresh", artistIds: ["nobody"] }),
            ],
            listener([], ["known"]),
            NOW,
        );

        assert.equal(out.find(c => c.songId === "familiar")!.familiarArtist, true);
        assert.equal(out.find(c => c.songId === "fresh")!.familiarArtist, false);
    });

    it("lifts a track by somebody the listener plays a lot", () => {
        const out = rankFriendCandidates(
            [play({ songId: "loved", artistIds: ["favourite"] }), play({ songId: "stranger", artistIds: ["nobody"] })],
            listener([], ["favourite"], [["favourite", 8]]),
            NOW,
        );

        assert.deepEqual(out.map(c => c.songId), ["loved", "stranger"]);
    });

    /*
     * The affinity boost used to be the raw play count, so a heavily played
     * artist could outweigh any amount of recency. Recency is the signal the
     * trial actually measured, so the boost has to stay bounded no matter how
     * many plays back it: a play two half-lives old must not beat a fresh one
     * on affinity alone, however extreme the count.
     */
    it("does not let a huge play count outweigh recency", () => {
        const out = rankFriendCandidates(
            [
                play({ songId: "loved-but-stale", artistIds: ["favourite"], timestamp: NOW - 12 * 3600e3 }),
                play({ songId: "fresh-stranger", artistIds: ["nobody"] }),
            ],
            listener([], ["favourite"], [["favourite", 5000]]),
            NOW,
        );

        assert.deepEqual(out.map(c => c.songId), ["fresh-stranger", "loved-but-stale"]);
    });

    it("still ranks by recency alone when no affinities are supplied", () => {
        const out = rankFriendCandidates(
            [
                play({ songId: "old", artistIds: ["favourite"], timestamp: NOW - 12 * 3600e3 }),
                play({ songId: "new", artistIds: ["nobody"] }),
            ],
            listener([], ["favourite"]),
            NOW,
        );

        assert.deepEqual(out.map(c => c.songId), ["new", "old"]);
    });

    it("orders by something stable when two candidates tie", () => {
        const plays = [play({ songId: "b" }), play({ songId: "a" })];

        assert.deepEqual(
            rankFriendCandidates(plays, listener(), NOW).map(c => c.songId),
            rankFriendCandidates([...plays].reverse(), listener(), NOW).map(c => c.songId),
        );
    });
});

describe("interleaveByFamiliarity", () => {
    const candidate = (songId: string, familiarArtist: boolean) =>
        ({ songId, score: 1, familiarArtist, lastPlayedAt: NOW });

    /*
     * The regression, and the reason this function exists at all. Ranked on one
     * score, familiar artists take the whole of the top of the list and an
     * unfamiliar one never gets seen — which turns the discover half of the
     * feed into more of what the listener already plays.
     */
    it("shows an unfamiliar artist near the top even when familiar ones dominate", () => {
        const out = interleaveByFamiliarity([
            ...Array.from({ length: 40 }, (_, i) => candidate(`familiar${i}`, true)),
            candidate("fresh", false),
        ]);

        assert.ok(out.slice(0, 4).some(c => c.songId === "fresh"),
            `expected an unfamiliar artist in the top four, got ${out.slice(0, 4).map(c => c.songId)}`);
    });

    it("draws from each lane at about the rate it was asked for", () => {
        const out = interleaveByFamiliarity([
            ...Array.from({ length: 100 }, (_, i) => candidate(`familiar${i}`, true)),
            ...Array.from({ length: 100 }, (_, i) => candidate(`fresh${i}`, false)),
        ]);

        const familiar = out.slice(0, 100).filter(c => c.familiarArtist).length;

        assert.ok(Math.abs(familiar - FAMILIAR_ARTIST_SHARE * 100) <= 2,
            `expected about ${FAMILIAR_ARTIST_SHARE * 100} familiar in the first 100, got ${familiar}`);
    });

    it("keeps the order within each lane", () => {
        const out = interleaveByFamiliarity([
            candidate("f1", true), candidate("f2", true), candidate("f3", true),
            candidate("n1", false), candidate("n2", false),
        ]);

        assert.deepEqual(out.filter(c => c.familiarArtist).map(c => c.songId), ["f1", "f2", "f3"]);
        assert.deepEqual(out.filter(c => !c.familiarArtist).map(c => c.songId), ["n1", "n2"]);
    });

    it("loses nothing when one lane runs out first", () => {
        const input = [
            candidate("f1", true), candidate("f2", true), candidate("f3", true),
            candidate("n1", false),
        ];

        assert.equal(interleaveByFamiliarity(input).length, input.length);
    });

    it("copes with a lane that is empty", () => {
        const only = [candidate("f1", true), candidate("f2", true)];

        assert.deepEqual(interleaveByFamiliarity(only).map(c => c.songId), ["f1", "f2"]);
        assert.deepEqual(interleaveByFamiliarity([]), []);
    });
});

describe("sharesListeningActivity", () => {
    /*
     * The feed route filtered on the friends list alone, so a friend who had
     * switched listening activity off still had their history read into Recent
     * activity and, once Discover drew from the same array, into their friends'
     * recommendations. Three other routes asked; this one never did.
     */
    it("allows reading only when the setting is explicitly on", () => {
        assert.equal(sharesListeningActivity({ settings: { shareListeningActivity: true } }), true);
        assert.equal(sharesListeningActivity({ settings: { shareListeningActivity: false } }), false);
    });

    it("treats an account that never answered as not sharing", () => {
        assert.equal(sharesListeningActivity({ settings: {} }), false);
        assert.equal(sharesListeningActivity({}), false);
        assert.equal(sharesListeningActivity(undefined), false);
        assert.equal(sharesListeningActivity(null), false);
    });
});
