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

## What it found

Held out by sitting, five-fold, on 49 sittings:

```
chance                      0.500
raw genre cosine            0.597
learned metric              0.633
```

The model earns about three and a half points over comparing genre vectors
directly, so there is something in co-listening that plain genre distance does
not capture. But almost everything else in the vector is ballast:

```
genre only        (28 dims)  0.633
genre + credits   (33 dims)  0.632
genre + era       (32 dims)  0.613
everything        (46 dims)  0.599
```

Era, duration, explicitness, gain and BPM each cost accuracy when added. At 49
sittings there is not enough supervision to tell what they mean, so the model
fits noise in them. Genre is the block that works, and the useful direction is a
finer genre vocabulary rather than more kinds of feature.

The taste vector built on it correlates +0.174 [-0.042, +0.386] with how a play
went — better than the 46-dimension version's +0.036, but the interval still
includes zero, and a one-line "how much do they play this album" heuristic
scored +0.243 [+0.050, +0.405] on the same 75 plays. The vector is not yet
earning its complexity.

`genre-vocab.json` is committed deliberately. A vector is only comparable to
another built against the same vocabulary, so regenerating it silently would
reinterpret every embedding already stored.
