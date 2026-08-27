# A song vector, and a model of what goes with what

A fixed-length description of a song that knows nothing about who is listening,
and a small model trained on co-listening to learn which differences between two
songs actually matter.

The separation is the point. `songvec.py` may only use what a track carries on
its own — genre, era, length, how widely known it is, who played on it. No play
counts, no session durations, nothing Tempo records about a listener. That keeps
a song's description the same for everybody and computable for a song nobody has
played. Behaviour enters only as *supervision*, in `pairmodel.py`: two tracks
somebody played in one sitting are a pair that goes together, two drawn at random
are not.

A listener is then a point in the same space — the weighted average of the songs
they pull towards, using the weights `createUserEmbedding` already applies.

## Running it

```
python3 fetch_features.py    # album genres + artist scale from Deezer
python3 songvec.py           # the vector, and how well each dimension populates
python3 pairmodel.py         # train, and score held-out pairs
python3 tastevec.py          # cross-validated, plus the taste-to-fit test
python3 ablate.py            # which blocks earn their place
```

Needs `friends-history.json`, `group-deezer.json` and `artist-catalogues.json`
from `../friend-discovery-trial`. None of it is committed.

## Supervision

`mine_listenbrainz.py` is the reason any of the numbers below are worth reading.
Five accounts over four days give 49 sittings, which is not enough to learn what
a difference between two songs means — everything the first pass concluded about
which features matter was an artefact of that. ListenBrainz publishes real
listens under CC0, a full dump plus a fresh incremental every day, no token (the
API needs one now; the dumps do not). One day is 219 MB compressed:

```
4.5M listens read -> 215k of tracks we can describe
7,099 users       -> 36,184 sittings from 4,383 listeners
```

We read 7.4% of the bytes in that file. `track_metadata.additional_info` alone is
67% of it — media player names, submission client versions, origin URLs — and
nothing in the model touches any of it. A distilled row of (user, timestamp,
track id) is 8.1% of the JSON, so keeping a year of daily dumps costs about 8 GB
rather than 80. `dumpfields.py` measures this. `recording_mbid` is absent from
the incrementals, so matching is on normalised artist and title, not on an id.

## What it found

Negatives are drawn from the play distribution rather than uniformly. Everything
in a real sitting is something somebody chose, so a uniformly drawn track is
obscure by comparison and the model separates the two on popularity alone
without learning anything about taste — worth about ten points of apparent
accuracy, 0.905 against 0.810.

```
everything (46 dims)   0.810
genre only (28 dims)   0.741
```

Which reverses what 49 sittings said. Every block earns its place once there is
enough listening to tell, though not equally:

```
without genre       -0.040
without era         -0.037
without popularity  -0.014
without explicit    -0.006
without credits     -0.003
without duration    -0.002
without gain        -0.001
```

`stylecheck.py` extends the block that carries most: Deezer files 58% of this
catalogue under one label, Rap/Hip Hop, where Discogs has a style field several
times narrower — Trap, Cloud Rap, Pop Rap all sit under it. On the 616 tracks
labelled so far, style is worse than genre compared directly and better once
learned, and the two together beat either alone:

```
                  dims   raw cosine   learned
Deezer genre        28        0.661     0.718
Discogs style       62        0.591     0.746
both                90        0.694     0.784
```

## Against the listener's own history

`affinity.py` and `affinity2.py` ask whether the vector says anything a counter
of past plays does not. Ranking a real next play against 60 popularity-matched
candidates:

```
                    all      familiar artist    new artist
chance             0.077          0.077            0.077
artist affinity    0.416          0.574            0.030
album affinity     0.413          0.568            0.032
vector cosine      0.383          0.485            0.135
both               0.504          0.681            0.070
```

They are complementary, not rivals. A counter leads where the artist is already
played and is at chance where it is not — a never-played artist scores exactly
zero — and the vector is the only thing that can rank at all in that half. Which
also means they must not be added into one score: pooled, the affinity zeros
drown the vector and discovery gets worse than the vector alone.

Ties are ranked from the middle of the tied block. Counting only strictly-higher
candidates hands a scorer rank one whenever it answers zero for everything,
which flattered precisely the case being tested — it read 0.338 on new artists
where the true answer is chance.

## Two things that did not work

**Centring the embedding.** Every feature is non-negative so all vectors sit in
one corner, and two listeners with nothing in common came out at +0.426.
Subtracting the corpus mean fixes the scale — random song pairs go from mean
+0.168 to +0.005 — and costs a tenth of the ranking quality, because the
component removed is typicality, and typicality predicts plays.

**Encoding typicality as its own dimension.** The obvious repair, and worse at
every weight tried (0.405 raw, 0.378 at best). The premise was wrong: the shared
direction is only 17% of a unit vector's energy and it takes 12 of 16 components
to reach 90% of the variance. There was no ballast to reclaim.

What does work is calibration rather than geometry — `calibrate2.py` reports a
similarity against the distribution of similarities between real listeners,
where 0.43 can be said to be distant. Against 555 ListenBrainz listeners the
median pair sits at -0.003, so every pair in this friend group is above the 78th
percentile: friends are all alike compared to the world, and only their order
within the group means anything.

`genre-vocab.json` is committed deliberately. A vector is only comparable to
another built against the same vocabulary, so regenerating it silently would
reinterpret every embedding already stored.
