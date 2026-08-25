# TODO

Things worth doing, none of them urgent. Written 2026-08-25, while Tempo 1.0 (1)
was in Apple's Beta App Review.

## Backend

**The origin takes traffic that did not come through Cloudflare.** Requests with
neither `cf-connecting-ip` nor `x-forwarded-for` log as `[GET@undefined]` —
scanners hitting the IP directly. `limiterKeyGen` in `embedder/src/spotify.ts`
(~709) hashes `ip ?? ""`, so all of them share one rate-limit bucket and
throttle each other. Fall back to `req.socket.remoteAddress`, and consider
restricting the origin at the firewall to Cloudflare's ranges. The request
logger below it has the same blind spot.

**A dead saved app sends the wrong people to set-up.** `/auth/start`
(`embedder/src/spotify.ts` ~3823) answers `reason: "app-credentials"` when a
stored Spotify app is rejected, which routes to bring-your-own-app set-up. Right
for somebody who regenerated a secret; wrong for anyone allowlisted on Tempo's
own app, who is told to create an app they do not need. Falling back to Tempo's
app first would serve them better, at the cost of a murkier path for genuine BYO
users. A judgement call, not a bug.

**Detect Spotify's app-creation rate limit before the terms page.** Spotify
refuses with "You have created too many apps recently. Please try again in 24
hours." Set-up currently walks somebody through consent and only then finds out.

**`me.email` is stored but not declared.** User search reads it through a cast
(`embedder/src/spotify.ts` ~2404) while the `SpotifyUser` interface has no such
field, so it is written inconsistently and nothing type-checks it. It is
declared in the privacy policy, so the storage is intended — the type is what is
missing.

**A stale comment about the refresh rate.** The line above the adaptive polling
logic (`embedder/src/spotify.ts` ~7633) says "Refresh time == 2 min if not
available"; `MAX_REFRESH_RATE` is 100 seconds.

**Run the notification check against the PWA user who was re-prompted.** Early
this session somebody reported being asked to enable notifications on every
start despite accepting. `check-user-notifications.js <user> --test` was written
for exactly this and has never been run against them.

## Website

**Privacy policy §4 still contemplates selling data.** It says Tempo may in
future sell anonymised and aggregated data, including sentiment analytics.
Nothing implements it, and it sits beside a privacy manifest declaring no
tracking. Worth deciding whether it earns its place.

**Privacy policy dates.** Last Updated moved to 25 August 2026; Effective Date
is still 15 April 2025. Material changes usually move both.

**Privacy policy §6 sets 13 as the floor**, while Spotify's own minimum age
varies by country.

**The notification prompt does not mention the leaderboard digest.** It names
friend requests, catching a friend on the same song, and recaps. The leaderboard
is arguably the better hook, being a recurring reason to open the app.

**No hard block on iPad.** `TARGETED_DEVICE_FAMILY` is 1, so the binary is
iPhone-only, but an iPhone app still installs on iPad in compatibility mode and
TestFlight will offer it. Only a runtime guard on the iPad idiom actually stops
it. Email invitations rather than a public link is the cheaper control.

## Product

**Five development-mode slots is the ceiling for the easy path.** Every external
tester beyond those five walks the bring-your-own-app flow, which needs Spotify
Premium. For external TestFlight that flow is the main road, not a fallback, so
its rate-limit and error handling matter more than the slot count suggests.
