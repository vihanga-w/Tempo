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
    """Train on `frac` of the listeners, chosen by `seed`; return the rows.

    Returns (embedding, training groups, held-out groups) so the caller scores
    listeners the tower never read at all.
    """
    import random

    # Split listeners, not sittings, and keep each side in corpus order.
    #
    # Two things went wrong here in turn. Splitting sitting indexes let the
    # tower train on other sittings by the very listeners scored through
    # cases_for, because `sittings` emits several per listener. And shuffling
    # the returned list broke the chronology cases_for depends on: it reads the
    # last sitting as the play to predict and the earlier ones as history, so a
    # shuffled list made "the latest sitting" an arbitrary one and put later
    # listening into the history it is scored against.
    rng = random.Random(seed)
    listeners = sorted({user for user, _ in groups})
    rng.shuffle(listeners)
    held_out = set(listeners[int(len(listeners) * frac):])

    train_groups = [g for g in groups if g[0] not in held_out]
    test_groups = [g for g in groups if g[0] in held_out]

    # Row count alone does not prove the rows are the same tracks, nor that the
    # tower was trained on this split. Both change without changing the count —
    # a corpus edit that swaps one track, a listening dump refreshed overnight —
    # and a stale cache then reports confident numbers about the wrong songs.
    # So the name carries a digest of the corpus and of the training split.
    fingerprint = hashlib.sha1()
    fingerprint.update(np.ascontiguousarray(matrix, dtype=np.float32).tobytes())
    fingerprint.update(repr(train_groups).encode())
    fingerprint.update(f"{seed}|{frac!r}|{epochs}|{batch}".encode())
    # No len(listeners) term is needed because pairs_from below draws from its
    # own RNG rather than the one the shuffle advanced. Sharing the generator
    # meant holding out one more listener changed every training pair while
    # train_groups, and so the digest, stayed the same.
    cache = f"emb-split-{fingerprint.hexdigest()[:16]}.npy"

    if os.path.exists(cache):
        cached = np.load(cache)
        if len(cached) == matrix.shape[0]:
            return cached, train_groups, test_groups

    a, b, y = P.pairs_from(train_groups, random.Random(seed), 1, matrix.shape[0])
    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a, b, y, epochs=epochs, batch=batch)
    emb, _ = tower.forward(matrix)
    np.save(cache, emb)

    return emb, train_groups, test_groups
