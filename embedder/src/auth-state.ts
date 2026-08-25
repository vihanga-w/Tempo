/**
 * When an account needs its owner to sign in again, and when it stops needing to.
 *
 * These three decisions were made inline, in the middle of a nine-thousand line
 * module that cannot be imported without starting a server, so none of them
 * could be tested and two of them were wrong for a long time. They are pure
 * functions of their arguments, and live here so a test can reach them.
 */

/** The states an account's `meta.state` can hold. */
export type AccountState = "unauth" | "authvalid" | "reauth" | "srverr";

export interface AccountLike {
    meta?: { state?: AccountState | string };
    data?: { refreshToken?: string };
}

/**
 * Does this account need the person to sign in again before it can do anything?
 *
 * "reauth" is set when a refresh fails, and was for a long time the only state
 * treated as needing attention. It is not the only one that does.
 *
 * An account is written at enrolment with state "unauth" and no tokens, and the
 * sign-in that immediately follows is what promotes it to "authvalid". When that
 * sign-in fails — a bring-your-own-app account whose credentials Spotify
 * rejects, someone who closes the consent screen — the account is left behind
 * exactly as enrolment made it: a real account, with a valid auth cookie, and no
 * token to its name.
 *
 * Nothing noticed. /chkauth answered 200 because the state was not "reauth", so
 * the app concluded it was signed in and sat waiting for data that could never
 * arrive, on a loading screen with no way out and nothing logged. Saying "not
 * authenticated" here is what turns that into the sign-in prompt it should
 * always have been.
 *
 * Keyed on the missing refresh token rather than the state alone, so this cannot
 * catch an account that is briefly mid-enrolment but already holds a token.
 */
export function accountNeedsSignIn(user: AccountLike | undefined): boolean {
    if (!user)
        return false;

    if (user.meta?.state == "reauth")
        return true;

    return (user.meta?.state == "unauth" && !user.data?.refreshToken);
}

/**
 * Whether Spotify has refused these credentials outright, as opposed to being
 * briefly unable to answer.
 *
 * The difference decides whether an account is worth retrying. "invalid_client"
 * means the client id and secret it is enrolled with are not a Spotify app any
 * more - most often because the app was deleted from the dashboard - and
 * "invalid_grant" means the refresh token itself has been revoked. Neither can
 * come good on its own, so both need the person back to sign in. Everything
 * else, a timeout or a 500 or a rate limit, must not cost anybody their session.
 *
 * The two shapes come from the two refresh strategies: spotify-web-api-node
 * reports the parsed body, and the fallback in spotify-methods attaches the
 * reason it read off the response.
 */
export function isDeadCredentialsError(ex: unknown): boolean {
    const error = ex as {
        body?: { error?: string };
        spotifyError?: string;
    };

    const reason = error?.body?.error ?? error?.spotifyError;

    return (reason === "invalid_client" || reason === "invalid_grant");
}

/**
 * Whether a successful read of somebody's playback means their account can stop
 * asking them to sign in.
 *
 * Nothing ever cleared these. "reauth" is set whenever a playback read throws,
 * which includes a timeout, a 500 and a rate limit - none of which say anything
 * about the account - and "srverr" is set when Spotify itself is unwell. Once
 * set, the only way out was a full sign-in, so a momentary blip asked somebody
 * to reauthorise an account that had been working the whole time and went on
 * asking until they did.
 *
 * A read that Spotify answered is the strongest evidence available that nothing
 * is wrong: the fallible parts - the client credentials, the refresh token, the
 * scopes it was granted and, on an app in development mode, whether this account
 * is still on the allowlist - are all exercised by the request that just
 * succeeded. Anything less than an answer throws before reaching this.
 *
 * @returns the state to store, or undefined when it should be left alone. An
 *          account mid-enrolment is deliberately not promoted: "unauth" means
 *          the sign-in that follows enrolment has not finished, and finishing it
 *          is what promotes the account, not a stray successful read.
 */
export function stateAfterSuccessfulRead(current: AccountState | string | undefined): AccountState | undefined {
    if (current === "reauth" || current === "srverr")
        return "authvalid";

    return undefined;
}
