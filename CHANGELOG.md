# Changelog

## Playlists

### 🕗 A playlist that knows what time it is

A fifth recipe, "Right about now". The four before it answer the same thing
at breakfast as at midnight, which is the one thing a listener never does:
they have a morning taste and a late one, and a playlist that ignores the
clock hands over the wrong one half the time.

This one weighs every play by how far round the dial it sits from the hour
being asked about — a play at this hour counts for all of itself, one twelve
hours away for a sixteenth — and does the same with friends' plays, so what
rises is what this listener actually reaches for at this time of day. Likes
come in light and unweighted: when somebody swiped in Discover says nothing
about when they want to hear the song. It leans on the last fortnight rather
than the last season, so it follows a taste that is moving.

### 🎲 Shuffled, but never by chance

What the clock leaves is nudged up or down by a roll that holds for a few
hours at a time, which is what keeps a playlist rebuilt six times a day from
being the same playlist six times a day: the songs somebody is plainly in the
mood for stay put, and the ones behind them take turns.

The roll is a hash of the song and the turn rather than a draw, so the recipe
is still deterministic. That matters for more than tidiness — the playlist
shown to somebody before they name it has to be the playlist they are given,
and a rebuild a minute later must not be a different playlist for no reason
anybody can see.

### ♻️ Rebuilt with the hour, not with the week

Every other recipe is rebuilt weekly, on the grounds that a playlist changing
under somebody every morning is never the one they had in their head. This
one's whole claim is that it is the playlist for this hour, so it is rebuilt
every turn of its shuffle, and its turn rather than its age is what decides —
a rebuild within a turn would only write back the list it already had.

It is also rebuilt when it is opened. The hourly sweep only reaches listeners
the server holds a session for, so without that, anybody opening the app in
the morning would be handed last night's playlist. Its copy on Spotify
follows behind the answer rather than making them wait on it.

Its cover is keyed to the part of the day instead of to its first three
songs — four pictures a day at most, rather than one composed and uploaded
with every rebuild.

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
