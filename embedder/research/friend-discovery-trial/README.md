# Friend-taste discovery trial

The harness behind `src/friend-discovery.ts`. It walks a friend group's real
playback history forward and, at every play of a track that listener had never
played before, asks each candidate ranker where it would have put that track —
given only what had happened up to that instant.

Nothing here runs in production. It exists so the numbers in the module's
comments can be re-derived, and re-derived again once there is more than four
days of history to run it on.

## Running it

Playback history is personal data belonging to the friends in the group, so
none of it is committed. Fetch your own:

```
echo "$TEMPO_TOKEN" > .tok && chmod 600 .tok    # your own API token
python3 fetch_all.py          # -> friends-history.json
python3 expand_pool.py        # -> group-deezer.json, artist-catalogues.json
```

Then any of:

```
python3 recsim2.py    # one query per discovery, headline table
python3 recsim3.py    # split by whether the artist was already played
python3 recsim5.py    # recency rankers and the two-lane interleave
python3 recsim6.py    # the same over friends' artists' full catalogues
python3 recsim7.py    # whether closeness between two friends is worth anything
python3 floor.py      # the chance band, over 120 shuffles
```

`recsim6.py` needs the two Deezer files; the rest need only the history.

## What it found

Weighting friends by taste similarity scored 0.033 MRR, flat popularity 0.033,
and track co-occurrence 0.031 — all inside the band 120 shuffles of the same
pool produce, 0.026 [0.015, 0.046]. None of them has been shown to beat chance.
How recently a friend played a track scored 0.077, clear of the band, and was
the only friend signal to clear it on unfamiliar artists as well.

Closeness between two friends is worth nothing measurable either. The ranker
caps every friend at the same share, which treats somebody you listen alongside
every evening the same as somebody you added once — so the obvious next move is
to weight friends by how close they are. There is nothing stored to weight by:
`UserFriendship.stats.streak` and `.tasteMatchScore` are both written as zero
when a friendship is created and never updated, and nothing reads either of
them. Derived from the plays instead, how often two people are listening within
half an hour of each other scored 0.032 MRR and the cosine between their
hour-of-day profiles 0.033 — both inside the chance band. Used as a multiplier
on recency they made it slightly worse rather than better, 0.072-0.073 against
0.077, at every weight and on every cut. The signals are not degenerate: the
co-listening rate runs the whole way from 0.00 to 1.00 across the group, so
there was a real difference between friends for the weight to act on and it
still did not help. Uniform caps are staying until there is something better
than a guess to replace them with.

Run `floor.py` before believing any single number here. One shuffle of a
five-hundred-track pool swings between 11% and 16% at rank 25 on nothing but
the draw, which is wide enough to make a worthless ranker look promising.

Ranking familiar and unfamiliar artists together is what breaks the discovery
half of the feed: any score built on the listener's own artist affinity gives an
artist they have never played a zero, so unfamiliar artists sink below familiar
ones without exception. Two lanes interleaved 65/35 — the rate the two kinds of
first-time play actually occur at — is what fixes it.

Expanding candidates from friends' played tracks to their artists' catalogues
raises reach from 6.8% to 21.5% and drops hit rate by the same factor. Reach ×
hit rate is flat across a 139-fold change in pool size, so the bottleneck is
ranking signal rather than candidate supply.

Caveat that gates everything above: five accounts, 1,552 plays, four days.
Recency is the finding most likely to be flattered by a window that short.
