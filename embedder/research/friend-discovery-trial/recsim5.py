"""
The candidate rankers, scored side by side on the same queries.

What came out of the earlier passes: taste-similarity weighting between friends
is worth nothing measurable, the listener's own artist history is the best
thing going for a new track by a familiar artist and actively harmful for a new
artist, and how recently a friend played something beats both.
"""
import math, random, statistics
from collections import defaultdict
import recsim2 as R, recsim3 as R3
from recsim3 import walk, summarise


class TimedProfile(R.Profile):
    """A profile that also remembers when each track was last played."""

    def __init__(self):
        super().__init__()
        self.last = {}

    def add(self, row):
        super().add(row)
        self.last[row["item"]["track"]["id"]] = row["timestamp"]


R3.Profile = TimedProfile

HALF_LIFE_H = 6


def recency_weight(friends, pool):
    """How lately somebody played each candidate, decayed."""
    now = max((max(f.last.values()) for f in friends if f.last), default=0)
    out = defaultdict(float)
    for f in friends:
        for t, c in f.track.items():
            if t not in pool:
                continue
            age_h = (now - f.last.get(t, now)) / 3600e3
            out[t] += c * 0.5 ** (age_h / HALF_LIFE_H)
    return out


def rec_recent(me, friends, pool, rng, **kw):
    return recency_weight(friends, pool)


def rec_recent_x_artists(me, friends, pool, rng, **kw):
    """Lately played by a friend, and by somebody you already listen to."""
    recent = recency_weight(friends, pool)
    out = {}
    for t, w in recent.items():
        affinity = sum(me.artist.get(a, 0.0) for a in R.ART.get(t, []))
        out[t] = w * (1 + affinity)
    return out


def split_pool(me, pool):
    known, fresh = [], []
    for t in pool:
        (known if any(a in me.artist for a in R.ART.get(t, [])) else fresh).append(t)
    return known, fresh


def interleave(a, b, share=0.65):
    out, i, j, owed = [], 0, 0, 0.0
    while i < len(a) or j < len(b):
        owed += share
        if owed >= 1 and i < len(a):
            out.append(a[i]); i += 1; owed -= 1
        elif j < len(b):
            out.append(b[j]); j += 1
        elif i < len(a):
            out.append(a[i]); i += 1
    return {t: -i for i, t in enumerate(out)}


def two_lane(known_rec, fresh_rec):
    def rec(me, friends, pool, rng, **kw):
        known, fresh = split_pool(me, pool)
        a = R.order_of(known_rec(me, friends, set(known), rng))
        a += [t for t in known if t not in set(a)]
        b = R.order_of(fresh_rec(me, friends, set(fresh), rng))
        b += [t for t in fresh if t not in set(b)]
        return interleave(a, b)
    return rec


RECS = {
    'random': R.rec_random,
    'popular': R.rec_popularity,
    'my-artists': R.rec_my_artists,
    'friend-taste': R.rec_friend_taste,
    'rrf-hybrid': lambda me, f, p, r, **k: R.rrf(R.order_of(R.rec_friend_taste(me, f, p, r)),
                                                 R.order_of(R.rec_my_artists(me, f, p, r))),
    'recent': rec_recent,
    'recent*artists': rec_recent_x_artists,
    'two-lane': two_lane(R.rec_my_artists, R.rec_friend_taste),
    'two-lane-recent': two_lane(rec_recent_x_artists, rec_recent),
}

if __name__ == '__main__':
    qs = walk(RECS)
    summarise(qs, RECS, label="ALL novel plays")
    summarise([q for q in qs if q['known_artist']], RECS, label="DEEPENING — new track, artist already played")
    summarise([q for q in qs if not q['known_artist']], RECS, label="DISCOVERY — artist never played before")
