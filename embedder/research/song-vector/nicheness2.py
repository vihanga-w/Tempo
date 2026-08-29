"""
Which summary of "how niche" actually discriminates, and is the gain real?

The mean is the obvious statistic and the first pass showed it is a very stable
trait (split-half r +0.99) that nonetheless spreads listeners over a narrow band.
Reliable is not the same as discriminating. A listener who is mostly chart-pop
with a deep-cut streak has the same mean as one who is uniformly mid, and they
are not the same listener — so the low quantiles and the spread are tried too.

Then the one gain worth having is bootstrapped, because +0.008 MRR on a thousand
cases is exactly the size that a single split invents.
"""
import hashlib, json, math, os, random, statistics
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings
from affinity import CANDIDATES

CACHE = "nicheness-cache.npz"
MIN_HISTORY = 25
SEED = 13


def tie_rank(values):
    target, rest = values[0], values[1:]
    return 1 + int((rest > target).sum()) + int((rest == target).sum()) / 2


def pearson(xs, ys):
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    den = math.sqrt(sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys))
    return num / den if den else 0.0


def prepare():
    matrix, index = corpus()
    listens = json.load(open("lb-listens.json"))
    groups = sittings(listens, index)

    # Row ids address this matrix, so a cache built against a different corpus
    # points at different tracks and the script reports confident numbers about
    # the wrong songs. Row count does not catch a same-size corpus edit or a
    # refreshed listening dump, so the cache carries a digest of both and is
    # rejected when either has moved.
    listeners = sorted({user for user, _ in groups})
    order = list(listeners)
    random.Random(SEED).shuffle(order)
    held_out = set(order[int(len(order) * 0.8):])

    want = hashlib.sha1()
    want.update(np.ascontiguousarray(matrix, dtype=np.float32).tobytes())
    want.update(repr(groups).encode())
    want.update(repr(sorted(held_out)).encode())
    want = want.hexdigest()

    stored = np.load(CACHE, allow_pickle=False) if os.path.exists(CACHE) else None
    cached = stored["emb"] if stored is not None and "fingerprint" in stored and \
        str(stored["fingerprint"]) == want else None

    if cached is not None and len(cached) == matrix.shape[0]:
        emb = cached
    else:
        # Held out by listener rather than by sitting. Splitting on sittings
        # still let the tower read other sittings by the same person the cases
        # below score, so their target plays sat in the training pairs.
        rng = random.Random(SEED)
        rng.shuffle(order)
        a, b, y = P.pairs_from([g for g in groups if g[0] not in held_out],
                               rng, 1, matrix.shape[0])
        tower = P.Tower(matrix.shape[1], seed=0)
        P.train(tower, matrix, a, b, y, epochs=12, batch=1024)
        emb, _ = tower.forward(matrix)
        np.savez(CACHE, emb=emb, fingerprint=want)

    return matrix, emb, groups, held_out


STATS = {
    "mean":           lambda r: float(r.mean()),
    "10th pct":       lambda r: float(np.quantile(r, 0.10)),
    "25th pct":       lambda r: float(np.quantile(r, 0.25)),
    "median":         lambda r: float(np.median(r)),
    "spread (sd)":    lambda r: float(r.std()),
    "share below .7": lambda r: float((r < 0.7).mean()),
}


