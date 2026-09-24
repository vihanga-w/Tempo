import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    backfilledLinks,
    ownerOfSpotifyAccount,
    spotifyIdOf,
    tempoIdForNewSpotifyAccount,
    tempoIdOf,
    withSpotifyLinked,
} from "./linked-accounts";

describe("spotifyIdOf", () => {
    it("reads the recorded link", () => {
        assert.equal(spotifyIdOf({ accounts: { spotify: { id: "sp" } }, me: { id: "sp" } }), "sp");
    });

    it("prefers the recorded link to the stored profile", () => {
        assert.equal(spotifyIdOf({ accounts: { spotify: { id: "linked" } }, me: { id: "profile" } }), "linked");
    });

    it("falls back to the profile for an account written before links were recorded", () => {
        assert.equal(spotifyIdOf({ me: { id: "legacy" } }), "legacy");
    });

    it("trusts a profile that agrees with the account's id", () => {
        assert.equal(spotifyIdOf({ me: { id: "sp" }, meta: { serviceId: "sp" } }), "sp");
    });

    it("cannot vouch for a copy of one account holding another user's profile", () => {
        assert.equal(spotifyIdOf({ me: { id: "b" }, meta: { serviceId: "a" } }), undefined);
    });

    it("trusts a recorded link even where the profile disagrees", () => {
        assert.equal(spotifyIdOf({ accounts: { spotify: { id: "a" } }, me: { id: "b" }, meta: { serviceId: "a" } }), "a");
    });

    it("has nothing to say about no account", () => {
        assert.equal(spotifyIdOf(undefined), undefined);
        assert.equal(spotifyIdOf(null), undefined);
        assert.equal(spotifyIdOf({}), undefined);
    });
});

describe("withSpotifyLinked", () => {
    it("links an account with nothing linked", () => {
        assert.deepEqual(withSpotifyLinked(undefined, "sp", 100), { spotify: { id: "sp", linkedAt: 100 } });
    });

    it("keeps the date when the same account is linked again", () => {
        assert.deepEqual(
            withSpotifyLinked({ spotify: { id: "sp", linkedAt: 5 } }, "sp", 100),
            { spotify: { id: "sp", linkedAt: 5 } },
        );
    });

    it("keeps an undated link undated rather than dating it now", () => {
        assert.deepEqual(withSpotifyLinked({ spotify: { id: "sp" } }, "sp", 100), { spotify: { id: "sp" } });
    });

    it("dates a different account from now", () => {
        assert.deepEqual(
            withSpotifyLinked({ spotify: { id: "old", linkedAt: 5 } }, "new", 100),
            { spotify: { id: "new", linkedAt: 100 } },
        );
    });

    it("does not modify what it was given", () => {
        const accounts = { spotify: { id: "old", linkedAt: 5 } };

        withSpotifyLinked(accounts, "new", 100);

        assert.deepEqual(accounts, { spotify: { id: "old", linkedAt: 5 } });
    });
});

describe("backfilledLinks", () => {
    it("records the profile's id, undated, on an account without links", () => {
        assert.deepEqual(
            backfilledLinks({ me: { id: "legacy" }, meta: { serviceId: "legacy" } }),
            { spotify: { id: "legacy" } },
        );
    });

    it("leaves an account that already records its link", () => {
        assert.equal(backfilledLinks({ accounts: { spotify: { id: "sp" } }, me: { id: "sp" }, meta: { serviceId: "sp" } }), undefined);
    });

    it("leaves a copy of one account holding another Spotify user's profile", () => {
        // Written by the old second sign-in as someone else: stored under B,
        // naming A, with B's profile. Linking from it would give A to B.
        assert.equal(backfilledLinks({ me: { id: "b" }, meta: { serviceId: "a" } }), undefined);
    });

    it("leaves an account whose own profile was overwritten by another user's", () => {
        assert.equal(backfilledLinks({ me: { id: "b" }, meta: { serviceId: "a" } }), undefined);
    });

    it("leaves an account that does not record its own id", () => {
        assert.equal(backfilledLinks({ me: { id: "sp" } }), undefined);
    });

    it("has nothing to record without a profile", () => {
        assert.equal(backfilledLinks({}), undefined);
        assert.equal(backfilledLinks({ me: {} }), undefined);
        assert.equal(backfilledLinks(null), undefined);
    });
});

describe("ownerOfSpotifyAccount", () => {
    it("is the account recording the link", () => {
        assert.equal(ownerOfSpotifyAccount("sp", "tempo-1", null), "tempo-1");
    });

    it("prefers the recorded link to an account stored under the Spotify id", () => {
        assert.equal(ownerOfSpotifyAccount("sp", "tempo-1", { me: { id: "sp" } }), "tempo-1");
    });

    it("is the account stored under the Spotify id when nothing records a link", () => {
        // Every account written before links were recorded
        assert.equal(ownerOfSpotifyAccount("sp", undefined, { me: { id: "sp" } }), "sp");
    });

    it("is the account stored under the Spotify id when that account records it", () => {
        assert.equal(ownerOfSpotifyAccount("sp", undefined, { accounts: { spotify: { id: "sp" } } }), "sp");
    });

    it("is nobody when the account under that id is linked to someone else", () => {
        assert.equal(ownerOfSpotifyAccount("sp", undefined, { accounts: { spotify: { id: "other" } } }), undefined);
    });

    it("is nobody when the account under that id is a copy naming another account", () => {
        // Left by the old second sign-in: stored under B, naming A, B's profile
        assert.equal(ownerOfSpotifyAccount("b", undefined, { me: { id: "b" }, meta: { serviceId: "a" } }), undefined);
    });

    it("is nobody when the account under that id holds another user's profile", () => {
        assert.equal(ownerOfSpotifyAccount("a", undefined, { me: { id: "b" }, meta: { serviceId: "a" } }), undefined);
    });

    it("is nobody for a Spotify account Tempo has never seen", () => {
        assert.equal(ownerOfSpotifyAccount("sp", undefined, null), undefined);
    });
});

describe("tempoIdForNewSpotifyAccount", () => {
    it("is still the Spotify id", () => {
        assert.equal(tempoIdForNewSpotifyAccount("sp", false), "sp");
    });

    it("is nothing when another account is stored under that id", () => {
        assert.equal(tempoIdForNewSpotifyAccount("sp", true), undefined);
    });
});

describe("tempoIdOf", () => {
    it("is the account's own record of its id", () => {
        assert.equal(tempoIdOf({ meta: { serviceId: "tempo" }, me: { id: "sp" } }), "tempo");
    });

    it("falls back to the Spotify profile for an account missing that record", () => {
        assert.equal(tempoIdOf({ meta: {}, me: { id: "sp" } }), "sp");
        assert.equal(tempoIdOf({ meta: { serviceId: "" }, me: { id: "sp" } }), "sp");
    });

    it("has nothing to say about no account", () => {
        assert.equal(tempoIdOf(undefined), undefined);
        assert.equal(tempoIdOf({}), undefined);
    });
});
