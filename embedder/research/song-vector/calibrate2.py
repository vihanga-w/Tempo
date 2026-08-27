"""
The number was never wrong. The reference point was missing.

Centring makes a cosine of zero mean "unrelated", which reads better — and costs
about a tenth of the ranking quality, because the component it removes is
typicality, and typicality genuinely predicts what people play. So the geometry
stays as it is and the *reading* is calibrated instead: a similarity is reported
against the distribution of similarities between real listeners, where it can be
said whether 0.43 is close or distant. It turns out to be distant.

The distribution comes from ListenBrainz users, which is the only place enough
real listeners exist to have one.
"""
import json, random, statistics
import numpy as np

from bigtrain import corpus, sittings
from calibrate import user_taste

MIN_PLAYS = 25


if __name__ == "__main__":
    matrix, index = corpus()
    emb = np.load("emb.npy")
    emb = emb / (np.linalg.norm(emb, axis=1, keepdims=True) + 1e-8)

    listens = json.load(open("lb-listens.json"))
    tastes = {}
    for user, plays in listens.items():
        rows = [index.get((kind, ident)) for _, kind, ident in plays]
        rows = [r for r in rows if r is not None]
        if len(rows) >= MIN_PLAYS:
            tastes[user] = user_taste(rows, emb)
    print(f"{len(tastes)} listeners with {MIN_PLAYS}+ describable plays")

    rng = random.Random(4)
    users = list(tastes)
    pairs = [(rng.choice(users), rng.choice(users)) for _ in range(40000)]
    sims = np.array([float(tastes[a] @ tastes[b]) for a, b in pairs if a != b])
    sims.sort()
    print(f"similarity between two random listeners:")
    for q in (1, 5, 25, 50, 75, 95, 99):
        print(f"  {q:3}th percentile  {sims[int(len(sims)*q/100)]:+.3f}")

    def percentile(v):
        return float(np.searchsorted(sims, v) / len(sims) * 100)

    hist = json.load(open("friends-history.json"))
    who = {"Vonga": "yh1q376ly901c0qk03n9kaphh", "Sorcha": "dcfc1wdwx310qgps19sm60xvn",
           "dylan": "nfsind1dp1j2x5ak8a820e6pt", "Ricky2009": "31s4ae2k5xzbjbdja5zqcy4qpkrm",
           "Vidhu": "1hquqogesshkoy2qi2t7z6qbh"}
    mine = {}
    for n, u in who.items():
        rows = [index.get(("spotify", r["item"]["track"]["id"])) for r in hist[u]]
        rows = [r for r in rows if r is not None]
        mine[n] = user_taste(rows, emb)

    print(f"\n{'pair':22}{'cosine':>9}{'percentile':>13}   reading")
    for a in who:
        for b in who:
            if a >= b:
                continue
            v = float(mine[a] @ mine[b])
            p = percentile(v)
            word = ("further apart than almost anyone" if p < 5 else
                    "unusually distant" if p < 25 else
                    "about average" if p < 75 else
                    "close" if p < 95 else "unusually close")
            print(f"{a + ' / ' + b:22}{v:+9.3f}{p:12.0f}%   {word}")
