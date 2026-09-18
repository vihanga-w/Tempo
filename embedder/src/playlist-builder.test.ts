import { describe, it } from "node:test";
import assert from "node:assert";

import {
    ARTIST_CAP, FRIEND_HORIZON_MS, RETURN_GAP_MS, buildPlaylist, dayPart, hourFit, hoursApart, isRecipe,
    type BuildInput, type PlaylistFriendPlay,
} from "./playlist-builder";
import type { UserTaste } from "./user-taste";

const NOW = 1_800_000_000_000;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

type Play = UserTaste["history"][number];

function play(songId: string, at: number, over: Partial<Play> = {}): Play {
    return { songId, timestamp: at, sessionDuration: 1, skipped: false, replayed: false, ...over };
}

function rating(songId: string, at: number, affinity: number) {
    return { songId, timestamp: at, affinity };
}

function friend(songId: string, username: string, at: number, over: Partial<PlaylistFriendPlay> = {}): PlaylistFriendPlay {
    return {
        songId, userId: "u-" + username, username, artistIds: [], timestamp: at,
        sessionDuration: 1, skipped: false, replayed: false, ...over,
    };
}

function input(over: Partial<BuildInput> & { history?: Play[]; ratings?: ReturnType<typeof rating>[] } = {}): BuildInput {
    return {
        taste: { history: over.history ?? [], affinityHistory: over.ratings ?? [] },
        friendPlays: over.friendPlays ?? [],
        artistsOf: over.artistsOf ?? (() => []),
        now: NOW,
        limit: over.limit,
        hourOf: over.hourOf,
        seed: over.seed,
    };
}

const ids = (picks: { songId: string }[]) => picks.map(pick => pick.songId);

/**
 * The liked recipe is the pile only Tempo has: a swipe in Discover never
 * becomes a play. It has to keep the newest likes first, and honour a change
 * of mind in either direction.
 */
describe("liked in Discover", () => {
    it("lists likes, the newest and firmest first", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("old", NOW - 20 * DAY, 5), rating("new", NOW - HOUR, 2), rating("firm", NOW - HOUR, 5)],
        }));

        assert.deepEqual(ids(picks), ["firm", "new", "old"]);
        assert.equal(picks[0].reason.type, "liked");
    });

    it("drops a like that was followed by a pass: the like was wrong", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("s", NOW - 2 * DAY, 4), rating("s", NOW - DAY, -1)],
        }));

        assert.deepEqual(ids(picks), []);
    });

    it("keeps a pass that was followed by a like: a change of mind", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("s", NOW - 2 * DAY, -5), rating("s", NOW - DAY, 3)],
        }));

        assert.deepEqual(ids(picks), ["s"]);
    });

    it("drops a like the listener then skipped almost at once", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("s", NOW - 2 * DAY, 4)],
            history: [play("s", NOW - DAY, { sessionDuration: 0.1, skipped: true })],
        }));

        assert.deepEqual(ids(picks), []);
    });

    it("is not moved by a play that said nothing either way", () => {
        // Half heard and not skipped: neither a yes nor a no, so the like stands
        const picks = buildPlaylist("liked", input({
            ratings: [rating("s", NOW - 2 * DAY, 4)],
            history: [play("s", NOW - DAY, { sessionDuration: 0.5 })],
        }));

        assert.deepEqual(ids(picks), ["s"]);
    });
});

