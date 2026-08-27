"""What the trained system would put in front of one real listener."""
import json, random
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings
from bigablate import pairs
from affinity import artist_album_of, SHRINK

USER = "yh1q376ly901c0qk03n9kaphh"
VECTOR_WEIGHT = 0.05          # fitted in affinity2.py


def names(index):
    """row -> (title, artist), whichever catalogue described it."""
    out = {}
    deezer = {k: v for k, v in json.load(open("group-deezer.json")).items() if v}
    for sid, t in deezer.items():
        r = index.get(("spotify", sid))
        if r is not None:
            out[r] = (t.get("title", ""), (t.get("artist") or {}).get("name", ""))
    for tracks in json.load(open("artist-catalogues.json")).values():
        for t in tracks:
            r = index.get(("deezer", str(t["id"])))
            if r is not None and r not in out:
                out[r] = (t.get("title", ""), (t.get("artist") or {}).get("name", ""))
    return out


if __name__ == "__main__":
    matrix, index = corpus()
    meta = artist_album_of(index)
    label = names(index)

    # train on ListenBrainz, which is where the supervision is; cached so the
    # feed can be re-cut without paying for training again
    import os
    if os.path.exists("emb.npy"):
        emb = np.load("emb.npy")
    else:
        groups = sittings(json.load(open("lb-listens.json")), index)
        rng = random.Random(7)
        rng.shuffle(groups)
        plays = [row for _, ids in groups for row in ids]
        a, b, y = pairs(groups, random.Random(3), matrix.shape[0], plays, True)
        tower = P.Tower(matrix.shape[1], seed=0)
        P.train(tower, matrix, a, b, y, epochs=10, batch=1024)
        emb, _ = tower.forward(matrix)
        np.save("emb.npy", emb)

    # Vonga's own history
    hist = json.load(open("friends-history.json"))[USER]
    hist.sort(key=lambda r: r["timestamp"])
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
    print(f"{len(hist)} plays, {len(played)} of them describable, "
          f"{len(artist_plays)} artists, {len(album_plays)} albums\n")

    taste = emb[list(played)].mean(0)
    taste /= np.linalg.norm(taste) + 1e-8
    n = len(rows)

    familiar, fresh = [], []
    for row in range(matrix.shape[0]):
        if row in played:
            continue
        art, alb = meta.get(row, (None, None))
        aff = (artist_plays.get(art, 0) + album_plays.get(alb, 0)) / (n + SHRINK)
        cos = float(taste @ emb[row])
        known = art in artist_plays
        (familiar if known else fresh).append((aff + VECTOR_WEIGHT * cos, cos, row, known))

    familiar.sort(reverse=True)
    fresh.sort(key=lambda x: -x[1])          # nothing else can rank a new artist

    def cap_by_artist(items, per_artist=2):
        """At most a couple from any one act.

        Affinity is an artist-level quantity, so every track by somebody heavily
        played scores nearly the same and the lane fills with one name — nine of
        the first twelve, in the first cut of this. That is a worse feed than a
        lower-scoring one with range in it: the listener already knows they like
        that artist, and a page of them is a discography, not a recommendation.
        """
        seen, out = {}, []
        for item in items:
            art = meta.get(item[2], (None, None))[0]
            if seen.get(art, 0) >= per_artist:
                continue
            seen[art] = seen.get(art, 0) + 1
            out.append(item)
        return out

    familiar_all, fresh_all = familiar, fresh
    familiar, fresh = cap_by_artist(familiar), cap_by_artist(fresh)

    def show(title, items, k=12):
        print(f"\n=== {title} ===")
        for i, (score, cos, row, known) in enumerate(items[:k], 1):
            t, a = label.get(row, ("?", "?"))
            print(f"{i:2} {t[:38]:40} {a[:24]:26} {cos:+.3f}")

    show(f"DEEPENING lane — artists Vonga already plays ({len(familiar_all)} candidates)", familiar)
    show(f"DISCOVERY lane — artists Vonga has never played ({len(fresh_all)} candidates)", fresh)

    print("\n=== the interleaved feed, 65/35 ===")
    out, i, j, owed = [], 0, 0, 0.0
    while len(out) < 15:
        owed += 0.65
        if owed >= 1 and i < len(familiar):
            out.append((familiar[i], "known")); i += 1; owed -= 1
        elif j < len(fresh):
            out.append((fresh[j], "NEW")); j += 1
    for k, ((score, cos, row, known), lane) in enumerate(out, 1):
        t, a = label.get(row, ("?", "?"))
        print(f"{k:2} {t[:36]:38} {a[:22]:24} {lane}")
