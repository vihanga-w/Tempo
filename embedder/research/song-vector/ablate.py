"""
Which parts of the song vector are carrying the signal, and which are ballast.

Each block is zeroed in turn and the model retrained around it. A block whose
removal costs nothing is a block that was contributing nothing, and forty
dimensions of mostly-nothing is worse than twelve of something: it is more to
fetch, more to keep current, and more room for the model to overfit.
"""
import random, statistics
import numpy as np

import pairmodel as P, songvec, tastevec as T


def blocks():
    n = len(songvec.GENRES)
    return {
        "genre":       list(range(0, n + 2)),
        "era":         [n + 2, n + 3, n + 4, n + 5],
        "popularity":  [n + 6, n + 7, n + 8],
        "duration":    [n + 9, n + 10, n + 11],
        "explicit":    [n + 12, n + 13],
        "credits":     [n + 14, n + 15],
        "gain":        [n + 16, n + 17],
        "bpm":         [n + 18, n + 19],
    }


def score(matrix, groups, folds=5, epochs=40, seed=11):
    rng = random.Random(seed)
    shuffled = list(groups)
    rng.shuffle(shuffled)
    n = matrix.shape[0]
    out = []
    for fold in range(folds):
        test = shuffled[fold::folds]
        trainset = [g for g in shuffled if g not in test]
        a_tr, b_tr, y_tr = P.pairs_from(trainset, rng, 2, n)
        a_te, b_te, y_te = P.pairs_from(test, rng, 2, n)
        if not len(y_te) or not y_te.any():
            continue
        tower = P.Tower(matrix.shape[1], seed=fold)
        P.train(tower, matrix, a_tr, b_tr, y_tr, epochs=epochs, seed=fold)
        emb, _ = tower.forward(matrix)
        out.append(P.auc((emb[a_te] * emb[b_te]).sum(1), y_te))
    return statistics.mean(out), min(out), max(out)


if __name__ == "__main__":
    import io, contextlib

    sv, matrix, index, groups, hist = P.build()
    quiet = contextlib.redirect_stdout(io.StringIO())

    with quiet:
        full = score(matrix, groups)
    print(f"{'vector':34}{'AUC':>8}{'change':>10}{'fold spread':>18}")
    print('-' * 70)
    print(f"{'everything (46 dims)':34}{full[0]:8.3f}{'':>10}{full[1]:9.3f}-{full[2]:.3f}")

    for name, cols in blocks().items():
        stripped = matrix.copy()
        stripped[:, cols] = 0
        with quiet:
            got = score(stripped, groups)
        print(f"{'without ' + name:34}{got[0]:8.3f}{got[0]-full[0]:+10.3f}{got[1]:9.3f}-{got[2]:.3f}")

    # and the other direction: each block on its own
    print()
    for name, cols in blocks().items():
        only = np.zeros_like(matrix)
        only[:, cols] = matrix[:, cols]
        with quiet:
            got = score(only, groups)
        print(f"{name + ' alone':34}{got[0]:8.3f}{got[0]-full[0]:+10.3f}{got[1]:9.3f}-{got[2]:.3f}")
