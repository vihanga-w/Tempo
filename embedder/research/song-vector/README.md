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

```text
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

```text
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
accuracy, 0.908 against 0.810.

```text
everything (46 dims)   0.810
genre only (28 dims)   0.742
```

Which reverses what 49 sittings said. Every block earns its place once there is
enough listening to tell, though not equally:

```text
without genre       -0.040
without era         -0.037
without popularity  -0.012
without explicit    -0.005
without credits     -0.004
without duration    -0.003
without bpm         -0.002
without gain        -0.001
```

`stylecheck.py` extends the block that carries most: Deezer files 58% of this
catalogue under one label, Rap/Hip Hop, where Discogs has a style field several
times narrower — Trap, Cloud Rap, Pop Rap all sit under it. On the 616 tracks
labelled so far, style is worse than genre compared directly and better once
learned, and the two together beat either alone:

```text
                  dims   raw cosine   learned
Deezer genre        28        0.661     0.718
Discogs style       62        0.591     0.746
both                90        0.694     0.784
```

## Against the listener's own history

`affinity.py` and `affinity2.py` ask whether the vector says anything a counter
of past plays does not. Ranking a real next play against 60 popularity-matched
candidates:

```text
                    all      familiar artist    new artist
chance             0.077          0.077            0.077
artist affinity    0.466          0.682            0.031
album affinity     0.420          0.613            0.032
vector cosine      0.404          0.548            0.116
both               0.535          0.760            0.082
```

Held out by listener, and the combining weight is fitted on one half of the
cases while the table reports the other. Both were wrong before: the weight was
fitted and reported on the same cases, which flattered the `both` row by however
much it was free to chase, and the split was by sitting, which let the tower
train on other sittings by the very listeners being scored. 485 cases from
listeners the model never read is a noisier number than 4,000 leaky ones, and
the only honest one.

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

## Nicheness is already in there

Average song rank looks like an obvious addition to the user vector — it says
outright how far from the charts somebody listens. `nicheness.py` and
`nicheness2.py` ask whether stating it buys anything. It does not, for three
reasons that stack.

**The tower already keeps it.** `rank_pct` reads back out of the 16-dimension
embedding at R² 0.816, and out of the other 45 raw dimensions at only 0.429 — so
the model is carrying how widely known a track is deliberately, beyond whatever
genre and era imply about it. The taste vector is the mean of those embeddings,
so it already carries the listener's average rank, and `taste · song` already
scores the match.

**It is a real trait, but a narrow one.** Split-half agreement on a listener's
mean rank is +0.985, which is about as stable as anything here. The spread
between listeners is the problem: 0.090, against 0.154 within a single
listener's own plays. Everybody sits near the popular end.

```text
statistic           split-half r  sd between             range
mean                      +0.985       0.090       0.59 to 0.98
10th pct                  +0.964       0.174       0.11 to 0.96
25th pct                  +0.948       0.146       0.35 to 0.97
median                    +0.984       0.102       0.51 to 0.99
spread (sd)               +0.966       0.067       0.00 to 0.28
share below .7            +0.980       0.195       0.00 to 0.80
```

**No form of it clears zero.** Six summaries, two negative regimes, the mixing
weight fitted on one half and scored on the other, 2,000-sample bootstrap on the
difference. Every one of the twelve intervals contains zero.

```text
                       global negatives          one friend's plays
+ mean          +0.0112 [-0.0112, +0.0327]   -0.0022 [-0.0082, +0.0011]
+ 10th pct      +0.0071 [-0.0238, +0.0352]   +0.0187 [-0.0072, +0.0461]
+ 25th pct      +0.0100 [-0.0196, +0.0385]   -0.0019 [-0.0073, +0.0012]
+ median        +0.0003 [-0.0074, +0.0092]   -0.0185 [-0.0405, +0.0010]
+ spread (sd)   +0.0078 [-0.0118, +0.0255]   +0.0161 [-0.0062, +0.0402]
+ share below .7 +0.0049 [-0.0136, +0.0217]  +0.0167 [-0.0049, +0.0407]
```

Worth saying what this test can and cannot carry. Holding out whole listeners
rather than sittings took it from 1,915 cases to 405, and the intervals roughly
tripled in width with it. So "no effect" is the wrong reading; the right one is
that nothing here is distinguishable from no effect at a resolution of about
±0.03 MRR, and an effect worth shipping would have to be larger than the entire
interval to have been missed. The earlier tighter intervals were not a better
measurement — they were the same measurement with the model reading the
listeners it was being scored on.

The negative pool decides this, which is why both are run. Candidates drawn from
the global play distribution are matched to the world's popularity, not to the
listener's, so nicheness has something to separate and the term is worth a
couple of thousandths. Candidates drawn from one other listener already carry
that person's nicheness, and the term has nothing left — the fitted weight comes
back at zero. The feed is the second case, and real friends are more alike than
the random listeners used here (`calibrate2.py`: every pair in the friend group
sits above the 78th percentile of listener similarity), so the production
setting is the one where it helps least.

Two things worth keeping out of this even though the answer was no:

**The mean is the wrong summary if a number is ever wanted for display.** Share
of plays below the 0.7 rank percentile separates listeners twice as well (sd
0.195 against 0.090) and spans the full range rather than a band. "How deep does
this person dig" is a profile statistic, not a ranking feature.

**There is no `rank_present` flag.** Every other block has one; a track with no
rank gets `rank_pct` 0 and reads as maximally obscure rather than as unknown.
Deezer fills rank for all 11,994 tracks here so it is latent rather than live,
but it will bite as the catalogue takes in tracks matched only through Discogs.
Adding it changes the vector length, so it belongs with a model version bump.


## What review changed

CodeRabbit read this directory and found thirteen things, all of them real. Four
of them moved numbers above, so every table here has been re-measured:

- The AUC was ranking tied scores by array position rather than sharing the
  middle of the block, so an evaluation with many ties — which is any evaluation
  including a play counter, since it answers zero for everything it has never
  seen — depended on iteration order. `affinity.py` still had the
  strictly-greater ranking that `affinity2.py` was written to correct.
- `affinity2.py` fitted its combining weight on the cases it then reported.
- `nicheness.py` shuffled `groups` in place, so the "last five plays" the case
  builder holds out were an arbitrary five and history could contain plays
  recorded after them. `nicheness2.py`, which is where the intervals above come
  from, shuffled a copy and was unaffected.
- `tastevec.py` averaged every fold model and scored each listener with the
  average, including the folds trained on that listener's own history. It holds
  out by listener now: five accounts, five models, each scoring only the person
  it never read.
- A second round found the same leak, one level down, in `nicheness.py`,
  `nicheness2.py` and `affinity2.py`: splitting the sittings 80/20 still trained
  the tower on other sittings by the listeners being scored. All three hold out
  whole listeners now, which is what shrank the case counts above.
- `splitemb.py`, written to fix the shared-cache leak, shuffled the groups it
  returned — and `cases_for` reads the last sitting as the play to predict. So
  the fix put later listening into the history it was scored against. Membership
  stays random, order is restored.
- A single `emb.npy` was written by `vonga_feed.py` from every sitting and read
  by `calibrate.py` and `typicality.py` as though the last 20% had been held out.
  `splitemb.py` now keys the cache by the split it was trained on.

The conclusions all survived. Popularity-matched negatives still cost about ten
points against uniform, genre and era still carry most of the vector, affinity
and the vector are still complementary and still must not be pooled, and
nicheness still earns nothing.
