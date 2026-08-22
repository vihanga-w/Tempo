/**
 * Development fixture: a synthetic friend who is always listening to something.
 *
 * Testing the friends list and the live playback UI otherwise needs a second
 * real Spotify account actively playing music. This seeds one friend and keeps a
 * playback state ticking for them.
 *
 * Enabled with DEV_FAKE_FRIEND=true, and refused outright when NODE_ENV is
 * production. It writes real documents to the database, so the fake user and the
 * friendship persist until removed — see removeFakeFriend below.
 */

import { DataStore, UserDocType } from "./db";
import { IS_PRODUCTION } from "./env";

export const FAKE_FRIEND_ID = "tempodevfakefriend000000000";

/** Far enough ahead that the state refresh loop never tries to poll Spotify for them. */
const NEVER_REFRESH = Number.MAX_SAFE_INTEGER;

const TRACK = {
    songId: "2takcwOaAZWiXQijPHIx7B",
    albumId: "4aawyAB9vmqN3uQ7FjRGTy",
    name: "Time of Our Lives",
    durationMs: 229000,
    imageUrl: "https://i.scdn.co/image/ab67616d0000b2732c5b24ecfa39523a75c993c4",
    artists: [
        { name: "Pitbull", url: "https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg" },
        { name: "Ne-Yo", url: "https://open.spotify.com/artist/21451j1KhjAiaYKflxBjr1" },
    ],
};

export function buildFakeFriendDocument(): UserDocType {
    return {
        data: {
            accessToken: "",
            refreshToken: "",
            expires: NEVER_REFRESH,
            scope: "",
            tokenType: "Bearer",
        },
        me: {
            id: FAKE_FRIEND_ID,
            display_name: "Test Listener",
            displayName: "Test Listener",
            email: "test-listener@example.invalid",
            images: [{ url: TRACK.imageUrl, height: 300, width: 300 }],
            listenerTypeClassification: "Beat Seeker",
        },
        serverCreds: {
            clientId: "",
            clientSecret: "",
        },
        meta: {
            serviceId: FAKE_FRIEND_ID,
            state: "authvalid",
            // Keeps the polling loop away from an account with no real credentials
            nextRefresh: NEVER_REFRESH,
            token: "",
            tokenVersion: "dev-fake-friend",
            dayRecapAvailableDate: -1,
            weekRecapAvailableDate: -1,
            viewedDailyRecap: "",
            viewedWeeklyRecap: "",
            priorityFYPAlerts: [],
        },
        settings: {
            shareListeningActivity: true,
        },
        friends: [],
    } as unknown as UserDocType;
}

/**
 * A playback state that advances with wall-clock time and loops.
 *
 * sessionStart is separate from the track position: it is when this listening
 * run began, which is what drives the streak. Deriving it from track progress
 * (as this first did) capped it at one track length, so it never reached the
 * five-minute threshold and a streak could never appear.
 */
export function buildFakePlaybackState(displaySeed: number, sessionStart: number) {
    const elapsed = Date.now() % TRACK.durationMs;
    const progressNormal = elapsed / TRACK.durationMs;

    return {
        userId: FAKE_FRIEND_ID,
        songId: TRACK.songId,
        albumId: TRACK.albumId,
        progressNormal,
        isPlaying: true,
        timeRemaining: TRACK.durationMs - elapsed,
        duration: TRACK.durationMs,
        displaySeed,
        playSessionStart: sessionStart,
        imageUrl: TRACK.imageUrl,
        pfpUrl: TRACK.imageUrl,
        username: "Test Listener",
        explicit: false,
        replayCount: 0,
        name: TRACK.name,
        artists: TRACK.artists,
        updatedAt: Date.now(),
        lastEventSentAt: -1,
        todayStats: {
            totalListenCount: 3,
            completeListenCount: 2,
            averageSessionDuration: 0.8,
            totalSessionDuration: 2.4,
            skipCount: 1,
            replayCount: 0,
        },
        mediaType: "track" as const,
    };
}

/**
 * Ensures the fake user exists and is an accepted friend of every real user.
 * Returns the friendship ids created, keyed by real user id.
 */
export async function seedFakeFriendData(
    db: DataStore,
    realUserIds: string[],
    friendshipIdFor: (a: string, b: string) => string,
): Promise<void> {
    if (IS_PRODUCTION)
        throw new Error("Refusing to seed the fake friend fixture in production");

    await db.set<UserDocType>("users", FAKE_FRIEND_ID, buildFakeFriendDocument());

    const fakeFriendships: string[] = [];

    for (const realUserId of realUserIds) {
        if (realUserId === FAKE_FRIEND_ID)
            continue;

        const friendshipId = friendshipIdFor(realUserId, FAKE_FRIEND_ID);

        await db.set("friends", friendshipId, {
            id: friendshipId,
            u1Id: realUserId,
            u2Id: FAKE_FRIEND_ID,
            state: "friends",
            initiator: FAKE_FRIEND_ID,
            lastUpdated: Date.now(),
        });

        const existing = (await db.get<string[]>("users", realUserId + "/friends")) ?? [];

        if (!existing.includes(friendshipId))
            await db.update<string[]>("users", realUserId + "/friends", [...existing, friendshipId] as any);

        fakeFriendships.push(friendshipId);

        console.log("[dev-fake-friend] linked", FAKE_FRIEND_ID, "to", realUserId, "as", friendshipId);
    }

    await db.update<string[]>("users", FAKE_FRIEND_ID + "/friends", fakeFriendships as any);
}

/**
 * Accepts any pending request to the fixture.
 *
 * Sending a friend request through the UI rewrites the friendship document back
 * to "request", so without this the fixture would sit permanently pending and
 * never appear in the friends list.
 */
export async function acceptPendingFakeFriendRequests(
    db: DataStore,
    realUserIds: string[],
    friendshipIdFor: (a: string, b: string) => string,
): Promise<void> {
    for (const realUserId of realUserIds) {
        if (realUserId === FAKE_FRIEND_ID)
            continue;

        const friendshipId = friendshipIdFor(realUserId, FAKE_FRIEND_ID);
        const friendship = await db.get<{ state?: string }>("friends", friendshipId);

        if (!friendship || friendship.state === "friends")
            continue;

        await db.update("friends", friendshipId, {
            state: "friends",
            lastUpdated: Date.now(),
        });

        console.log("[dev-fake-friend] accepted friend request from", realUserId);
    }
}

/** Removes the fixture: the fake user, its friendships, and the back-references. */
export async function removeFakeFriendData(
    db: DataStore,
    realUserIds: string[],
    friendshipIdFor: (a: string, b: string) => string,
): Promise<void> {
    for (const realUserId of realUserIds) {
        if (realUserId === FAKE_FRIEND_ID)
            continue;

        const friendshipId = friendshipIdFor(realUserId, FAKE_FRIEND_ID);

        await db.remove("friends", friendshipId);

        const existing = (await db.get<string[]>("users", realUserId + "/friends")) ?? [];

        await db.update<string[]>(
            "users",
            realUserId + "/friends",
            existing.filter(v => v !== friendshipId) as any
        );
    }

    await db.remove("users", FAKE_FRIEND_ID);

    console.log("[dev-fake-friend] fixture removed");
}
