"""
The same model, trained on real listening at a size that can support it.

Everything the five-account trial concluded about which features matter was
conclusion drawn from 49 sittings. At that size a block can only be judged by
whether the model overfits it, which is not the same question as whether it
carries anything. This runs the identical experiment over sittings taken from
the ListenBrainz dump instead.
"""
import json, math, random, statistics
import numpy as np

import pairmodel as P, songvec
from songvec import SongVectors

SESSION_GAP = 30 * 60          # seconds, as the dump timestamps are seconds


def corpus():
    """Vectors for everything describable, keyed the way the miner keyed it."""
    deezer = {k: v for k, v in json.load(open("group-deezer.json")).items() if v}
    albums = {k: v for k, v in json.load(open("albums.json")).items() if v}
    artists = {k: v for k, v in json.load(open("artists.json")).items() if v}
    catalogue = json.load(open("artist-catalogues.json"))

    songvec._set_vocabulary(songvec.load_vocabulary("genre-vocab.json"))
    sv = SongVectors(deezer, albums, artists, catalogue)

    index, rows = {}, []
    for sid, t in deezer.items():
        index[("spotify", sid)] = len(rows)
        rows.append(sv.vector(t))
    for tracks in catalogue.values():
        for t in tracks:
            k = ("deezer", str(t["id"]))
            if k in index:
                continue
            index[k] = len(rows)
            rows.append(sv.vector(t))
    return np.stack(rows), index


def sittings(listens, index, min_len=2, max_len=60):
    out = []
    for user, plays in listens.items():
        current = []
        last = None
        for ts, kind, ident in plays:
            if last is not None and ts - last > SESSION_GAP:
                if len(current) >= min_len:
                    out.append((user, current[:max_len]))
                current = []
            row = index.get((kind, ident))
            if row is not None:
                current.append(row)
            last = ts
        if len(current) >= min_len:
            out.append((user, current[:max_len]))
    return out


if __name__ == "__main__":
    matrix, index = corpus()
    listens = json.load(open("lb-listens.json"))
    groups = sittings(listens, index)
    print(f"{matrix.shape[0]} describable tracks, {len(groups)} sittings from "
          f"{len({u for u, _ in groups})} listeners")

    rng = random.Random(7)
    rng.shuffle(groups)
    cut = int(len(groups) * 0.8)
    n = matrix.shape[0]
    a_tr, b_tr, y_tr = P.pairs_from(groups[:cut], rng, 1, n)
    a_te, b_te, y_te = P.pairs_from(groups[cut:], rng, 1, n)
    print(f"pairs {len(y_tr):,} train / {len(y_te):,} test\n")

    def run(cols, label, epochs=12):
        m = matrix[:, cols] if cols is not None else matrix
        tower = P.Tower(m.shape[1], seed=0)
        P.train(tower, m, a_tr, b_tr, y_tr, epochs=epochs, batch=1024)
        emb, _ = tower.forward(m)
        learned = P.auc((emb[a_te] * emb[b_te]).sum(1), y_te)
        norm = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)
        raw = P.auc((norm[a_te] * norm[b_te]).sum(1), y_te)
        print(f"{label:32}{raw:9.3f}{learned:11.3f}")
        return learned

    gb = len(songvec.GENRES) + 2
    print(f"{'vector':32}{'raw cosine':>9}{'learned':>11}")
    print('-' * 52)
    run(list(range(gb)), "genre only")
    run(None, "everything (46 dims)")
