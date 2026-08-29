"""
Scoring friend-taste discovery, one query per discovery.

The forward-split protocol gives a single query per user, and with a friend
group this size the answer to it is a handful of tracks — too few to tell two
recommenders apart. This walks the timeline instead: every time somebody plays
a track they have never played before, that is one query, asked of the state of
the world at that instant. Same rule about the future, many more questions.

Ranking is scored only over queries whose answer is somewhere in the friend
group's catalogue at the time. Whether it is there at all is the separate
number, and the more important one.
"""
import json, math, random
from collections import defaultdict

SCRATCH = "."
HIST = json.load(open("friends-history.json"))
HIST = {k: sorted(v, key=lambda r: r["timestamp"]) for k, v in HIST.items() if v}
NAME = {k: v[0]["username"] for k, v in HIST.items()}

ART, TITLE, ALBUM = {}, {}, {}
for rows in HIST.values():
    for r in rows:
        t = r["item"]["track"]
        ART[t["id"]] = [a["id"] for a in t.get("artists", [])]
        ALBUM[t["id"]] = t.get("album", {}).get("id")
        TITLE[t["id"]] = (t["name"], ", ".join(a["name"] for a in t.get("artists", [])))


def confidence(item):
    c = max(0.0, min(1.0, item.get("sessionDuration", 0)))
    if item.get("replayed"):
        c += 1.0
    if item.get("skipped"):
        c *= 0.25
    return c


class Profile:
    """One listener's plays so far, kept up to date as the clock moves."""

    def __init__(self):
        self.track = defaultdict(float)
        self.artist = defaultdict(float)
        self.album = defaultdict(float)
        self._norm_artist = None

    def add(self, row):
        tid = row["item"]["track"]["id"]
        c = confidence(row["item"])
        self.track[tid] += c
        for a in ART.get(tid, []):
            self.artist[a] += c
        if ALBUM.get(tid):
            self.album[ALBUM[tid]] += c
        self._norm_artist = None

    @property
    def artist_norm(self):
        if self._norm_artist is None:
            self._norm_artist = math.sqrt(sum(v * v for v in self.artist.values())) or 1.0
        return self._norm_artist


def artist_cosine(a: Profile, b: Profile):
    small, large = (a.artist, b.artist) if len(a.artist) < len(b.artist) else (b.artist, a.artist)
    dot = sum(v * large[k] for k, v in small.items() if k in large)
    return dot / (a.artist_norm * b.artist_norm)


# --- recommenders ------------------------------------------------------------

def rec_random(me, friends, pool, rng, **kw):
    """A floor that does not move when the recommenders around it change.

    Drawing from the shared rng made this depend on how many other rankers ran
    first, so the same baseline reported anywhere from 2.5% to 8.8% at rank 10
    across runs. Hashing the id fixes it to the pool.
    """
    import hashlib
    return {t: int(hashlib.blake2b(t.encode(), digest_size=8).hexdigest(), 16) for t in pool}


def rec_popularity(me, friends, pool, rng, **kw):
    score = defaultdict(float)
    for f in friends:
        for t, c in f.track.items():
            if t in pool:
                score[t] += c
    return score


def rec_friend_taste(me, friends, pool, rng, power=1.0, **kw):
    score = defaultdict(float)
    for f in friends:
        w = artist_cosine(me, f)
        if w <= 0:
            continue
        w **= power
        for t, c in f.track.items():
            if t in pool:
                score[t] += w * c
    return score


def rec_my_artists(me, friends, pool, rng, **kw):
    score = {}
    for t in pool:
        s = sum(me.artist.get(a, 0.0) for a in ART.get(t, []))
        if s:
            score[t] = s
    return score


def rec_item_cf(me, friends, pool, rng, **kw):
    score = defaultdict(float)
    for f in friends:
        shared = sum(c for t, c in f.track.items() if t in me.track)
        if shared <= 0:
            continue
        for t, c in f.track.items():
            if t in pool:
                score[t] += shared * c
    return score