describe("on repeat with friends", () => {
    it("ranks a repeat over a play-through over a partial play, and says who", () => {
        const picks = buildPlaylist("friends", input({
            friendPlays: [
                friend("partial", "Sam", NOW - HOUR, { sessionDuration: 0.5 }),
                friend("through", "Jon", NOW - HOUR),
                friend("repeat", "Maya", NOW - HOUR, { replayed: true }),
            ],
        }));

        assert.deepEqual(ids(picks), ["repeat", "through", "partial"]);
        assert.deepEqual(picks[0].reason, { type: "friend", userId: "u-Maya", username: "Maya", how: "repeat", at: NOW - HOUR, others: 0 });
        assert.equal(picks[1].reason.type === "friend" && picks[1].reason.how, "through");
    });

    it("counts each friend once, however many times they looped it, and counts the others", () => {
        const picks = buildPlaylist("friends", input({
            friendPlays: [
                friend("looped", "Maya", NOW - HOUR), friend("looped", "Maya", NOW - 2 * HOUR), friend("looped", "Maya", NOW - 3 * HOUR),
                friend("shared", "Jon", NOW - HOUR), friend("shared", "Sam", NOW - HOUR),
            ],
        }));

        assert.deepEqual(ids(picks), ["shared", "looped"]);
        assert.equal(picks[0].reason.type === "friend" && picks[0].reason.others, 1);
    });

    it("looks back a week and no further", () => {
        const picks = buildPlaylist("friends", input({
            friendPlays: [friend("stale", "Maya", NOW - FRIEND_HORIZON_MS - HOUR), friend("fresh", "Maya", NOW - DAY)],
        }));

        assert.deepEqual(ids(picks), ["fresh"]);
    });

    it("never includes a song the listener passed on, whoever is playing it", () => {
        const picks = buildPlaylist("friends", input({
            ratings: [rating("s", NOW - DAY, -1)],
            friendPlays: [friend("s", "Maya", NOW - HOUR, { replayed: true })],
        }));

        assert.deepEqual(ids(picks), []);
    });

    it("keeps a song the listener has played themselves: this is what friends are playing, not a recommendation", () => {
        const picks = buildPlaylist("friends", input({
            history: [play("s", NOW - 3 * DAY)],
            friendPlays: [friend("s", "Maya", NOW - HOUR)],
        }));

        assert.deepEqual(ids(picks), ["s"]);
    });
});

describe("songs you came back to", () => {
    it("wants two visits a week or more apart", () => {
        const picks = buildPlaylist("returned", input({
            history: [
                play("back", NOW - RETURN_GAP_MS - DAY), play("back", NOW - HOUR),
                play("binge", NOW - 3 * HOUR), play("binge", NOW - 2 * HOUR), play("binge", NOW - HOUR),
                play("once", NOW - HOUR),
            ],
        }));

        assert.deepEqual(ids(picks), ["back"]);
        assert.deepEqual(picks[0].reason, { type: "returned", days: 2, lastAt: NOW - HOUR });
    });

    it("does not count coming back to skip it again", () => {
        const picks = buildPlaylist("returned", input({
            history: [play("s", NOW - 10 * DAY), play("s", NOW - HOUR, { sessionDuration: 0.1, skipped: true })],
        }));

        assert.deepEqual(ids(picks), []);
    });
});

describe("the mix", () => {
    it("puts a song that is liked and played above one that is only either", () => {
        const picks = buildPlaylist("mix", input({
            ratings: [rating("both", NOW - DAY, 3), rating("liked", NOW - DAY, 3)],
            history: [play("both", NOW - HOUR), play("played", NOW - HOUR)],
        }));

        assert.equal(ids(picks)[0], "both");
        assert.equal(picks.length, 3);
    });

    it("gives the reason the listener would recognise: whichever signal carried the song", () => {
        const picks = buildPlaylist("mix", input({
            ratings: [rating("s", NOW - DAY, 1)],
            friendPlays: [friend("s", "Maya", NOW - HOUR, { replayed: true }), friend("s", "Jon", NOW - HOUR, { replayed: true }), friend("s", "Sam", NOW - HOUR, { replayed: true })],
        }));

        // Three friends on repeat at half weight outweigh one faint like at double
        assert.equal(picks[0].reason.type, "friend");
    });
});

/**
 * The dynamic recipe is the one that answers differently at breakfast and at
 * midnight, so the clock has to be read where the tests can see it: a fixed
 * hour, not the machine's own, or the answers would move with the timezone
 * the suite happened to run in.
 */
