"""
The same walk as recsim2, but keeping every query's result so the answers can
be cut two ways.

The cut that matters: a novel track by an artist the listener already plays is
a different job from a novel track by an artist they have never heard. The
first is deepening a taste, the second is the thing "discover" is named after,
and a recommender can be good at one and useless at the other.
"""
import json, math, random, statistics
from collections import defaultdict
from recsim2 import (HIST, NAME, ART, TITLE, Profile, artist_cosine, order_of, rrf,
                     rec_random, rec_popularity, rec_item_cf, rec_my_artists,
                     rec_friend_taste, rec_friend_artist)


MISS_RANK = 10 ** 9      # past every cutoff, so 1/rank is ~0 and no HR counts it


def rec_hybrid(me, friends, pool, rng, **kw):
    return rrf(order_of(rec_friend_taste(me, friends, pool, rng)),
               order_of(rec_my_artists(me, friends, pool, rng)))


def walk(recs, warmup=15, seed=7):
    """Every novel play, in order, against the world as it stood."""
    rng = random.Random(seed)
    queries = []

    for uid, hist in HIST.items():
        others = sorted(((r["timestamp"], u, r) for u, v in HIST.items() if u != uid for r in v),
                        key=lambda x: x[0])
        me = Profile()
        friends = defaultdict(Profile)
        cursor = 0

        for row in hist:
            now = row["timestamp"]
            while cursor < len(others) and others[cursor][0] < now:
                _, u, r = others[cursor]
                friends[u].add(r)
                cursor += 1

            tid = row["item"]["track"]["id"]

            if tid not in me.track and len(me.track) >= warmup:
                active = [f for f in friends.values() if f.track]
                pool = set()
                for f in active:
                    pool |= set(f.track)
                pool -= set(me.track)

                known_artist = any(a in me.artist for a in ART.get(tid, []))
                q = {'user': NAME[uid], 'track': tid, 'known_artist': known_artist,
                     'reachable': tid in pool, 'pool': len(pool), 'ranks': {}}

                if q['reachable']:
                    for label, fn in recs.items():
                        order = order_of(fn(me, active, pool, rng))
                        # Several rankers omit zero-score tracks entirely.
                        # len(pool) as the fallback made an omitted track score
                        # inside HR@10 whenever the pool was small, and add
                        # 1/len(pool) to MRR. A miss has to sit past every cutoff.
                        q['ranks'][label] = (order.index(tid) + 1 if tid in order
                                             else MISS_RANK)
                queries.append(q)
            me.add(row)
    return queries


def summarise(queries, recs, ks=(10, 25, 50), label=""):
    usable = [q for q in queries if q['reachable']]
    if not usable:
        print(f"  {label}: nothing reachable")
        return
    print(f"\n{label}  ({len(usable)} scorable of {len(queries)} novel plays, "
          f"{len(usable)/len(queries)*100:.1f}% reachable, median pool {int(statistics.median(q['pool'] for q in usable))})")
    header = f"  {'recommender':14}" + "".join(f"{'HR@'+str(k):>9}" for k in ks) + f"{'MRR':>10}{'  95% CI on MRR':>18}"
    print(header)
    print('  ' + '-' * (len(header) - 2))
    for name in recs:
        rr = [1 / q['ranks'][name] for q in usable]
        cells = "".join(f"{sum(1 for q in usable if q['ranks'][name] <= k)/len(usable)*100:8.1f}%" for k in ks)
        lo, hi = bootstrap(rr)
        print(f"  {name:14}{cells}{statistics.mean(rr):10.4f}   [{lo:.4f}, {hi:.4f}]")


def bootstrap(values, rounds=4000, seed=11):
    rng = random.Random(seed)
    n = len(values)
    means = sorted(statistics.mean(rng.choices(values, k=n)) for _ in range(rounds))
    return means[int(rounds * 0.025)], means[int(rounds * 0.975)]


RECS = {
    'random': rec_random,
    'popular': rec_popularity,
    'item-cf': rec_item_cf,
    'my-artists': rec_my_artists,
    'friend-taste': rec_friend_taste,
    'friend-artist': rec_friend_artist,
    'hybrid': rec_hybrid,
}

if __name__ == '__main__':
    qs = walk(RECS)
    json.dump(qs, open("./queries.json", "w"))

    known = [q for q in qs if q['known_artist']]
    fresh = [q for q in qs if not q['known_artist']]

    def pct(part, whole):
        """n/a rather than ZeroDivisionError when a group came out empty."""
        return f"{part / len(whole) * 100:.1f}%" if whole else "n/a"

    print(f"novel plays: {len(qs)}   by an artist already played: {len(known)} "
          f"({pct(len(known), qs)})   by a new artist: {len(fresh)} ({pct(len(fresh), qs)})")
    print(f"reachable in the friend catalogue: "
          f"known-artist {pct(sum(q['reachable'] for q in known), known)}   "
          f"new-artist {pct(sum(q['reachable'] for q in fresh), fresh)}")

    summarise(qs, RECS, label="ALL novel plays")
    summarise(known, RECS, label="DEEPENING — new track, artist already played")
    summarise(fresh, RECS, label="DISCOVERY — artist never played before")
