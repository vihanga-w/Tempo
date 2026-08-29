"""
One embedding per split, so no evaluator can read one trained on its test set.

There used to be a single `emb.npy`, written by whichever script ran first and
read by everything else. `vonga_feed.py` trains on every sitting because it is
building a feed, not measuring one; `calibrate.py` and `typicality.py` then read
that file while holding the last 20% of the same sittings out. Their held-out
numbers had been trained on, and nothing in the file said so.

The cache name now carries the split it was trained on, so a held-out evaluator
that asks for one and a demo that asks for everything cannot collide.
"""
import os

import numpy as np

import pairmodel as P


def held_out_embedding(matrix, groups, seed, frac=0.8, epochs=12, batch=1024):
    """Train on the first `frac` of `groups` shuffled by `seed`; return the rows.

    Returns (embedding, training groups, held-out groups) so the caller scores
    the same split the tower never saw.
    """
    import random

    rng = random.Random(seed)
    shuffled = list(groups)
    rng.shuffle(shuffled)
    cut = int(len(shuffled) * frac)
    train_groups, test_groups = shuffled[:cut], shuffled[cut:]

    cache = f"emb-split-{seed}-{int(frac * 100)}.npy"

    if os.path.exists(cache):
        cached = np.load(cache)
        # Row ids address this matrix, so a cache built against a different
        # corpus points at different tracks. Shape is enough to catch it.
        if len(cached) == matrix.shape[0]:
            return cached, train_groups, test_groups

    a, b, y = P.pairs_from(train_groups, rng, 1, matrix.shape[0])
    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a, b, y, epochs=epochs, batch=batch)
    emb, _ = tower.forward(matrix)
    np.save(cache, emb)

    return emb, train_groups, test_groups