describe("right about now", () => {
    /** Clock hours straight off the timestamp, so a test does not depend on where it runs. */
    const hourOf = (at: number) => Math.floor(at / HOUR) % 24;
    const AT_HOUR = hourOf(NOW);

    /** A moment some days back, at a given hour of the clock. */
    const at = (hour: number, daysAgo = 1) => NOW - daysAgo * DAY + (hour - AT_HOUR) * HOUR;

    const build = (over: Partial<BuildInput> & { history?: Play[]; ratings?: ReturnType<typeof rating>[] } = {}) =>
        buildPlaylist("now", input({ hourOf, seed: 1, ...over }));

    it("knows what an hour is worth to another, the short way round the clock", () => {
        assert.equal(hoursApart(23, 1), 2);
        assert.equal(hoursApart(4, 4), 0);
        assert.equal(hourFit(9, 9), 1);
        assert.ok(hourFit(9, 12) > hourFit(9, 18));
        assert.equal(dayPart(AT_HOUR), "morning");
        assert.equal(dayPart(23), "night");
    });

    it("puts what the listener plays at this hour above what they play at another", () => {
        const picks = build({
            history: [
                play("thishour", at(AT_HOUR, 1)), play("thishour", at(AT_HOUR, 2)), play("thishour", at(AT_HOUR, 3)),
                play("otherhour", at(AT_HOUR + 12, 1)), play("otherhour", at(AT_HOUR + 12, 2)), play("otherhour", at(AT_HOUR + 12, 3)),
            ],
        });

        assert.deepEqual(ids(picks), ["thishour", "otherhour"]);
    });

    it("says which part of the day it is theirs in, and how many plays were around now", () => {
        const picks = build({
            history: [play("s", at(AT_HOUR + 1, 3)), play("s", at(AT_HOUR, 1))],
        });

        assert.deepEqual(picks[0].reason, { type: "daypart", part: "morning", plays: 2, lastAt: at(AT_HOUR, 1) });
    });

    it("does not claim an hour it was not played at: a song carried from across the clock says the plain thing", () => {
        const picks = build({
            history: Array.from({ length: 6 }, (_, i) => play("s", at(AT_HOUR + 12, i + 1))),
        });

        assert.equal(picks[0].reason.type, "played");
    });

    it("weighs a friend's play by the hour they played it at", () => {
        const picks = build({
            friendPlays: [friend("now", "Maya", at(AT_HOUR, 1)), friend("later", "Jon", at(AT_HOUR + 12, 1))],
        });

        assert.deepEqual(ids(picks), ["now", "later"]);
    });

    it("takes a like as a like whenever it was made: when somebody swiped says nothing about when they want it", () => {
        const picks = build({ ratings: [rating("liked", at(AT_HOUR + 11, 1), 5)] });

        assert.deepEqual(ids(picks), ["liked"]);
        assert.equal(picks[0].reason.type, "liked");
    });

    it("is the same list twice in a turn, and a different one in the next", () => {
        const history = Array.from({ length: 8 }, (_, i) => play("s" + i, at(AT_HOUR, 1)));

        assert.deepEqual(build({ history, seed: 1 }), build({ history, seed: 1 }));
        assert.notDeepEqual(ids(build({ history, seed: 1 })), ids(build({ history, seed: 2 })));
    });

    it("shuffles the pile without unseating what the listener plainly wants", () => {
        const history = [
            ...Array.from({ length: 10 }, (_, i) => play("favourite", at(AT_HOUR, i + 1))),
            ...Array.from({ length: 8 }, (_, i) => play("s" + i, at(AT_HOUR, i + 1))),
        ];

        for (let seed = 0; seed < 8; seed++)
            assert.equal(ids(build({ history, seed }))[0], "favourite");
    });

    it("keeps a song the listener swiped away out, however the shuffle falls", () => {
        const history = Array.from({ length: 6 }, (_, i) => play("passed", at(AT_HOUR, i + 1)));

        for (let seed = 0; seed < 8; seed++)
            assert.deepEqual(ids(build({ history, ratings: [rating("passed", NOW - HOUR, -1)], seed })), []);
    });
});

describe("every playlist", () => {
    it("keeps no more of one artist than the cap", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("a1", NOW - HOUR, 5), rating("a2", NOW - HOUR, 4), rating("a3", NOW - HOUR, 3), rating("b1", NOW - HOUR, 1)],
            artistsOf: songId => (songId.startsWith("a") ? ["artist-a"] : ["artist-b"]),
        }));

        assert.deepEqual(ids(picks), ["a1", "a2", "b1"]);
        assert.equal(ARTIST_CAP, 2);
    });

    it("stops at the limit", () => {
        const picks = buildPlaylist("liked", input({
            ratings: [rating("a", NOW - HOUR, 5), rating("b", NOW - HOUR, 4), rating("c", NOW - HOUR, 3)],
            limit: 2,
        }));

        assert.equal(picks.length, 2);
    });

    it("is the same list twice", () => {
        const build = () => buildPlaylist("mix", input({
            ratings: [rating("a", NOW - HOUR, 3), rating("b", NOW - HOUR, 3)],
            history: [play("b", NOW - 2 * HOUR), play("a", NOW - 2 * HOUR)],
        }));

        assert.deepEqual(build(), build());
    });

    it("knows its recipes", () => {
        assert.ok(isRecipe("liked") && isRecipe("mix") && isRecipe("now"));
        assert.ok(!isRecipe("random") && !isRecipe(3));
    });
});
