"""
A listener's taste as a point in the same space as the songs.

The song vectors are deliberately ignorant of who is listening, so a listener
has to be described by which songs they pull towards. That is the shape the
previous solution used, and the weights are the ones already in
createUserEmbedding: how much of a track played counts most, a replay counts
extra, a skip counts against in proportion to how quickly it came.

The test is the one that matters for a feed: score every candidate against a
listener's taste as it stood before they played it, and see whether the score
says anything about how the play went.
"""
import json, math, random, statistics
import numpy as np

from pairmodel import Tower, auc, build, pairs_from, train
import songvec
from songvec import DIMS


def play_weight(item):
    """The weighting createUserEmbedding applies, on the fields history keeps."""
    d = max(0.0, min(1.0, item.get("sessionDuration", 0)))
    w = 6.0 * d
    if item.get("replayed"):
        w += 2.5
    if item.get("skipped"):
        w -= 0.5 * max(0.1, 1 - d)
    return w


def engagement(item):
    e = max(0.0, min(1.0, item.get("sessionDuration", 0)))
    if item.get("replayed"):
        e += 1.0
    if item.get("skipped"):
        e *= 0.25
    return e


def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    rx, ry = rank(xs), rank(ys)
    mx, my = statistics.mean(rx), statistics.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else 0.0


def bootstrap_rho(xs, ys, rounds=3000, seed=5):
    rng = random.Random(seed)
    n = len(xs)
    out = sorted(spearman(*zip(*[(xs[i], ys[i]) for i in (rng.randrange(n) for _ in range(n))]))
                 for _ in range(rounds))
    return out[int(rounds * .025)], out[int(rounds * .975)]


def fit_cases(emb, index, hist, only=None):
    """Every time somebody played a track a friend had played first.

    `only` restricts the listener scored, so a leave-one-listener-out model can
    be applied to exactly the listener it was not trained on.
    """
    cases = []
    for uid, rows in hist.items():
        if only is not None and uid != only:
            continue
        others = sorted(((r["timestamp"], u, r) for u, v in hist.items() if u != uid for r in v),
                        key=lambda x: x[0])
        played = set()
        weights = {}           # song index -> accumulated weight
        friend_seen = set()
        cursor = 0

        for row in rows:
            now = row["timestamp"]
            while cursor < len(others) and others[cursor][0] < now:
                friend_seen.add(others[cursor][2]["item"]["track"]["id"])
                cursor += 1

            tid = row["item"]["track"]["id"]

            if (tid not in played and tid in friend_seen and tid in index
                    and len(weights) >= 10):
                idx = np.array(list(weights))
                w = np.array([weights[i] for i in idx], dtype=np.float32)
                w = np.maximum(w, 0)
                if w.sum() > 0:
                    taste = (emb[idx] * w[:, None]).sum(0)
                    taste /= np.linalg.norm(taste) + 1e-8
                    cases.append({
                        'user': uid,
                        'score': float(taste @ emb[index[tid]]),
                        'fit': engagement(row["item"]),
                    })

            played.add(tid)
            if tid in index:
                weights[index[tid]] = weights.get(index[tid], 0.0) + play_weight(row["item"])
    return cases


def normed(m):
    return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)


def cross_validate(matrix, groups, folds=5, epochs=40, seed=11):
    """Held out by sitting, and every sitting gets a turn.

    Fifty sittings is not many to split once — a single split puts a dozen in
    test and the answer moves several points on which dozen. Every sitting is
    held out exactly once instead, and the spread across folds is reported
    rather than hidden.
    """
    rng = random.Random(seed)
    shuffled = list(groups)
    rng.shuffle(shuffled)
    n = matrix.shape[0]
    raw_n = normed(matrix)
    gb = len(songvec.GENRES) + 2
    g_n = normed(matrix[:, :gb])

    results = {"learned": [], "raw metadata cosine": [], "genre block alone": []}
    embeddings = []

    for fold in range(folds):
        test = shuffled[fold::folds]
        trainset = [g for g in shuffled if g not in test]
        a_tr, b_tr, y_tr = pairs_from(trainset, rng, 2, n)
        a_te, b_te, y_te = pairs_from(test, rng, 2, n)
        if not len(y_te) or not y_te.any():
            continue

        tower = Tower(matrix.shape[1], seed=fold)
        train(tower, matrix, a_tr, b_tr, y_tr, epochs=epochs, seed=fold)
        emb, _ = tower.forward(matrix)
        embeddings.append(emb)

        results["learned"].append(auc((emb[a_te] * emb[b_te]).sum(1), y_te))
        results["raw metadata cosine"].append(auc((raw_n[a_te] * raw_n[b_te]).sum(1), y_te))
        results["genre block alone"].append(auc((g_n[a_te] * g_n[b_te]).sum(1), y_te))
        print(f"  fold {fold + 1}: learned {results['learned'][-1]:.3f}  "
              f"raw {results['raw metadata cosine'][-1]:.3f}  "
              f"({len(trainset)} sittings train, {len(test)} test)")

    return results, embeddings


if __name__ == "__main__":
    sv, matrix, index, groups, hist = build()
    print(f"{matrix.shape[0]} songs, {len(DIMS)} dimensions, {len(groups)} sittings\n")

    results, embeddings = cross_validate(matrix, groups)

    print(f"\n{'do two songs go together?':28}{'AUC':>8}{'spread over folds':>22}")
    print('-' * 58)
    print(f"{'chance':28}{0.500:8.3f}")
    for label in ["genre block alone", "raw metadata cosine", "learned"]:
        vals = results[label]
        print(f"{label:28}{statistics.mean(vals):8.3f}{min(vals):12.3f}-{max(vals):.3f}")

    # Held out by listener, not by sitting.
    #
    # The folds above hold out a sitting at a time, which is the right split for
    # "do two songs go together" — but every fold model still trains on the rest
    # of that listener's history, and the taste test scores a listener against
    # their own history. Averaging the fold models and scoring everybody with
    # the average therefore graded each case with models that had read it.
    #
    # So each listener is scored by a model trained only on the other listeners.
    # Five accounts means five models and less training data in each, which
    # costs accuracy honestly rather than borrowing it.
    listeners = sorted({uid for uid, _ in groups})
    cases = []

    print(f"\nleave-one-listener-out, {len(listeners)} listeners")

    for uid in listeners:
        trainset = [g for g in groups if g[0] != uid]

        if not trainset:
            continue

        rng = random.Random(listeners.index(uid))     # stable across runs, unlike hash()
        a_tr, b_tr, y_tr = pairs_from(trainset, rng, 2, matrix.shape[0])

        if not len(y_tr):
            continue

        tower = Tower(matrix.shape[1], seed=0)
        train(tower, matrix, a_tr, b_tr, y_tr, epochs=40, seed=0)
        emb, _ = tower.forward(matrix)
        mine = fit_cases(normed(emb), index, hist, only=uid)
        print(f"  {uid[:18]:20} {len(mine):4} cases scored by a model "
              f"trained on the other {len(listeners) - 1}")
        cases += mine

    if cases:
        xs = [c['score'] for c in cases]
        ys = [c['fit'] for c in cases]
        lo, hi = bootstrap_rho(xs, ys)
        print(f"\ndoes taste distance say how a play went?")
        print(f"  {len(cases)} friend-sourced plays   rho {spearman(xs, ys):+.3f}   [{lo:+.3f}, {hi:+.3f}]")
    else:
        print("\nno cases survived the listener holdout")
