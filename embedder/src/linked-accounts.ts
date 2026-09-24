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
 * Every service linked to an account, by service.
 *
 * Only Spotify for now. The credentials for the Spotify link are still the
 * account's top-level `data`, `serverCreds` and `meta.state`; they move under
 * here once there is a second service for them to sit beside.
 */
export interface LinkedAccounts {
    spotify?: SpotifyLink;
}

export interface LinkedAccountsHolder {
    accounts?: LinkedAccounts;
    me?: { id?: string };
}

/**
 * The Spotify user id linked to an account.
 *
 * Accounts written before links were recorded have none, and for those the
 * Spotify profile stored on the account is the link: until now that was the
 * only way an account could exist.
 */
export function spotifyIdOf(account: LinkedAccountsHolder | undefined | null): string | undefined {
    return account?.accounts?.spotify?.id ?? account?.me?.id ?? undefined;
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
 */
export function backfilledLinks(account: LinkedAccountsHolder | undefined | null): LinkedAccounts | undefined {
    if (!account || account.accounts?.spotify)
        return undefined;

    const spotifyId = account.me?.id;

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
 * belongs to it provided it is not recorded as linked to somebody else — that is
 * every account written before links were recorded. One that *is* linked to a
 * different Spotify account only shares the id by coincidence, and must not be
 * handed to whoever signs in with it.
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

    const linked = accountAtSpotifyId.accounts?.spotify?.id;

    if (linked !== undefined && linked !== spotifyId)
        return undefined;

    return spotifyId;
}

/**
 * The Tempo id for a new account that signs up with Spotify.
 *
 * Still the Spotify id. Profile links, friend search and the app's remembered
 * account all expect an account's id to be the Spotify username somebody
 * typed, and nothing needs that to change until an account can start without
 * Spotify. Kept here so that when it does change, it changes in one place.
 */
export function tempoIdForNewSpotifyAccount(spotifyId: string): string {
    return spotifyId;
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
