"""
The same comparison, split by whether the listener already knows the artist.

Ties are ranked at the middle of the tied block, not at the top of it. Counting
only candidates that score strictly higher hands a scorer rank one every time it
answers zero for everything — which is exactly what a play counter does on an
artist nobody has played, so the bug flattered precisely the case it was there
to test. It read 0.338 on new artists where the true answer is chance.

A counter of past plays wins the pooled task easily, but most of what it wins is
not discovery: people play albums, so the next track in a sitting is usually the
same record they were already on. Where the artist is new, every counter scores
zero by construction and cannot rank anything — that is the half of the feed the
vector exists for, and the half it has to be judged on.

The combination weight is fitted rather than picked, since a weight chosen by
hand drags a strong signal towards a weak one and loses to either alone.
"""
import json, math, random, statistics
import numpy as np

import pairmodel as P
from bigtrain import corpus, sittings
from affinity import artist_album_of, affinity_maps, SHRINK, CANDIDATES


def cases_for(groups, meta, rng, limit=4000):
    by_user = {}
    for user, ids in groups:
        by_user.setdefault(user, []).append(ids)
    pool = [row for _, ids in groups for row in ids]

    out = []
    for user, sits in by_user.items():
        if len(sits) < 3:
            continue
        history = [row for s in sits[:-1] for row in s]
        if len(history) < 10:
            continue
        known_artists = {meta.get(r, (None, None))[0] for r in history}
        for target in sits[-1]:
            out.append({
                'history': history,
                'target': target,
                'negatives': [rng.choice(pool) for _ in range(CANDIDATES)],
                'known_artist': meta.get(target, (None, None))[0] in known_artists,
            })
            if len(out) >= limit:
                return out
    return out


def score_all(case, emb, meta):
    art, alb = affinity_maps(case['history'], meta)
    n = len(case['history'])
    taste = emb[case['history']].mean(0)
    taste /= np.linalg.norm(taste) + 1e-8
    rows = [case['target']] + case['negatives']
    return {
        'artist': np.array([art.get(meta.get(r, (None, None))[0], 0) for r in rows]) / (n + SHRINK),
        'album':  np.array([alb.get(meta.get(r, (None, None))[1], 0) for r in rows]) / (n + SHRINK),
        'vector': np.array([float(taste @ emb[r]) for r in rows]),
    }


def rank_of(values):
    """Where the target sits, with a tied block counted from its middle."""
    target, rest = values[0], values[1:]
    return 1 + int((rest > target).sum()) + int((rest == target).sum()) / 2


def report(label, scored, weights):
    if not scored:
        print(f"\n{label}: nothing to score")
        return
    print(f"\n{label}  ({len(scored)} cases, {CANDIDATES} candidates each)")
    print(f"  {'scorer':26}{'MRR':>8}{'top 1':>8}{'top 5':>8}{'top 10':>8}")
    print('  ' + '-' * 56)
    print(f"  {'chance':26}{statistics.mean(1/r for r in range(1, CANDIDATES+2)):8.3f}"
          f"{1/(CANDIDATES+1)*100:7.1f}%{5/(CANDIDATES+1)*100:7.1f}%{10/(CANDIDATES+1)*100:7.1f}%")
    for name, combine in weights.items():
        ranks = [rank_of(combine(s)) for s in scored]
        print(f"  {name:26}{statistics.mean(1/r for r in ranks):8.3f}"
              f"{sum(1 for r in ranks if r <= 1)/len(ranks)*100:7.1f}%"
              f"{sum(1 for r in ranks if r <= 5)/len(ranks)*100:7.1f}%"
              f"{sum(1 for r in ranks if r <= 10)/len(ranks)*100:7.1f}%")


def fit_weight(scored):
    """One scalar: how much a unit of vector cosine is worth in affinity units."""
    best, best_mrr = 0.0, -1
    for w in [0, .002, .005, .01, .02, .05, .1, .2, .5, 1, 2, 5]:
        mrr = statistics.mean(1 / rank_of(s['artist'] + s['album'] + w * s['vector'])
                              for s in scored)
        if mrr > best_mrr:
            best, best_mrr = w, mrr
    return best, best_mrr


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    groups = sittings(json.load(open("lb-listens.json")), index)
    rng = random.Random(5)
    rng.shuffle(groups)
    cut = int(len(groups) * 0.8)

    plays = [row for _, ids in groups[:cut] for row in ids]
    from bigablate import pairs
    a, b, y = pairs(groups[:cut], random.Random(3), matrix.shape[0], plays, True)
    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a, b, y, epochs=10, batch=1024)
    emb, _ = tower.forward(matrix)

    cases = cases_for(groups[cut:], meta, rng)
    scored = []
    for c in cases:
        s = score_all(c, emb, meta)
        s['known_artist'] = c['known_artist']
        scored.append(s)

    known = [s for s in scored if s['known_artist']]
    fresh = [s for s in scored if not s['known_artist']]
    print(f"{len(scored)} cases: {len(known)} by an artist already played "
          f"({len(known)/len(scored)*100:.0f}%), {len(fresh)} by a new artist")

    w, _ = fit_weight([s for s in scored])
    print(f"fitted weight on vector cosine: {w}")

    weights = {
        'artist affinity':  lambda s: s['artist'],
        'album affinity':   lambda s: s['album'],
        'vector cosine':    lambda s: s['vector'],
        'affinity + vector': lambda s: s['artist'] + s['album'] + w * s['vector'],
    }
    report("ALL cases", scored, weights)
    report("DEEPENING — artist already played", known, weights)
    report("DISCOVERY — artist never played", fresh, weights)
