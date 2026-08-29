"""
Does knowing which friends you are close to help?

The ranker treats every friend alike: MAX_SHARE_PER_FRIEND gives the same cap
to somebody you listen alongside every evening and somebody you added once. The
obvious fix is to weight friends by closeness — except the two fields that
would carry it, UserFriendship.stats.streak and .tasteMatchScore, are written
once at friendship creation as zero and never updated again. Nothing reads them
either. There is no stored closeness to weight by.

So this asks whether closeness can be *derived* from the plays themselves, and
whether the derived thing is worth anything:

  co-listening   how often, when you are listening, that friend is listening
                 too. Social proximity rather than taste overlap — two people
                 who are on at the same time in the evening, whatever they are
                 each playing.
  hour profile   cosine between your hour-of-day histograms. The same idea,
                 softened: not "at the same moment" but "the same sort of hours".

Taste similarity is deliberately not retried here. recsim2 measured it at 0.033
MRR against a chance band of 0.026 [0.015, 0.046] and it is what tasteMatchScore
was for.

Read the numbers against floor.py, not against each other.
"""
import math
from collections import defaultdict

import recsim2 as R
import recsim3 as R3
from recsim3 import walk, summarise


class SocialProfile(R.Profile):
    """A profile that also remembers when its plays happened."""

    def __init__(self):
        super().__init__()
        self.last = {}
        self.times = []
        self.hours = defaultdict(float)

    def add(self, row):
        super().add(row)
        at = row["timestamp"]
        self.last[row["item"]["track"]["id"]] = at
        self.times.append(at)
        # Local hour is not knowable from a bare epoch, and the group is small
        # enough that they are plausibly in one or two zones. UTC throughout,
        # so an offset shifts everybody equally and the cosine is unaffected.
        self.hours[int((at // 3600e3) % 24)] += 1.0


R3.Profile = SocialProfile

HALF_LIFE_H = 6
COPLAY_WINDOW_MS = 30 * 60e3


def _recency(friends, pool):
    """The shipped signal: how lately somebody played each candidate, decayed."""
    now = max((max(f.last.values()) for f in friends if f.last), default=0)
    out = defaultdict(float)
    for f in friends:
        for t, c in f.track.items():
            if t not in pool:
                continue
            age_h = (now - f.last.get(t, now)) / 3600e3
            out[t] += c * 0.5 ** (age_h / HALF_LIFE_H)
    return out


def coplay(me, friend, window=COPLAY_WINDOW_MS):
    """
    What fraction of the listener's plays had that friend listening nearby.

    Both play lists are already in time order, so this walks them together
    rather than comparing every pair — the naive form is 1,500 x 1,500 per
    query per friend, which is minutes of runtime for a number that can be had
    in one pass.
    """
    if not me.times or not friend.times:
        return 0.0

    hits, j = 0, 0
    for at in me.times:
        while j < len(friend.times) and friend.times[j] < at - window:
            j += 1
        # j is now the first play not before the window; a hit needs it inside
        if j < len(friend.times) and friend.times[j] <= at + window:
            hits += 1
    return hits / len(me.times)


def hour_cosine(me, friend):
    """Cosine between two hour-of-day histograms."""
    if not me.hours or not friend.hours:
        return 0.0

    dot = sum(v * friend.hours.get(h, 0.0) for h, v in me.hours.items())
    if not dot:
        return 0.0
    return dot / (math.sqrt(sum(v * v for v in me.hours.values()))
                  * math.sqrt(sum(v * v for v in friend.hours.values())))


def _scaled(values):
    """
    Closeness relative to the closest friend present, not on an absolute scale.

    A raw co-listening rate depends on how much everybody happened to listen in
    the window, so an absolute threshold would mean something different for
    every listener and every instant. Dividing by the largest asks the only
    question the ranker needs answered: who, of the people here, is nearest.
    """
    top = max(values, default=0.0)
    return [(v / top if top > 0 else 0.0) for v in values]


def weighted_recency(closeness, alpha):
    """Recency, with each friend's contribution scaled by how close they are."""
    def rec(me, friends, pool, rng, **kw):
        now = max((max(f.last.values()) for f in friends if f.last), default=0)
        weights = _scaled([closeness(me, f) for f in friends])
        out = defaultdict(float)
        for f, w in zip(friends, weights):
            scale = 1 + alpha * w
            for t, c in f.track.items():
                if t not in pool:
                    continue
                age_h = (now - f.last.get(t, now)) / 3600e3
                out[t] += c * 0.5 ** (age_h / HALF_LIFE_H) * scale
        return out
    return rec


def rec_recent(me, friends, pool, rng, **kw):
    return _recency(friends, pool)


def rec_closeness_only(closeness):
    """Closeness with no recency at all, to see whether it carries anything."""
    def rec(me, friends, pool, rng, **kw):
        weights = _scaled([closeness(me, f) for f in friends])
        out = defaultdict(float)
        for f, w in zip(friends, weights):
            for t, c in f.track.items():
                if t in pool:
                    out[t] += c * w
        return out
    return rec


RECS = {
    'random': R.rec_random,
    'recent': rec_recent,
    'coplay-only': rec_closeness_only(coplay),
    'hours-only': rec_closeness_only(hour_cosine),
    'recent*coplay-1': weighted_recency(coplay, 1.0),
    'recent*coplay-3': weighted_recency(coplay, 3.0),
    'recent*hours-1': weighted_recency(hour_cosine, 1.0),
    'recent*hours-3': weighted_recency(hour_cosine, 3.0),
}


if __name__ == '__main__':
    qs = walk(RECS)
    summarise(qs, RECS, label="ALL novel plays")
    summarise([q for q in qs if q['known_artist']], RECS,
              label="DEEPENING — new track, artist already played")
    summarise([q for q in qs if not q['known_artist']], RECS,
              label="DISCOVERY — artist never played before")
