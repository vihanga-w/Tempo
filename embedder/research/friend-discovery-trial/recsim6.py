"""
The same walk again, over the pool a friend recommender ought to have.

Candidates here are not the tracks friends played but the catalogues of the
artists they played — 435 artists, 11,281 tracks off Deezer. Ground truth is
matched by ISRC, so a track counts as found whichever service it came from.
"""
import json, random, statistics
from collections import defaultdict
import recsim2 as R
from recsim3 import bootstrap

SCRATCH = "."
DEEZER = json.load(open(f"{SCRATCH}/group-deezer.json"))          # spotify id -> deezer track
CATALOGUE = json.load(open(f"{SCRATCH}/artist-catalogues.json"))   # deezer artist id -> [track]

# spotify artist id -> deezer artist id, learned from the tracks we resolved
SP_TO_DZ = {}
for tid, d in DEEZER.items():
    if not d:
        continue
    aid = (d.get("artist") or {}).get("id")
    if not aid:
        continue
    for sp in R.ART.get(tid, []):
        SP_TO_DZ.setdefault(sp, str(aid))

# what each artist's catalogue offers, and how well known each track is
# the artist-top endpoint carries no ISRC, so tracks are matched on Deezer's
# own track id — which the ISRC resolution above already gives us for
# everything anyone in the group has played
POOL_OF = {}
RANK = {}
for aid, tracks in CATALOGUE.items():
    ids = []
    for t in tracks:
        key = f"dz{t['id']}"
        ids.append(key)
        RANK[key] = t.get("rank") or 0
    POOL_OF[str(aid)] = ids

DZ_OF_SPOTIFY = {tid: f"dz{d['id']}" for tid, d in DEEZER.items() if d}

HALF_LIFE_H = 6


def walk(rankers, warmup=15, seed=7):
    rng = random.Random(seed)
    queries = []

    for uid, hist in R.HIST.items():
        others = sorted(((r["timestamp"], u, r) for u, v in R.HIST.items() if u != uid for r in v),
                        key=lambda x: x[0])
        me = R.Profile()
        friends = defaultdict(R.Profile)
        friend_artist_seen = {}     # deezer artist -> last time a friend played them
        friend_artist_weight = defaultdict(float)
        cursor = 0

        for row in hist:
            now = row["timestamp"]
            while cursor < len(others) and others[cursor][0] < now:
                _, u, r = others[cursor]
                friends[u].add(r)
                tid = r["item"]["track"]["id"]
                c = R.confidence(r["item"])
                for sp in R.ART.get(tid, []):
                    dz = SP_TO_DZ.get(sp)
                    if dz:
                        friend_artist_seen[dz] = max(friend_artist_seen.get(dz, 0), r["timestamp"])
                        friend_artist_weight[dz] += c
                cursor += 1

            tid = row["item"]["track"]["id"]
            target = DZ_OF_SPOTIFY.get(tid)

            if tid not in me.track and len(me.track) >= warmup and target:
                pool = {}
                for dz in friend_artist_seen:
                    for key in POOL_OF.get(dz, []):
                        pool[key] = dz
                # anything the listener has already played is not a recommendation
                for played in me.track:
                    pool.pop(DZ_OF_SPOTIFY.get(played, ""), None)

                known_artist = any(a in me.artist for a in R.ART.get(tid, []))
                q = {'user': R.NAME[uid], 'known_artist': known_artist,
                     'reachable': target in pool, 'pool': len(pool), 'ranks': {}}

                if q['reachable']:
                    for label, fn in rankers.items():
                        order = fn(pool, friend_artist_seen, friend_artist_weight, me, now, rng)
                        q['ranks'][label] = order.index(target) + 1 if target in order else len(pool)
                queries.append(q)

            me.add(row)
    return queries


def order_by(score, pool):
    return [k for k, _ in sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))]


def rank_random(pool, seen, weight, me, now, rng):
    # hashed rather than drawn, so the floor does not move with call order
    import hashlib
    return order_by({k: int(hashlib.blake2b(k.encode(), digest_size=8).hexdigest(), 16)
                     for k in pool}, pool)


def rank_artist_recency(pool, seen, weight, me, now, rng):
    score = {}
    for k, dz in pool.items():
        age_h = (now - seen[dz]) / 3600e3
        score[k] = 0.5 ** (age_h / HALF_LIFE_H)
    return order_by(score, pool)


def rank_popularity(pool, seen, weight, me, now, rng):
    return order_by({k: RANK.get(k, 0) for k in pool}, pool)


def rank_recency_x_popularity(pool, seen, weight, me, now, rng):
    score = {}
    for k, dz in pool.items():
        age_h = (now - seen[dz]) / 3600e3
        score[k] = (0.5 ** (age_h / HALF_LIFE_H)) * (RANK.get(k, 0) ** 0.5)
    return order_by(score, pool)


def rank_weight_x_popularity(pool, seen, weight, me, now, rng):
    score = {}
    for k, dz in pool.items():
        score[k] = weight[dz] * (RANK.get(k, 0) ** 0.5)
    return order_by(score, pool)


RANKERS = {
    'random': rank_random,
    'artist-recency': rank_artist_recency,
    'deezer-rank': rank_popularity,
    'recency x rank': rank_recency_x_popularity,
    'plays x rank': rank_weight_x_popularity,
}


def summarise(qs, label, ks=(10, 25, 50, 100)):
    usable = [q for q in qs if q['reachable']]
    if not usable:
        print(f"\n{label}: nothing reachable")
        return
    print(f"\n{label}  ({len(usable)} scorable of {len(qs)} novel plays, "
          f"{len(usable)/len(qs)*100:.1f}% reachable, median pool {int(statistics.median(q['pool'] for q in usable))})")
    header = f"  {'ranker':16}" + "".join(f"{'HR@'+str(k):>9}" for k in ks) + f"{'MRR':>10}{'  95% CI':>20}"
    print(header); print('  ' + '-' * (len(header) - 2))
    for name in RANKERS:
        rr = [1 / q['ranks'][name] for q in usable]
        cells = "".join(f"{sum(1 for q in usable if q['ranks'][name] <= k)/len(usable)*100:8.1f}%" for k in ks)
        lo, hi = bootstrap(rr)
        print(f"  {name:16}{cells}{statistics.mean(rr):10.4f}   [{lo:.4f}, {hi:.4f}]")


if __name__ == '__main__':
    qs = walk(RANKERS)
    summarise(qs, "ALL novel plays — expanded pool (friends' artists' catalogues)")
    summarise([q for q in qs if q['known_artist']], "DEEPENING")
    summarise([q for q in qs if not q['known_artist']], "DISCOVERY — artist never played before")
