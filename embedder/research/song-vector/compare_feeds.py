"""Two listeners, the same model, side by side."""
import json, random
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings
from affinity import artist_album_of, SHRINK
from vonga_feed import names

VECTOR_WEIGHT = 0.05
USERS = {"Vonga": "yh1q376ly901c0qk03n9kaphh", "Sorcha": "dcfc1wdwx310qgps19sm60xvn"}


def profile(uid, index, meta, emb, hist_all):
    hist = sorted(hist_all[uid], key=lambda r: r["timestamp"])
    rows, artist_plays, album_plays = [], {}, {}
    for r in hist:
        row = index.get(("spotify", r["item"]["track"]["id"]))
        if row is None:
            continue
        rows.append(row)
        art, alb = meta.get(row, (None, None))
        if art:
            artist_plays[art] = artist_plays.get(art, 0) + 1
        if alb:
            album_plays[alb] = album_plays.get(alb, 0) + 1
    played = set(rows)
    taste = emb[list(played)].mean(0)
    taste /= np.linalg.norm(taste) + 1e-8
    return {"played": played, "artist": artist_plays, "album": album_plays,
            "taste": taste, "n": len(rows), "plays": len(hist)}


def feed(p, emb, meta, matrix, per_artist=2):
    familiar, fresh = [], []
    for row in range(matrix.shape[0]):
        if row in p["played"]:
            continue
        art, alb = meta.get(row, (None, None))
        aff = (p["artist"].get(art, 0) + p["album"].get(alb, 0)) / (p["n"] + SHRINK)
        cos = float(p["taste"] @ emb[row])
        (familiar if art in p["artist"] else fresh).append((aff + VECTOR_WEIGHT * cos, cos, row))
    familiar.sort(reverse=True)
    fresh.sort(key=lambda x: -x[1])

    def cap(items):
        seen, out = {}, []
        for it in items:
            a = meta.get(it[2], (None, None))[0]
            if seen.get(a, 0) >= per_artist:
                continue
            seen[a] = seen.get(a, 0) + 1
            out.append(it)
        return out
    return cap(familiar), cap(fresh)


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    label = names(index)
    # A feed to look at, not a measurement, so the all-sittings embedding is
    # the right one here.
    emb = np.load("emb-all.npy")
    hist_all = json.load(open("friends-history.json"))

    profiles = {n: profile(u, index, meta, emb, hist_all) for n, u in USERS.items()}
    feeds = {n: feed(p, emb, meta, matrix) for n, p in profiles.items()}

    for n, p in profiles.items():
        top = sorted(p["artist"].items(), key=lambda kv: -kv[1])[:6]
        arts = ", ".join(label.get(next(r for r in p["played"]
                        if meta.get(r, (None,))[0] == a), ("", "?"))[1] for a, _ in top)
        print(f"{n:8} {p['plays']:4} plays, {len(p['artist']):3} artists   most played: {arts}")

    cos = float(profiles["Vonga"]["taste"] @ profiles["Sorcha"]["taste"])
    print(f"\ntaste vectors, cosine between them: {cos:+.3f}")

    print(f"\n{'':3}{'VONGA — discovery lane':40}{'SORCHA — discovery lane':40}")
    print('-' * 83)
    for i in range(12):
        a = feeds["Vonga"][1][i]; b = feeds["Sorcha"][1][i]
        ta = f"{label[a[2]][0][:20]} — {label[a[2]][1][:16]}"
        tb = f"{label[b[2]][0][:20]} — {label[b[2]][1][:16]}"
        print(f"{i+1:3}{ta:40}{tb:40}")

    print(f"\n{'':3}{'VONGA — deepening lane':40}{'SORCHA — deepening lane':40}")
    print('-' * 83)
    for i in range(10):
        a = feeds["Vonga"][0][i]; b = feeds["Sorcha"][0][i]
        ta = f"{label[a[2]][0][:20]} — {label[a[2]][1][:16]}"
        tb = f"{label[b[2]][0][:20]} — {label[b[2]][1][:16]}"
        print(f"{i+1:3}{ta:40}{tb:40}")

    for lane, idx in [("discovery", 1), ("deepening", 0)]:
        for k in (12, 50, 200):
            va = {r for _, _, r in feeds["Vonga"][idx][:k]}
            sa = {r for _, _, r in feeds["Sorcha"][idx][:k]}
            aa = {meta.get(r, (None,))[0] for r in va}
            ab = {meta.get(r, (None,))[0] for r in sa}
            print(f"{lane:10} top {k:3}: {len(va&sa):3} tracks shared, {len(aa&ab):3} artists shared")
