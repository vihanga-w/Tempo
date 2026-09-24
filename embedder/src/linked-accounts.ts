/**
 * Which music services a Tempo account is linked to, and which account owns a
 * given service's user.
 *
 * A Tempo account used to *be* a Spotify account: the document key, the id in
 * the auth token and every friendship all were the Spotify user id, and nothing
 * recorded that as a link rather than an identity. That is fine for as long as
 * Spotify is the only way in, and in the way of everything after it. Apple Music
 * cannot be a second key of the same kind, because it never tells an app who
 * its user is — there is no profile and no user id, only a token.
 *
 * So the Spotify id is written down as what it is, a linked account, beside the
 * Tempo id that owns it, and anything that has a Spotify id in hand and wants
 * the account asks here instead of assuming the two are the same string.
 *
 * Existing accounts keep their Spotify id as their Tempo id. Every stored
 * document, token, friendship and taste is keyed by it, and none of that has to
 * move for the link to be recorded next to it.
 */

/** A Spotify account linked to a Tempo account. */
export interface SpotifyLink {
    /** The Spotify user id, as `/v1/me` reports it. */
    id: string;
    /**
     * When it was linked. Absent for accounts linked before links were
     * recorded, whose date nobody kept.
     */
    linkedAt?: number;
}

/**
 * An Apple Music account linked to a Tempo account.
 *
 * There is no Apple Music user id to record — Apple never gives an app one —
 * so a link is a token and nothing else. The token is the listener's music
 * user token from MusicKit on their device. It has no refresh token and stops
 * working without warning, so the app sends a fresh one whenever it opens, and
 * a link whose token has been refused waits for the next.
 *
 * Kept in a collection of its own, not on the account (see apple-music-links.ts):
 * the account is written back whole from stale copies in several places, and
 * logged whole in others, and neither may happen to a token.
 */
export interface AppleMusicLink {
    linkedAt: number;
    /** The listener's music user token. Never sent back to the app. */
    userToken: string;
    tokenUpdatedAt: number;
    /** The listener's storefront ("us", "gb", …), for catalog lookups. */
    storefront: string;
    /** "needs-token" once Apple has refused the token, until the app sends another. */
    state: "linked" | "needs-token";
    /**
     * The recently played list as last read, newest first, by the id each track
     * is listed under. What the next read is compared against.
     */
    recent?: string[];
    /** When `recent` was read. */
    lastReadAt?: number;
}

/**
 * The services linked to an account, by service, that are recorded on the
 * account itself. Apple Music's link is kept apart; see AppleMusicLink.
 *
 * The credentials for the Spotify link are still the account's top-level
 * `data`, `serverCreds` and `meta.state`, where every Spotify code path reads
 * them.
 */
export interface LinkedAccounts {
    spotify?: SpotifyLink;
}

export interface LinkedAccountsHolder {
    accounts?: LinkedAccounts;
    me?: { id?: string };
    meta?: { serviceId?: string };
}

/**
 * The Spotify user id linked to an account, or undefined when it cannot be
 * vouched for.
 *
 * Accounts written before links were recorded have none, and for those the
 * Spotify profile stored on the account is the link — until now that was the
 * only way an account could exist — but only while the profile agrees with the
 * account's own id.
 *
 * It need not. Signing in again as another Spotify user used to write the
 * other user's profile over an account's, or a copy of the account under the
 * other user's id. Either way the profile names somebody the account does not
 * belong to, and trusting it would hand the account to them. Such a record has
 * no Spotify user anyone can vouch for, and is treated as linked to nobody.
 */
export function spotifyIdOf(account: LinkedAccountsHolder | undefined | null): string | undefined {
    if (account?.accounts?.spotify?.id)
        return account.accounts.spotify.id;

    const profileId = account?.me?.id;

    if (!profileId)
        return undefined;

    const serviceId = account?.meta?.serviceId;

    return ((!serviceId || serviceId === profileId) ? profileId : undefined);
}

/**
 * The account's links with Spotify id `spotifyId` linked.
 *
 * Linking the account that is already linked keeps its date, so signing in
 * again does not make an old link look new. Other services' links are left as
 * they are.
 */
export function withSpotifyLinked(accounts: LinkedAccounts | undefined, spotifyId: string, now: number): LinkedAccounts {
    const current = accounts?.spotify;

    if (current?.id === spotifyId)
        return { ...accounts, spotify: current };

    return { ...accounts, spotify: { id: spotifyId, linkedAt: now } };
}

