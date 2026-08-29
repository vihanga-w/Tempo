import { describe, it } from "node:test";
import assert from "node:assert";

import { FAMILIAR_ARTIST_SHARE, FriendCandidate, FriendPlay, MAX_SHARE_PER_FRIEND, RECENCY_HALF_LIFE_MS, RECENCY_HORIZON_MS, interleaveByFamiliarity, playConfidence, rankFriendCandidates, sharesListeningActivity, spreadAcrossFriends } from "./friend-discovery";

const NOW = 1_800_000_000_000;

function play(over: Partial<FriendPlay> = {}): FriendPlay {
    return {
        songId: "song",
        friendId: "friend",
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
    const candidate = (songId: string, familiarArtist: boolean, friendId = "friend") =>
        ({ songId, score: 1, familiarArtist, lastPlayedAt: NOW, friendId });

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

    /*
     * Spreading the combined list and then interleaving does not work: the
     * interleave re-splits by familiarity and draws each lane in order, so a
     * friend who owns one lane still owns it. On the trial group that left one
     * listener at 15 of 20 from a single friend while everyone else improved —
     * they had played little enough that nearly every candidate was unfamiliar
     * and so landed in the same lane.
     */
    it("caps a friend inside each lane, not just across the pair", () => {
        const out = interleaveByFamiliarity([
            ...Array.from({ length: 30 }, (_, i) => candidate(`loudfresh${i}`, false, "loud")),
            ...Array.from({ length: 30 }, (_, i) => candidate(`quietfresh${i}`, false, "quiet")),
        ], 0.65, 20);

        const freshPage = out.slice(0, 20).filter(c => !c.familiarArtist);
        const loud = freshPage.filter(c => c.friendId === "loud").length;

        assert.ok(freshPage.some(c => c.friendId === "quiet"),
            "expected the second friend to reach the unfamiliar lane");
        assert.ok(loud < freshPage.length,
            `expected the lane shared, got all ${loud} from one friend`);
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

describe("spreadAcrossFriends", () => {
    const candidate = (songId: string, friendId: string): FriendCandidate =>
        ({ songId, score: 1, familiarArtist: false, lastPlayedAt: NOW, friendId });

    /*
     * The reason this exists. Over the trial group the flat recency ranking gave
     * one listener 19 of their top 20 from a single friend, and never showed two
     * of their four friends at all — a six hour half-life over a four day window
     * means whoever listened most recently takes everything.
     */
    it("stops one friend taking the whole page when others have material", () => {
        const out = spreadAcrossFriends([
            ...Array.from({ length: 40 }, (_, i) => candidate(`loud${i}`, "loud")),
            ...Array.from({ length: 15 }, (_, i) => candidate(`quiet${i}`, "quiet")),
        ], 20);

        const page = out.slice(0, 20);
        const loud = page.filter(c => c.friendId === "loud").length;

        assert.ok(loud <= 20 * MAX_SHARE_PER_FRIEND,
            `expected at most ${20 * MAX_SHARE_PER_FRIEND} from one friend, got ${loud}`);
    });

    /*
     * The guarantee that survives a starved page. With almost nothing from the
     * other friend the cap cannot hold — the overflow has to come back or the
     * page would be a stub — but the quieter friend must still be seated ahead
     * of it rather than buried under forty of somebody else's plays.
     */
    it("seats every friend before any friend's overflow returns", () => {
        const out = spreadAcrossFriends([
            ...Array.from({ length: 40 }, (_, i) => candidate(`loud${i}`, "loud")),
            candidate("quiet1", "quiet"),
        ], 20);

        const quietAt = out.findIndex(c => c.friendId === "quiet");
        const overflowAt = out.findIndex(c => c.songId === `loud${20 * MAX_SHARE_PER_FRIEND}`);

        assert.ok(quietAt < overflowAt,
            `expected the quieter friend at ${quietAt} to come before the overflow at ${overflowAt}`);
    });

    it("keeps the measured order within a friend", () => {
        const out = spreadAcrossFriends([
            candidate("a1", "a"), candidate("b1", "b"),
            candidate("a2", "a"), candidate("a3", "a"),
        ], 10);

        assert.deepEqual(out.filter(c => c.friendId === "a").map(c => c.songId),
            ["a1", "a2", "a3"]);
    });

    /*
     * Deferred rather than dropped: a listener whose only active friend is one
     * person should still get a full page of their picks, in order.
     */
    it("still fills the page when only one friend has anything", () => {
        const only = Array.from({ length: 30 }, (_, i) => candidate(`s${i}`, "solo"));
        const out = spreadAcrossFriends(only, 20);

        assert.equal(out.length, 30);
        assert.deepEqual(out.map(c => c.songId), only.map(c => c.songId));
    });

    it("seats a second friend even on a page too small to divide", () => {
        const out = spreadAcrossFriends([
            candidate("a1", "a"), candidate("a2", "a"), candidate("a3", "a"),
            candidate("b1", "b"),
        ], 1);

        assert.ok(out.slice(0, 3).some(c => c.friendId === "b"),
            "expected the cap floor to leave room for a second friend");
    });
});
