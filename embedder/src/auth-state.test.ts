import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    AccountState,
    accountNeedsSignIn,
    isDeadCredentialsError,
    stateAfterSuccessfulRead,
} from "./auth-state";

/**
 * Both directions of this have been wrong in production, and each failure was
 * invisible: an account that needed a sign-in was told it was fine and sat on a
 * loading screen, and an account that was fine went on demanding a sign-in it
 * did not need. Neither logs anything, so the tests are the only thing that
 * notices.
 */
describe("accountNeedsSignIn", () => {
    it("says nothing is needed for an account with no record", () => {
        assert.equal(accountNeedsSignIn(undefined), false);
    });

    it("needs a sign-in when a refresh has failed", () => {
        assert.equal(accountNeedsSignIn({ meta: { state: "reauth" }, data: { refreshToken: "r" } }), true);
    });

    it("needs a sign-in for an enrolment that never finished", () => {
        // Written by enrolment and abandoned: real account, no token
        assert.equal(accountNeedsSignIn({ meta: { state: "unauth" }, data: {} }), true);
    });

    it("leaves an account mid-enrolment alone once it holds a token", () => {
        // The window between the token arriving and the state being promoted
        assert.equal(accountNeedsSignIn({ meta: { state: "unauth" }, data: { refreshToken: "r" } }), false);
    });

    it("does not ask a working account to sign in", () => {
        assert.equal(accountNeedsSignIn({ meta: { state: "authvalid" }, data: { refreshToken: "r" } }), false);
    });

    it("does not ask because Spotify itself is unwell", () => {
        // srverr is about Spotify, not about this account's credentials
        assert.equal(accountNeedsSignIn({ meta: { state: "srverr" }, data: { refreshToken: "r" } }), false);
    });
});

describe("isDeadCredentialsError", () => {
    it("recognises a deleted app reported by the library", () => {
        // The shape spotify-web-api-node throws
        assert.equal(isDeadCredentialsError({
            statusCode: 400,
            body: { error: "invalid_client", error_description: "Invalid client" },
        }), true);
    });

    it("recognises a deleted app reported by the fallback strategy", () => {
        // The shape spotify-methods attaches
        assert.equal(isDeadCredentialsError(
            Object.assign(new Error("Invalid response from Spotify API, code: 400 (invalid_client)"),
                { spotifyError: "invalid_client", statusCode: 400 })), true);
    });

    it("recognises a revoked refresh token", () => {
        assert.equal(isDeadCredentialsError({ statusCode: 400, body: { error: "invalid_grant" } }), true);
    });

    it("does not treat a rate limit as dead credentials", () => {
        // Costing somebody their session over a 429 is the failure this guards
        assert.equal(isDeadCredentialsError({ statusCode: 429, body: { error: "too_many_requests" } }), false);
    });

    it("does not treat a Spotify outage as dead credentials", () => {
        assert.equal(isDeadCredentialsError({ statusCode: 503 }), false);
    });

    it("does not treat a network failure as dead credentials", () => {
        assert.equal(isDeadCredentialsError(new Error("fetch failed")), false);
    });

    it("survives being handed nothing", () => {
        assert.equal(isDeadCredentialsError(undefined), false);
        assert.equal(isDeadCredentialsError(null), false);
        assert.equal(isDeadCredentialsError("invalid_client"), false);
    });

    it("does not match a different 400", () => {
        assert.equal(isDeadCredentialsError({ statusCode: 400, body: { error: "invalid_request" } }), false);
    });
});

describe("stateAfterSuccessfulRead", () => {
    it("clears a sign-in prompt from an account that answers", () => {
        assert.equal(stateAfterSuccessfulRead("reauth"), "authvalid");
    });

    it("clears a server-error state once Spotify answers again", () => {
        assert.equal(stateAfterSuccessfulRead("srverr"), "authvalid");
    });

    it("leaves a working account untouched, so nothing is written", () => {
        assert.equal(stateAfterSuccessfulRead("authvalid"), undefined);
    });

    it("does not promote an account that has not finished enrolling", () => {
        // "unauth" is cleared by finishing the sign-in, never by a stray read
        assert.equal(stateAfterSuccessfulRead("unauth"), undefined);
    });

    it("leaves an unknown or missing state alone", () => {
        assert.equal(stateAfterSuccessfulRead(undefined), undefined);
        assert.equal(stateAfterSuccessfulRead("something-new"), undefined);
    });

    it("agrees with accountNeedsSignIn: what it clears is what was blocking", () => {
        // The two have to stay in step. Any state this promotes must be one the
        // other would otherwise have kept asking about, or an account could be
        // promoted while still being told to sign in.
        const states: (AccountState | string)[] = ["unauth", "authvalid", "reauth", "srverr"];

        for (const state of states) {
            const promoted = stateAfterSuccessfulRead(state);

            if (!promoted)
                continue;

            assert.equal(
                accountNeedsSignIn({ meta: { state: promoted }, data: { refreshToken: "r" } }),
                false,
                `clearing ${state} left the account still asking for a sign-in`);
        }
    });
});