/**
 * The links to record on an account that predates them, or undefined when
 * there is nothing to record.
 *
 * Deliberately undated: the account was linked at some point before this ran,
 * and the time it ran is not that point.
 *
 * Only for an account whose profile and id agree. Before links were recorded,
 * signing in again as another Spotify user wrote a copy of an account under
 * that user's id, still naming the original account as its own. The copy's
 * profile is the other user's, so backfilling from it would link the other
 * user to the original account — and hand it to them at their next sign-in.
 * Nothing can tell which of the two such a record meant, so it is left alone.
 */
export function backfilledLinks(account: LinkedAccountsHolder | undefined | null): LinkedAccounts | undefined {
    if (!account || account.accounts?.spotify || !account.meta?.serviceId)
        return undefined;

    const spotifyId = spotifyIdOf(account);

    if (!spotifyId)
        return undefined;

    return { ...account.accounts, spotify: { id: spotifyId } };
}

/**
 * Which Tempo account a Spotify account belongs to, if any.
 *
 * @param linkedOwner the account recording a link to this Spotify id, if one does
 * @param accountAtSpotifyId the account stored under the Spotify id itself, if any
 *
 * The recorded link wins. Failing that, an account stored under the Spotify id
 * belongs to it only when that account is linked to this Spotify user, by a
 * recorded link or a profile that can be vouched for (see spotifyIdOf) — that
 * is every account written before links were recorded. One linked to somebody
 * else, or whose Spotify user nobody can vouch for, must not be handed to
 * whoever signs in with the id it happens to be stored under.
 */
export function ownerOfSpotifyAccount(
    spotifyId: string,
    linkedOwner: string | undefined | null,
    accountAtSpotifyId: LinkedAccountsHolder | undefined | null,
): string | undefined {
    if (linkedOwner)
        return linkedOwner;

    if (!accountAtSpotifyId)
        return undefined;

    if (spotifyIdOf(accountAtSpotifyId) !== spotifyId)
        return undefined;

    // Stored under this id but naming another account as its own: a copy
    const serviceId = accountAtSpotifyId.meta?.serviceId;

    if (serviceId && serviceId !== spotifyId)
        return undefined;

    return spotifyId;
}

/**
 * The Tempo id for a new account that signs up with Spotify, or undefined when
 * that id is already another account's.
 *
 * @param taken whether an account is already stored under the Spotify id
 *
 * Only reached once ownerOfSpotifyAccount has found no owner, so an account
 * stored under the id belongs to somebody else. Enrolling into it would
 * overwrite theirs.
 *
 * Still the Spotify id. Profile links, friend search and the app's remembered
 * account all expect an account's id to be the Spotify username somebody
 * typed, and nothing needs that to change until an account can start without
 * Spotify. Kept here so that when it does change, it changes in one place.
 */
export function tempoIdForNewSpotifyAccount(spotifyId: string, taken: boolean): string | undefined {
    return (taken ? undefined : spotifyId);
}

/**
 * The Tempo id of an account: its document key and the id in its auth token.
 *
 * Code that wanted "this user's id" read the Spotify profile's for a long time,
 * which was the same string. Read this instead. The profile is only the
 * fallback for an account missing its own record of the id.
 */
export function tempoIdOf(account: { meta?: { serviceId?: string }; me?: { id?: string } } | undefined | null): string | undefined {
    return account?.meta?.serviceId || account?.me?.id || undefined;
}

/**
 * The Apple Music link with a new token in it.
 *
 * Linking again, or the app sending the token it has now, keeps the link's
 * date and where reading the recently played list had got to — a new token is
 * the same listener, and their list carries on where it was.
 */
export function withAppleMusicToken(link: AppleMusicLink | undefined, userToken: string, storefront: string, now: number): AppleMusicLink {
    return {
        ...link,
        linkedAt: link?.linkedAt ?? now,
        userToken,
        tokenUpdatedAt: now,
        storefront,
        state: "linked",
    };
}

/** What the app is told about an account's links. No tokens. */
export interface LinkedAccountsStatus {
    spotify?: { id: string; linkedAt?: number };
    appleMusic?: { linkedAt: number; storefront: string; needsToken: boolean };
}

export function linkedAccountsStatus(account: LinkedAccountsHolder | undefined | null, apple: AppleMusicLink | undefined | null): LinkedAccountsStatus {
    const status: LinkedAccountsStatus = {};
    const spotifyId = spotifyIdOf(account);

    if (spotifyId)
        status.spotify = { id: spotifyId, linkedAt: account?.accounts?.spotify?.linkedAt };

    if (apple)
        status.appleMusic = { linkedAt: apple.linkedAt, storefront: apple.storefront, needsToken: apple.state !== "linked" };

    return status;
}
