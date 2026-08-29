"""
Taking the shared direction out of the space and putting it back as one number.

Centring alone reads better and ranks worse, which says the component it removes
is carrying something — typicality, the degree to which a track is the kind of
thing people play. That is worth one dimension. It is not worth most of them,
which is what it currently occupies: everything sits in the same corner of the
space, so a large part of every comparison is two songs agreeing that they are
songs.

So: subtract the mean direction, and append the projection onto it as an
explicit coordinate. Same information, one dimension instead of pervading all of
them, and the rest of the space free to encode difference.
"""
import json, random, statistics
import numpy as np

from bigtrain import corpus, sittings
from splitemb import held_out_embedding
from affinity import artist_album_of, CANDIDATES
from affinity2 import cases_for, rank_of


def unit(v, axis=-1):
    return v / (np.linalg.norm(v, axis=axis, keepdims=True) + 1e-8)


def split_typicality(emb, weight=1.0):
    """Centred direction, plus typicality as its own coordinate."""
    mean = emb.mean(0)
    axis = mean / (np.linalg.norm(mean) + 1e-8)
    typical = emb @ axis                      # how much of the shared direction
    centred = emb - np.outer(typical, axis)   # what is left once it is removed
    # scale so the one dimension does not swamp the rest, nor vanish into them
    scaled = (typical - typical.mean()) / (typical.std() + 1e-8) * weight
    return unit(np.concatenate([unit(centred), scaled[:, None]], axis=1))


def score(e, cases):
    allr, freshr = [], []
    for c in cases:
        taste = unit(e[c['history']].mean(0))
        rows = [c['target']] + c['negatives']
        r = rank_of(np.array([float(taste @ e[x]) for x in rows]))
        allr.append(r)
        if not c['known_artist']:
            freshr.append(r)
    return (statistics.mean(1 / r for r in allr),
            statistics.mean(1 / r for r in freshr),
            sum(1 for r in freshr if r <= 10) / len(freshr) * 100)


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    groups = sittings(json.load(open("lb-listens.json")), index)
    # Trained on the 80% it does not build cases from, for the same reason.
    emb, _, test_groups = held_out_embedding(matrix, groups, seed=5)

    # how much of the space is the shared direction actually taking up?
    centred = emb - emb.mean(0)
    _, sv, _ = np.linalg.svd(centred, full_matrices=False)
    var = sv ** 2 / (sv ** 2).sum()
    mean_norm = np.linalg.norm(emb.mean(0))
    print(f"embedding is {emb.shape[1]}-dimensional and unit length")
    print(f"  length of the mean vector:            {mean_norm:.3f}"
          f"   ({mean_norm**2*100:.0f}% of a unit vector's energy is the shared direction)")
    print(f"  first component after centring:       {var[0]*100:.1f}% of the remaining variance")
    print(f"  components to reach 90%:              {int(np.searchsorted(np.cumsum(var), 0.9)) + 1} of {len(var)}")

    cases = cases_for(test_groups, meta, random.Random(5))
    print(f"\n{len(cases)} cases\n")

    forms = {"raw (as shipped)": unit(emb), "centred only": unit(centred)}
    for w in (0.25, 0.5, 1.0, 2.0):
        forms[f"centred + typicality x{w}"] = split_typicality(emb, w)

    print(f"{'representation':30}{'dims':>6}{'MRR all':>10}{'MRR new':>10}{'top10 new':>11}")
    print('-' * 67)
    for name, e in forms.items():
        a, b, c = score(e, cases)
        print(f"{name:30}{e.shape[1]:6}{a:10.3f}{b:10.3f}{c:10.1f}%")
