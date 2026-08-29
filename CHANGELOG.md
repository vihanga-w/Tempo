# Changelog

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
