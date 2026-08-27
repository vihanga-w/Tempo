"""
Reading the similarity number correctly.

Cosine between two of these embeddings is never near zero and never negative in
practice: every feature is non-negative, so every vector sits in the same corner
of the space and they all share a large component that just means "this is a
song". Two listeners with nothing in common came out at +0.426, which reads as
half-similar and is not.

Three ways to take that shared component out, scored on whether they improve the
ranking rather than on whether the numbers look nicer:

  centred    subtract the corpus mean, so the origin is the average song rather
             than silence, and a below-average match can come out negative
  whitened   centre, then divide each dimension by its spread, so a dimension
             that barely varies stops dominating the dot product
  ranked     leave the geometry alone and report where a score falls in the
             distribution of all scores, which is what a percentile is for
"""
import json, random, statistics
import numpy as np

import pairmodel as P
from bigtrain import corpus, sittings
from affinity import artist_album_of, SHRINK, CANDIDATES
from affinity2 import cases_for, rank_of


def variants(emb):
    centred = emb - emb.mean(0)
    whitened = centred / (emb.std(0) + 1e-6)
    return {
        "raw": emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-8),
        "centred": centred / (np.linalg.norm(centred, axis=1, keepdims=True) + 1e-8),
        "whitened": whitened / (np.linalg.norm(whitened, axis=1, keepdims=True) + 1e-8),
    }


def user_taste(rows, e):
    t = e[list(rows)].mean(0)
    return t / (np.linalg.norm(t) + 1e-8)


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    emb = np.load("emb.npy")
    forms = variants(emb)

    groups = sittings(json.load(open("lb-listens.json")), index)
    rng = random.Random(5)
    rng.shuffle(groups)
    cut = int(len(groups) * 0.8)
    cases = cases_for(groups[cut:], meta, rng)
    known = [c for c in cases if c['known_artist']]
    fresh = [c for c in cases if not c['known_artist']]
    print(f"{len(cases)} cases ({len(fresh)} on a new artist)\n")

    print(f"{'reading of the cosine':18}{'MRR all':>10}{'MRR new artist':>16}{'top 10, new':>13}")
    print('-' * 58)
    for name, e in forms.items():
        allr, freshr = [], []
        for c in cases:
            taste = user_taste(c['history'], e)
            rows = [c['target']] + c['negatives']
            v = np.array([float(taste @ e[r]) for r in rows])
            r = rank_of(v)
            allr.append(r)
            if not c['known_artist']:
                freshr.append(r)
        print(f"{name:18}{statistics.mean(1/r for r in allr):10.3f}"
              f"{statistics.mean(1/r for r in freshr):16.3f}"
              f"{sum(1 for r in freshr if r <= 10)/len(freshr)*100:12.1f}%")

    # what the number means between two listeners
    hist = json.load(open("friends-history.json"))
    who = {"Vonga": "yh1q376ly901c0qk03n9kaphh", "Sorcha": "dcfc1wdwx310qgps19sm60xvn",
           "dylan": "nfsind1dp1j2x5ak8a820e6pt", "Ricky2009": "31s4ae2k5xzbjbdja5zqcy4qpkrm"}
    rows_of = {}
    for n, u in who.items():
        rs = [index.get(("spotify", r["item"]["track"]["id"])) for r in hist[u]]
        rows_of[n] = [r for r in rs if r is not None]

    print(f"\nsimilarity between listeners")
    print(f"{'pair':24}" + "".join(f"{k:>12}" for k in forms))
    for a in who:
        for b in who:
            if a >= b:
                continue
            line = f"{a + ' / ' + b:24}"
            for name, e in forms.items():
                line += f"{float(user_taste(rows_of[a], e) @ user_taste(rows_of[b], e)):12.3f}"
            print(line)

    # and the spread each reading produces across random song pairs, which is
    # what makes a number readable at all
    print(f"\nspread of song-to-song similarity over 20000 random pairs")
    r2 = random.Random(1)
    idx = [(r2.randrange(len(emb)), r2.randrange(len(emb))) for _ in range(20000)]
    for name, e in forms.items():
        vals = np.array([float(e[i] @ e[j]) for i, j in idx])
        print(f"  {name:12} mean {vals.mean():+.3f}  sd {vals.std():.3f}  "
              f"range {vals.min():+.2f} to {vals.max():+.2f}")
