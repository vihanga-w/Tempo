import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Friendship, rankFriendSuggestions } from "./friend-suggestions";

/**
 * The exclusions are the dangerous part here, not the ordering.
 *
 * Suggesting somebody you are already friends with, or have already asked, or
 * have blocked, reads as the app not having noticed what you did — and none of
 * that can be checked against a database with two accounts in it.
 */
describe("rankFriendSuggestions", () => {
    const ME = "me";

    const between = (a: string, b: string, state = "friends"): Friendship =>
        ({ u1Id: a, u2Id: b, state });

    it("suggests a friend's friend", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex")],
            new Map([["alex", [between("alex", ME), between("alex", "sam")]]]),
        );

        assert.deepEqual(result.map(v => v.userId), ["sam"]);
    });

    it("ranks by how many friends you have in common", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex"), between(ME, "jo"), between(ME, "kit")],
            new Map([
                ["alex", [between("alex", "sam")]],
                ["jo", [between("jo", "sam"), between("jo", "riley")]],
                ["kit", [between("kit", "sam")]],
            ]),
        );

        // sam through three friends, riley through one
        assert.deepEqual(result.map(v => v.userId), ["sam", "riley"]);
        assert.equal(result[0].mutualFriends.length, 3);
        assert.equal(result[1].mutualFriends.length, 1);
    });

    it("never suggests you to yourself", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex")],
            new Map([["alex", [between("alex", ME)]]]),
        );

        assert.deepEqual(result, []);
    });

    it("never suggests somebody you are already friends with", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex"), between(ME, "sam")],
            new Map([["alex", [between("alex", "sam")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("never suggests somebody you have already asked", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex"), between(ME, "sam", "request")],
            new Map([["alex", [between("alex", "sam")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("never suggests somebody whose request is waiting on you", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex"), between("sam", ME, "request")],
            new Map([["alex", [between("alex", "sam")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("never suggests somebody blocked", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex"), between(ME, "sam", "blocked")],
            new Map([["alex", [between("alex", "sam")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("does not walk through a friendship that is not one", () => {
        // A request you have sent is not a friend, so their friends are not
        // friends of a friend
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex", "request")],
            new Map([["alex", [between("alex", "sam")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("does not arrive at somebody through a friendship they have not accepted", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex")],
            new Map([["alex", [between("alex", "sam", "request")]]]),
        );

        assert.deepEqual(result, []);
    });

    it("counts each mutual once, however the friendship is stored", () => {
        // u1/u2 order is whoever asked, so the same pair can be either way round
        const result = rankFriendSuggestions(
            ME,
            [between("alex", ME), between(ME, "jo")],
            new Map([
                ["alex", [between("sam", "alex")]],
                ["jo", [between("jo", "sam")]],
            ]),
        );

        assert.equal(result.length, 1);
        assert.equal(result[0].userId, "sam");
        assert.equal(result[0].mutualFriends.length, 2);
    });

    it("holds a stable order when two people are equally connected", () => {
        const graph = () => rankFriendSuggestions(
            ME,
            [between(ME, "alex")],
            new Map([["alex", [between("alex", "sam"), between("alex", "riley")]]]),
        );

        assert.deepEqual(graph().map(v => v.userId), graph().map(v => v.userId));
    });

    it("honours the limit", () => {
        const result = rankFriendSuggestions(
            ME,
            [between(ME, "alex")],
            new Map([["alex", ["a", "b", "c", "d"].map(v => between("alex", v))]]),
            2,
        );

        assert.equal(result.length, 2);
    });
});
