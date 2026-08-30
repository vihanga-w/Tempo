# Changelog

## Notifications

### 🎧 A Spotify Jam is announced once, not once a track

Being in sync is now a state a pair of friends are in, rather than a claim
about the song they happened to share. A group moving through a playlist
together were previously treated as a brand new match on every track, so an
evening on a Jam arrived as a run of near-identical notifications.

### ⏳ A friend polled a moment later is no longer a friend who left

Each side's playback is read by its own poll, on its own schedule, so a pair
are always compared using one fresh reading and one that may be up to a poll
old. In the gap between the two the pair look like they have separated — and
that reading was enough to end the sync, which meant the slower poll catching
up counted as them finding each other again.

A pair now have to be seen apart for longer than a poll can be deferred before
it is believed. A pause, a track change seen from one side first, or a poll
that ran late all pass through without ending anything; two people who really
have gone their own way are still noticed, and still announced afresh the next
time they line up.

## Images

### 🖼️ Thumbnails are no longer stored at quality 90

The quality is part of an image's key, so changing it stranded whatever was
there before — the new file was written alongside the old one and nothing
ever read the old one again. Left alone that accumulated a dead file per
image per change, forever.

### 🧹 Superseded image variants are swept

When a variant is written, the copies left behind at an older quality are
deleted. The matching is deliberately narrow — same image, same dimensions,
any quality but the current one — so a different size is never touched and
anything that isn't shaped like a variant is left where it is. Getting this
wrong deletes somebody's images, so the rule is a pure function and tested
on its own.

## Profiles

### 🎨 Every account carries a colour blob

A tiny average of each profile picture, stored on the account, so the app can
draw a blurred stand-in the moment a page opens instead of leaving a hole
where an avatar will be. Filled in on boot, and cheap to skip for accounts
that already have one: nothing is fetched unless the picture has actually
changed.

The web app's profile page reads this — see the matching release there.
