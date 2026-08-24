/**
 * Just the parts of a friendship this needs.
 *
 * Structural rather than imported: the real type lives in the server entry
 * point, and importing that here to borrow a shape would start a server every
 * time these functions are tested.
 */
export type Friendship = {
    u1Id: string;
    u2Id: string;
    state: string;
};

/**
 * Who to suggest, and in what order.
 *
 * Friends of your friends who are not yet friends of yours. That is the one
 * thing this app knows about a stranger that the stranger cannot tell you
 * themselves, and it is the only list the add-friends page can show before a
 * single character has been typed.
 *
 * Pure, and separate from the endpoint that serves it, because the ordering and
 * — more importantly — the exclusions are the part worth being sure about. A
 * suggestion for somebody you have already asked reads as the app not having
 * noticed what you did, and there is no way to check that against a database
 * with two accounts in it.
 */
export type SuggestionCandidate = {
    /** The account to suggest. */
    userId: string;
    /**
     * Your friendships with the people you have in common.
     *
     * The friendships rather than a count, because the page says how many and
     * counting them here means the walk does not have to be repeated to explain
     * its own answer.
     */
    mutualFriends: Friendship[];
};

/** The other side of a friendship, whichever side you are on. */
export function otherSideOf(friendship: Friendship, userId: string): string {
    return (friendship.u1Id === userId ? friendship.u2Id : friendship.u1Id);
}

export function rankFriendSuggestions(
    userId: string,
    /** Every friendship you hold, in any state. */
    mine: Friendship[],
    /** Friendships held by each of your friends, keyed by their id. */
    friendsOf: Map<string, Friendship[]>,
    limit = 20,
): SuggestionCandidate[] {
    /*
     * Anybody you already have any relationship with is out, whatever its state:
     * friends, a request you sent, a request waiting on you, blocked either way.
     * Only accepted friendships are walked *through*, but every state is a
     * reason not to arrive at someone.
     */
    const known = new Set<string>([userId]);

    for (const friendship of mine)
        known.add(otherSideOf(friendship, userId));

    const reachedVia = new Map<string, Friendship[]>();

    for (const friendship of mine) {
        if (friendship.state !== "friends")
            continue;

        const friendId = otherSideOf(friendship, userId);

        for (const theirs of (friendsOf.get(friendId) ?? [])) {
            if (theirs.state !== "friends")
                continue;

            const candidate = otherSideOf(theirs, friendId);

            if (known.has(candidate))
                continue;

            reachedVia.set(candidate, [...(reachedVia.get(candidate) ?? []), friendship]);
        }
    }

    return [...reachedVia.entries()]
        .map(([candidateId, mutualFriends]) => ({ userId: candidateId, mutualFriends }))
        // Most in common first, which is the whole signal. Ties fall back to the
        // id so the list does not reshuffle itself between two identical calls.
        .sort((a, b) => (
            b.mutualFriends.length - a.mutualFriends.length
            || a.userId.localeCompare(b.userId)
        ))
        .slice(0, limit);
}