def rec_friend_artist(me, friends, pool, rng, **kw):
    """Friend evidence, but carried at the artist level rather than the track."""
    weight = defaultdict(float)
    for f in friends:
        w = artist_cosine(me, f)
        if w <= 0:
            continue
        for a, c in f.artist.items():
            weight[a] += w * c
    score = {}
    for t in pool:
        s = sum(weight.get(a, 0.0) for a in ART.get(t, []))
        if s:
            score[t] = s
    return score


def rrf(*ranked_lists, k=60, weights=None):
    weights = weights or [1.0] * len(ranked_lists)
    out = defaultdict(float)
    for w, order in zip(weights, ranked_lists):
        for i, t in enumerate(order):
            out[t] += w / (k + i + 1)
    return out


def order_of(score):
    return [t for t, _ in sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))]


def rec_hybrid(me, friends, pool, rng, **kw):
    return rrf(order_of(rec_friend_taste(me, friends, pool, rng)),
               order_of(rec_my_artists(me, friends, pool, rng)))


def rec_hybrid3(me, friends, pool, rng, **kw):
    return rrf(order_of(rec_friend_taste(me, friends, pool, rng)),
               order_of(rec_my_artists(me, friends, pool, rng)),
               order_of(rec_friend_artist(me, friends, pool, rng)))


# --- evaluation --------------------------------------------------------------

def run(recs, ks=(10, 25, 50), warmup=15, seed=7, verbose=True):
    rng = random.Random(seed)
    stats = {label: {'hits': {k: 0 for k in ks}, 'rr': 0.0} for label in recs}
    queries = 0
    unreachable = 0
    per_user = defaultdict(lambda: [0, 0])

    for uid, hist in HIST.items():
        # everyone's plays merged in time order, so friends only ever contribute
        # what had already happened
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
            novel = tid not in me.track

            if novel and len(me.track) >= warmup:
                active = [f for f in friends.values() if f.track]
                pool = set()
                for f in active:
                    pool |= set(f.track)
                pool -= set(me.track)

                per_user[NAME[uid]][1] += 1
                if tid not in pool:
                    unreachable += 1
                else:
                    queries += 1
                    per_user[NAME[uid]][0] += 1
                    for label, fn in recs.items():
                        order = order_of(fn(me, active, pool, rng))
                        try:
                            rank = order.index(tid) + 1
                        except ValueError:
                            rank = len(order) + 1
                        stats[label]['rr'] += 1 / rank
                        for k in ks:
                            if rank <= k:
                                stats[label]['hits'][k] += 1
            me.add(row)

    if verbose:
        print(f"{'user':10} {'reachable':>10} {'novel plays':>12} {'reach rate':>11}")
        for name, (r, n) in sorted(per_user.items(), key=lambda kv: -kv[1][1]):
            print(f"{name:10} {r:10} {n:12} {r/n*100 if n else 0:10.1f}%")
        print(f"\n{queries} scorable queries, {unreachable} not in the friend catalogue at the time "
              f"({queries/(queries+unreachable)*100:.1f}% reachable)\n")

        header = f"{'recommender':14}" + "".join(f"{'HR@'+str(k):>9}" for k in ks) + f"{'MRR':>9}"
        print(header)
        print('-' * len(header))
        for label in recs:
            cells = "".join(f"{stats[label]['hits'][k]/queries*100:8.1f}%" for k in ks)
            print(f"{label:14}{cells}{stats[label]['rr']/queries:9.4f}")
    return stats, queries


RECS = {
    'random': rec_random,
    'popular': rec_popularity,
    'item-cf': rec_item_cf,
    'my-artists': rec_my_artists,
    'friend-taste': rec_friend_taste,
    'friend-artist': rec_friend_artist,
    'hybrid': rec_hybrid,
    'hybrid3': rec_hybrid3,
}

if __name__ == '__main__':
    run(RECS)
