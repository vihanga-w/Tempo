"""
Is "how niche is this listener" worth stating on the user vector?

The taste vector is the weighted mean of the *learned* embeddings of what
somebody played, normalised. Average rank is therefore already in it in some
form — the question is whether the tower kept it, whether it is a stable trait
of a listener at all, and whether saying it outright ranks better.

Three questions, in the order that decides the answer:

  1. recoverable   can rank_pct be read back out of the 16-dim embedding?
  2. stable        is a listener's average rank a trait, or is it noise?
  3. useful        does an explicit nicheness term rank better, and where?

The negative pool matters more than anything else here. Drawn from the global
play distribution the candidates are already popularity-matched, which removes
by construction the very thing being tested. The friend feed is not like that:
candidates come from one other listener, and their nicheness is whatever that
person's is. Both regimes are run.
"""
import json, math, random, statistics, sys
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings
from affinity import CANDIDATES

RANK_COL = None          # filled once the vocabulary is loaded
MIN_HISTORY = 25
SEED = 13


def mrr(rank):
    return 1.0 / rank


def tie_rank(values):
    """Target is values[0]; a tied block is counted from its middle."""
    target, rest = values[0], values[1:]
    return 1 + int((rest > target).sum()) + int((rest == target).sum()) / 2


def ridge_r2(X, y, train, test, lam=1e-3):
    A = np.concatenate([X[train], np.ones((len(train), 1), np.float32)], 1)
    w = np.linalg.solve(A.T @ A + lam * np.eye(A.shape[1]), A.T @ y[train])
    B = np.concatenate([X[test], np.ones((len(test), 1), np.float32)], 1)
    pred = B @ w
    resid = ((y[test] - pred) ** 2).sum()
    total = ((y[test] - y[test].mean()) ** 2).sum()
    return 1 - resid / total


def pearson(xs, ys):
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    den = math.sqrt(sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys))
    return num / den if den else 0.0


