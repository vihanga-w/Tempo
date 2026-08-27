"""
Does the song vector say anything the listener's own history does not?

Artist affinity is the obvious rival and a much cheaper one: count how often
somebody has played an artist and rank that artist's tracks higher. If the
learned vector cannot beat a counter, it is not earning the metadata pipeline
behind it — and if it can, the interesting number is how much it adds *on top*
of the counter rather than instead of it.

The task is the one a feed actually performs. Take a listener's history up to a
point, take the track they played next, and rank it against candidates drawn
with the same popularity profile. Affinities are shrunk towards the population
mean, so somebody with four plays does not read as a devotee of one artist.
"""
import json, math, random, statistics
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings

SHRINK = 8.0            # plays before an affinity is taken at face value
CANDIDATES = 60


def artist_album_of(index):
    """row -> (artist id, album id), from whichever catalogue described it."""
    out = {}
    deezer = {k: v for k, v in json.load(open("group-deezer.json")).items() if v}
    for sid, t in deezer.items():
        row = index.get(("spotify", sid))
        if row is not None:
            out[row] = (str((t.get("artist") or {}).get("id")), str((t.get("album") or {}).get("id")))
    for tracks in json.load(open("artist-catalogues.json")).values():
        for t in tracks:
            row = index.get(("deezer", str(t["id"])))
            if row is not None and row not in out:
                out[row] = (str((t.get("artist") or {}).get("id")), str((t.get("album") or {}).get("id")))
    return out


def build_cases(groups, index, meta, rng, limit=6000):
    """One case per held-out play, with the listener's earlier plays as history."""
    by_user = {}
    for user, ids in groups:
        by_user.setdefault(user, []).append(ids)

    plays_pool = [row for _, ids in groups for row in ids]
    cases = []

    for user, sits in by_user.items():
        if len(sits) < 3:
            continue
        history = [row for s in sits[:-1] for row in s]
        if len(history) < 10:
            continue
        target_sitting = sits[-1]
        for target in target_sitting[:2]:
            negatives = [rng.choice(plays_pool) for _ in range(CANDIDATES)]
            cases.append((history, target, negatives))
            if len(cases) >= limit:
                return cases
    return cases


def affinity_maps(history, meta):
    artist, album = {}, {}
    for row in history:
        a, b = meta.get(row, (None, None))
        if a:
            artist[a] = artist.get(a, 0) + 1
        if b:
            album[b] = album.get(b, 0) + 1
    return artist, album


def evaluate(emb, index, meta, groups, rng):
    cases = build_cases(groups, index, meta, rng)
    print(f"{len(cases)} cases, {CANDIDATES} candidates each")

    scorers = {
        "artist affinity": lambda row, art, alb, taste: art.get(meta.get(row, (None, None))[0], 0),
        "album affinity":  lambda row, art, alb, taste: alb.get(meta.get(row, (None, None))[1], 0),
        "vector cosine":   lambda row, art, alb, taste: float(taste @ emb[row]),
    }

    rows, labels = [], []
    ranks = {k: [] for k in list(scorers) + ["artist + vector", "all three"]}

    for history, target, negatives in cases:
        art, alb = affinity_maps(history, meta)
        n = len(history)
        taste = emb[history].mean(0)
        taste /= np.linalg.norm(taste) + 1e-8

        feats = {}
        for name, fn in scorers.items():
            raw = np.array([fn(r, art, alb, taste) for r in [target] + negatives], dtype=float)
            if name != "vector cosine":
                raw = raw / (n + SHRINK)          # shrunk towards nothing
            feats[name] = raw

        for name in scorers:
            ranks[name].append(1 + int((feats[name][1:] > feats[name][0]).sum()))
        combo = feats["artist affinity"] * 6 + feats["vector cosine"]
        ranks["artist + vector"].append(1 + int((combo[1:] > combo[0]).sum()))
        combo2 = (feats["artist affinity"] + feats["album affinity"]) * 6 + feats["vector cosine"]
        ranks["all three"].append(1 + int((combo2[1:] > combo2[0]).sum()))

        rows.append([feats[n_][0] for n_ in scorers] + [1.0])
        labels.append(1)
        for k in range(1, CANDIDATES + 1):
            rows.append([feats[n_][k] for n_ in scorers] + [1.0])
            labels.append(0)

    print(f"\n{'scorer':26}{'MRR':>8}{'top 1':>8}{'top 5':>8}{'top 10':>8}")
    print('-' * 58)
    print(f"{'chance':26}{statistics.mean(1/r for r in range(1, CANDIDATES+2)):8.3f}"
          f"{1/(CANDIDATES+1)*100:7.1f}%{5/(CANDIDATES+1)*100:7.1f}%{10/(CANDIDATES+1)*100:7.1f}%")
    for name, rs in ranks.items():
        print(f"{name:26}{statistics.mean(1/r for r in rs):8.3f}"
              f"{sum(1 for r in rs if r == 1)/len(rs)*100:7.1f}%"
              f"{sum(1 for r in rs if r <= 5)/len(rs)*100:7.1f}%"
              f"{sum(1 for r in rs if r <= 10)/len(rs)*100:7.1f}%")
    return np.array(rows), np.array(labels)


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    groups = sittings(json.load(open("lb-listens.json")), index)
    rng = random.Random(5)
    rng.shuffle(groups)
    cut = int(len(groups) * 0.8)

    plays = [row for _, ids in groups[:cut] for row in ids]
    rng2 = random.Random(3)
    from bigablate import pairs
    a_tr, b_tr, y_tr = pairs(groups[:cut], rng2, matrix.shape[0], plays, True)

    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a_tr, b_tr, y_tr, epochs=10, batch=1024)
    emb, _ = tower.forward(matrix)

    evaluate(emb, index, meta, groups[cut:], rng)