def main():
    matrix, emb, groups, held_out = prepare()
    rank = matrix[:, songvec.DIMS.index("rank_pct")].astype(np.float64)

    by_user = {}
    for user, ids in groups:
        by_user.setdefault(user, []).extend(ids)

    # ---- which summary is both stable and spread out?
    print("A trait is only useful if it is measured reliably AND separates people.\n")
    print(f"{'statistic':18}{'split-half r':>14}{'sd between':>12}{'range':>18}")
    print("-" * 62)

    # Section A describes the corpus, so every listener counts. Section B scores
    # the model, so only the listeners it never trained on may be used.
    scoreable = {u: p for u, p in by_user.items() if u in held_out}

    long_users = [u for u, p in by_user.items() if len(p) >= 4 * MIN_HISTORY]
    for name, f in STATS.items():
        a, b, whole = [], [], []
        for u in long_users:
            p = by_user[u]
            a.append(f(rank[p[0::2]]))
            b.append(f(rank[p[1::2]]))
            whole.append(f(rank[p]))
        print(f"{name:18}{pearson(a, b):+14.3f}{statistics.pstdev(whole):12.3f}"
              f"{min(whole):11.2f} to {max(whole):.2f}")

    # ---- does the best-separating one rank better, and is the gain real?
    users = [u for u, p in scoreable.items() if len(p) >= MIN_HISTORY + 5]
    pool = [row for _, ids in groups for row in ids]
    r = random.Random(SEED + 1)

    def cases(regime, limit=4000):
        out = []
        for user in users:
            plays = scoreable[user]
            history, targets = plays[:-5], plays[-5:]
            if len(history) < MIN_HISTORY:
                continue
            for target in targets:
                if regime == "global":
                    negs = [r.choice(pool) for _ in range(CANDIDATES)]
                else:
                    # users can be a single listener once the holdout is
                    # applied to a small cohort, and this loop would then spin
                    # forever looking for somebody else. The caller skips the
                    # regime in that case; this is the belt as well as braces.
                    others = [u for u in users if u != user]
                    if not others:
                        return out
                    friend = r.choice(others)
                    negs = [r.choice(scoreable[friend]) for _ in range(CANDIDATES)]
                out.append((history, target, negs))
                if len(out) >= limit:
                    return out
        return out

    for regime in ("global", "one friend"):
        # One eligible listener cannot supply a different listener's plays, and
        # an empty case set has no mean worth printing. Both are reachable once
        # the listener holdout is applied to a small cohort.
        if regime == "one friend" and len(users) < 2:
            print(f"\n{regime}: skipped, only {len(users)} held-out listener "
                  f"meets the history threshold")
            continue

        cs = cases(regime)

        if not cs:
            print(f"\n{regime}: no cases")
            continue

        cut = len(cs) // 2
        print(f"\nnegatives from the {regime} play distribution "
              f"({len(cs)} cases, {CANDIDATES} candidates)")
        print(f"{'scorer':30}{'MRR':>8}{'gain':>9}{'95% CI of the gain':>24}")
        print("-" * 71)

        vecs, base = [], []
        for history, target, negs in cs:
            taste = emb[history].mean(0)
            taste /= np.linalg.norm(taste) + 1e-8
            rows = np.array([target] + negs)
            v = emb[rows] @ taste
            vecs.append((v, rank[history], rank[rows]))
            base.append(1.0 / tie_rank(v))
        print(f"{'vector alone':30}{statistics.mean(base):8.3f}")

        for name, f in STATS.items():
            terms = [-np.abs(f(h) - s) for v, h, s in vecs]
            best_w, best_v = 0.0, -1.0
            for w in (0.0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2):
                got = statistics.mean(1.0 / tie_rank(vecs[i][0] + w * terms[i])
                                      for i in range(cut))
                if got > best_v:
                    best_w, best_v = w, got

            held = [1.0 / tie_rank(vecs[i][0] + best_w * terms[i]) for i in range(cut, len(cs))]
            plain = base[cut:]
            diff = [h - p for h, p in zip(held, plain)]

            boot = sorted(
                statistics.mean(diff[j] for j in (rng2.randrange(len(diff)) for _ in range(len(diff))))
                for rng2 in (random.Random(1000 + k) for k in range(2000)))
            lo, hi = boot[50], boot[1949]
            mark = "" if lo <= 0 <= hi else "  <- clears zero"
            print(f"{'+ ' + name + f'  (w {best_w:g})':30}{statistics.mean(held):8.3f}"
                  f"{statistics.mean(diff):+9.4f}   [{lo:+.4f}, {hi:+.4f}]{mark}")


if __name__ == "__main__":
    main()
