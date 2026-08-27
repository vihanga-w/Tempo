"""
Which blocks matter, once there is enough listening to tell.

Negatives are drawn from the play distribution, not uniformly. Uniform
negatives make the task far too easy in a way that flatters exactly the wrong
features: everything in a real sitting is something somebody chose to play, so
a uniformly drawn track is obscure by comparison and the model can separate the
two on popularity alone without learning anything about taste. Sampling
negatives with the same popularity profile as the positives takes that shortcut
away.
"""
import json, random, statistics
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings


def pairs(groups, rng, n_songs, popularity, matched=True, neg_per_pos=1):
    a, b, y = [], [], []
    pool = popularity if matched else None
    for _, ids in groups:
        for i in range(len(ids)):
            for j in range(i + 1, min(i + 6, len(ids))):
                if ids[i] == ids[j]:
                    continue
                a.append(ids[i]); b.append(ids[j]); y.append(1.0)
                for _ in range(neg_per_pos):
                    neg = rng.choice(pool) if pool is not None else rng.randrange(n_songs)
                    a.append(ids[i]); b.append(neg); y.append(0.0)
    return np.array(a), np.array(b), np.array(y, dtype=np.float32)


def blocks():
    n = len(songvec.GENRES)
    return {
        "genre":      list(range(0, n + 2)),
        "era":        [n + 2, n + 3, n + 4, n + 5],
        "popularity": [n + 6, n + 7, n + 8],
        "duration":   [n + 9, n + 10, n + 11],
        "explicit":   [n + 12, n + 13],
        "credits":    [n + 14, n + 15],
        "gain":       [n + 16, n + 17],
        "bpm":        [n + 18, n + 19],
    }


if __name__ == "__main__":
    matrix, index = corpus()
    groups = sittings(json.load(open("lb-listens.json")), index)
    rng = random.Random(7)
    rng.shuffle(groups)
    cut = int(len(groups) * 0.8)

    # how often each track is actually played, for drawing negatives
    plays = [row for _, ids in groups[:cut] for row in ids]
    print(f"{len(groups)} sittings, {len(plays)} plays\n")

    sets = {}
    for label, matched in [("uniform negatives", False), ("popularity-matched negatives", True)]:
        rng2 = random.Random(3)
        sets[label] = (pairs(groups[:cut], rng2, matrix.shape[0], plays, matched),
                       pairs(groups[cut:], rng2, matrix.shape[0], plays, matched))

    def auc_of(cols, train_set, test_set, epochs=10):
        m = matrix[:, cols]
        a_tr, b_tr, y_tr = train_set
        a_te, b_te, y_te = test_set
        tower = P.Tower(m.shape[1], seed=0)
        P.train(tower, m, a_tr, b_tr, y_tr, epochs=epochs, batch=1024)
        emb, _ = tower.forward(m)
        return P.auc((emb[a_te] * emb[b_te]).sum(1), y_te)

    B = blocks()
    everything = sorted({c for v in B.values() for c in v})

    print(f"{'vector':32}{'uniform neg':>13}{'popularity-matched':>21}")
    print('-' * 66)
    results = {}
    for label, cols in [("everything", everything), ("genre only", B["genre"])]:
        row = [auc_of(cols, *sets[k]) for k in sets]
        results[label] = row
        print(f"{label:32}{row[0]:13.3f}{row[1]:21.3f}")

    print()
    full = results["everything"][1]
    for name, cols in B.items():
        rest = [c for c in everything if c not in cols]
        got = auc_of(rest, *sets["popularity-matched negatives"])
        print(f"{'without ' + name:32}{got:13.3f}{got - full:+21.3f}")
