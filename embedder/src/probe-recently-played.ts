/**
 * Dumps a user's Spotify play history so its shape can be checked against real
 * data before anything is built on top of it.
 *
 * Three things need answering before offline listening can be recovered, and
 * none of them can be settled by reading documentation:
 *
 *   1. Do plays made offline appear here at all once the device reconnects, and
 *      how long after?
 *   2. Does played_at mark the beginning or the end of a play? It decides which
 *      neighbour a play's length is measured against.
 *   3. Do very short plays appear? If they do not, skipping is invisible however
 *      the arithmetic is done.
 *
 * Run it after listening offline:
 *
 *     node build/probe-recently-played.js <spotifyUserId>
 *
 * Read-only. Refreshes an access token and makes one GET.
 */

import { DataStore, UserDocType } from "./db";
import { refreshSpotifyToken } from "./spotify-methods";
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from "./env";

interface PlayHistoryItem {
    played_at: string;
    track: {
        id: string;
        name: string;
        duration_ms: number;
        artists: { name: string }[];
    };
}

function ms(value: number): string {
    const seconds = Math.round(value / 1000);

    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

async function main() {
    const userId = process.argv[2];

    if (!userId) {
        console.error("Usage: node build/probe-recently-played.js <spotifyUserId>");
        process.exit(1);
    }

    const db = new DataStore();

    await new Promise<void>(resolve => db.once("ready", resolve));

    const user = await db.get<UserDocType>("users", userId);

    if (!user) {
        console.error("No such user:", userId);
        await db.shutdown();
        process.exit(1);
    }

    // Checked before spending a request: a token carries the scopes it was
    // granted at authorisation, and refreshing does not add any, so an account
    // authorised before play history was requested simply cannot read it.
    const granted = (user.data?.scope ?? "");

    console.log("Granted scopes:", granted || "(none recorded)");

    if (!granted.split(" ").includes("user-read-recently-played")) {
        console.error(`
This account has no user-read-recently-played scope, so its play history cannot
be read. Refreshing the token will not help — scopes are fixed when the account
authorises, and this one authorised before Tempo asked for that scope.

Sign out and back in to re-authorise, then run this again. Spotify will show one
extra permission on the consent screen.
`);

        await db.shutdown();
        process.exit(1);
    }

    // The app this account authorised against: a refresh token is only valid
    // for the client that issued it
    const clientId = user.serverCreds?.clientId || SPOTIFY_CLIENT_ID;
    const clientSecret = user.serverCreds?.clientSecret || SPOTIFY_CLIENT_SECRET;

    const refreshed = await refreshSpotifyToken({
        clientId,
        clientSecret,
        refreshToken: user.data.refreshToken ?? "",
    });

    if (refreshed === "srverr" || !refreshed?.access_token) {
        console.error("Could not refresh an access token for", userId);
        await db.shutdown();
        process.exit(1);
    }

    const res = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=50", {
        headers: { Authorization: "Bearer " + refreshed.access_token },
    });

    if (!res.ok) {
        console.error("Spotify returned", res.status, await res.text());
        await db.shutdown();
        process.exit(1);
    }

    const body = await res.json() as { items: PlayHistoryItem[] };

    // Oldest first, which is the order the inference expects
    const items = [...body.items].reverse();

    console.log(`\n${items.length} plays, oldest first\n`);
    console.log("played_at".padEnd(26), "gap".padEnd(9), "length".padEnd(9), "gap/length".padEnd(11), "track");
    console.log("-".repeat(110));

    let previous: number | undefined;

    for (const item of items) {
        const playedAt = new Date(item.played_at).getTime();
        const gap = (previous === undefined ? undefined : playedAt - previous);
        const ratio = (gap === undefined ? undefined : gap / item.track.duration_ms);

        console.log(
            new Date(playedAt).toISOString().padEnd(26),
            (gap === undefined ? "-" : ms(gap)).padEnd(9),
            ms(item.track.duration_ms).padEnd(9),
            (ratio === undefined ? "-" : ratio.toFixed(2)).padEnd(11),
            `${item.track.artists.map(a => a.name).join(", ")} - ${item.track.name}`,
        );

        previous = playedAt;
    }

    console.log(`
What to look for:

  gap/length near 1.00 throughout
      played_at marks the START of a play: the gap to the next entry is how long
      this one was played for.

  gap/length near 1.00 but shifted by one row
      played_at marks the END: the gap from the previous entry is this one's
      length. Compare a row's ratio against its own length and its neighbour's.

  ratios well under 1.00
      Real skips, and a sign the arithmetic can recover them.

  no ratios under about 0.15 anywhere
      Short plays are being withheld, so rapid skipping stays invisible however
      it is inferred.

  a block of rows seconds or milliseconds apart, all near the same time
      The batch signature. Timestamps appear to be stamped when Spotify receives
      a play rather than when the player finished it, so listening that could not
      be reported at the time arrives together on reconnect and every play in the
      batch carries roughly the reconnect time. Those timestamps say nothing
      about when the listening happened, and measured naively they read as a run
      of tracks each abandoned after a second. If the offline stretch arrives
      like this, it cannot be placed in time and only the fact that the tracks
      were played is recoverable.

  the offline stretch missing entirely
      The premise does not hold and none of this is worth building. Try again
      after leaving the device online a while longer.
`);

    await db.shutdown();
}

main().catch(async ex => {
    console.error("Probe failed:", ex);
    process.exit(1);
});
