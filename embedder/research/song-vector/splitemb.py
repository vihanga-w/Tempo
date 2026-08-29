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
import hashlib
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
    order = list(range(len(groups)))
    rng.shuffle(order)
    cut = int(len(order) * frac)

    # Membership is random; order is not. `sittings` emits each listener's
    # sittings oldest first, and `cases_for` takes the last one as the play to
    # predict and the earlier ones as history — so handing it a shuffled list
    # made "the latest sitting" an arbitrary one and put future listening into
    # the history it is scored against. Sorting each side back into corpus
    # order keeps the random split and restores the chronology.
    train_groups = [groups[i] for i in sorted(order[:cut])]
    test_groups = [groups[i] for i in sorted(order[cut:])]

    # Row count alone does not prove the rows are the same tracks, nor that the
    # tower was trained on this split. Both change without changing the count —
    # a corpus edit that swaps one track, a listening dump refreshed overnight —
    # and a stale cache then reports confident numbers about the wrong songs.
    # So the name carries a digest of the corpus and of the training split.
    fingerprint = hashlib.sha1()
    fingerprint.update(np.ascontiguousarray(matrix, dtype=np.float32).tobytes())
    fingerprint.update(repr(train_groups).encode())
    fingerprint.update(f"{seed}|{frac!r}|{epochs}|{batch}".encode())
    cache = f"emb-split-{fingerprint.hexdigest()[:16]}.npy"

    if os.path.exists(cache):
        cached = np.load(cache)
        if len(cached) == matrix.shape[0]:
            return cached, train_groups, test_groups

    a, b, y = P.pairs_from(train_groups, rng, 1, matrix.shape[0])
    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a, b, y, epochs=epochs, batch=batch)
    emb, _ = tower.forward(matrix)
    np.save(cache, emb)

    return emb, train_groups, test_groups