def main():
    global RANK_COL
    matrix, index = corpus()
    RANK_COL = songvec.DIMS.index("rank_pct")
    rank = matrix[:, RANK_COL].astype(np.float64)

    listens = json.load(open("lb-listens.json"))
    groups = sittings(listens, index)
    print(f"{matrix.shape[0]:,} describable tracks, {len(groups):,} sittings from "
          f"{len({u for u, _ in groups})} listeners")
    print(f"rank_pct is dim {RANK_COL} of {len(songvec.DIMS)}; "
          f"{(rank == 0).mean():.1%} of tracks carry no rank (and so read as maximally obscure)\n")

    # Split by listener, not by sitting, and never in place.
    #
    # Two separate leaks lived here. Shuffling `groups` in place scrambled the
    # order by_user reads below, so "the last five plays" were an arbitrary five
    # and history could contain plays recorded after them. And splitting by
    # sitting still trained the tower on other sittings by the same listener the
    # cases then score — their target plays were in the training pairs. Holding
    # out whole listeners closes both: the tower never reads anybody it is
    # judged on, and `groups` keeps its chronological order for the case builder.
    rng = random.Random(SEED)
    listeners = sorted({user for user, _ in groups})
    rng.shuffle(listeners)
    held_out = set(listeners[int(len(listeners) * 0.8):])

    train_groups = [g for g in groups if g[0] not in held_out]
    n = matrix.shape[0]
    a_tr, b_tr, y_tr = P.pairs_from(train_groups, rng, 1, n)

    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a_tr, b_tr, y_tr, epochs=12, batch=1024)
    emb, _ = tower.forward(matrix)

    # ---- 1. is nicheness still in the embedding?
    rows = np.arange(n)
    np.random.RandomState(0).shuffle(rows)
    half = n // 2
    r2 = ridge_r2(emb.astype(np.float64), rank, rows[:half], rows[half:])
    print("1. recoverable")
    print(f"   rank_pct read back out of the 16-dim embedding   R2 {r2:+.3f}")

    # against the raw vector minus its own rank column, as a ceiling on
    # "what everything else about a song says about how well known it is"
    other = np.delete(matrix, RANK_COL, 1).astype(np.float64)
    r2_raw = ridge_r2(other, rank, rows[:half], rows[half:])
    print(f"   the same from the other 45 raw dims             R2 {r2_raw:+.3f}\n")

    # ---- 2. is it a trait?
    by_user = {}
    for user, ids in groups:
        by_user.setdefault(user, []).extend(ids)

    # Section 2 describes every listener — it is about the corpus, not about the
    # model — but section 3 scores the model, so it may only use the listeners
    # the tower never trained on.
    scoreable = {u: p for u, p in by_user.items() if u in held_out}

    a_half, b_half, spreads = [], [], []
    for user, plays in by_user.items():
        if len(plays) < 4 * MIN_HISTORY:
            continue
        odd = rank[plays[0::2]]
        even = rank[plays[1::2]]
        a_half.append(odd.mean())
        b_half.append(even.mean())
        spreads.append(rank[plays].std())

    between = statistics.pstdev(a_half + b_half)
    print("2. stable")
    print(f"   {len(a_half)} listeners with {4 * MIN_HISTORY}+ describable plays")
    print(f"   split-half agreement of their mean rank_pct      r  {pearson(a_half, b_half):+.3f}")
    print(f"   spread between listeners (sd of the means)          {between:.3f}")
    print(f"   spread within a listener (mean sd of their plays)   {statistics.mean(spreads):.3f}")
    print(f"   listener means run {min(a_half):.2f} to {max(a_half):.2f}\n")

    # ---- 3. does saying it outright rank better?
    users = [u for u, p in scoreable.items() if len(p) >= MIN_HISTORY + 5]
    pool = [row for _, ids in groups for row in ids]

    def build_cases(regime, limit=3000):
        out = []
        r = random.Random(SEED + 1)
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
                    fp = scoreable[friend]
                    negs = [r.choice(fp) for _ in range(CANDIDATES)]
                out.append((user, history, target, negs))
                if len(out) >= limit:
                    return out
        return out

    forms = {
        "product  u*s":      lambda u, s: u * s,
        "closeness -|u-s|":  lambda u, s: -np.abs(u - s),
        "closeness -(u-s)^2": lambda u, s: -(u - s) ** 2,
    }

    print("3. useful")
    for regime in ("global", "one friend"):
        # One eligible listener cannot supply a different listener's plays, and
        # an empty case set has no mean worth printing. Both are reachable once
        # the listener holdout is applied to a small cohort.
        if regime == "one friend" and len(users) < 2:
            print(f"\n   {regime}: skipped, only {len(users)} held-out listener "
                  f"meets the history threshold")
            continue

        cases = build_cases(regime)

        if not cases:
            print(f"\n   {regime}: no cases")
            continue
        vec_scores, niche_scores, base = [], {k: [] for k in forms}, []

        for _user, history, target, negs in cases:
            taste = emb[history].mean(0)
            taste /= np.linalg.norm(taste) + 1e-8
            rows_ = np.array([target] + negs)
            v = emb[rows_] @ taste
            u = rank[history].mean()
            s = rank[rows_]
            base.append(mrr(tie_rank(v)))
            vec_scores.append(v)
            for name, f in forms.items():
                niche_scores[name].append(f(u, s))

        # The mixing weight is tuned on one set of listeners and scored on
        # another. Cutting the case list at its midpoint could land inside a
        # listener's own block of five targets, so the weight was tuned on one
        # of their plays and judged on the next — which is not the independence
        # this section claims. Cases arrive grouped by listener, so cut on a
        # listener boundary instead.
        # The threshold has to come from the listeners actually in this case
        # list, not from every eligible one. cases is capped, so counting
        # `users` meant the cut never fired once the cap bit — leaving the
        # held-out slice empty and statistics.mean raising on it. One listener
        # cannot be split at all, so the regime is skipped.
        case_listeners = []
        for case_user, *_rest in cases:
            if case_user not in case_listeners:
                case_listeners.append(case_user)

        if len(case_listeners) < 2:
            print(f"\n   {regime}: skipped, {len(case_listeners)} listener in the cases")
            continue

        tune_on = set(case_listeners[:len(case_listeners) // 2])
        cut2 = next(i for i, (case_user, *_rest) in enumerate(cases)
                   if case_user not in tune_on)
        print(f"\n   negatives from the {regime} play distribution "
              f"({len(cases)} cases, {CANDIDATES} candidates)")
        print(f"   {'scorer':26}{'MRR':>8}{'weight':>9}")
        print("   " + "-" * 43)
        print(f"   {'chance':26}{statistics.mean(1 / np.arange(1, CANDIDATES + 2)):8.3f}")
        print(f"   {'vector alone':26}{statistics.mean(base):8.3f}")

        for name in forms:
            alone = [mrr(tie_rank(np.asarray(nn))) for nn in niche_scores[name]]
            print(f"   {'nicheness alone: ' + name:26}{statistics.mean(alone):8.3f}")

        for name in forms:
            best_w, best_v = 0.0, -1
            for w in (0.0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2):
                got = statistics.mean(
                    mrr(tie_rank(vec_scores[i] + w * niche_scores[name][i]))
                    for i in range(cut2))
                if got > best_v:
                    best_w, best_v = w, got
            held = statistics.mean(
                mrr(tie_rank(vec_scores[i] + best_w * niche_scores[name][i]))
                for i in range(cut2, len(cases)))
            held_base = statistics.mean(mrr(tie_rank(vec_scores[i])) for i in range(cut2, len(cases)))
            print(f"   {'vector + ' + name:26}{held:8.3f}{best_w:9.2f}"
                  f"   (vector alone on the same half {held_base:.3f})")


if __name__ == "__main__":
    main()
