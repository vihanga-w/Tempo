"""
Is Discogs style a better genre block than Deezer genre?

Deezer files 58% of this catalogue under one label, Rap/Hip Hop, which cannot
separate anybody from anybody. Discogs carries a second field, style, that is
several times narrower. The question is whether that resolution survives contact
with real listening or just looks better in a table.

Only tracks with both labels are scored, so the two blocks are compared on the
same music.
"""
import json, random, statistics
from collections import Counter
import numpy as np

import pairmodel as P, songvec
from bigtrain import corpus, sittings

STYLE_VOCAB = 60


def style_block(vocab, styles):
    v = np.zeros(len(vocab) + 2, dtype=np.float32)
    if not styles:
        return v
    v[-1] = 1.0
    share = 1.0 / len(styles)
    for s in styles:
        if s in vocab:
            v[vocab[s]] += share
        else:
            v[-2] += share
    return v


if __name__ == "__main__":
    matrix, index = corpus()
    discogs = {k: v for k, v in json.load(open("discogs.json")).items() if v}
    print(f"{len(discogs)} tracks with Discogs labels")

    counts = Counter(s for v in discogs.values() for s in v["style"])
    vocab = {name: i for i, (name, _) in enumerate(counts.most_common(STYLE_VOCAB))}
    print(f"{len(counts)} distinct styles, top {len(vocab)} kept")

    # rows we can compare on: described by both sources
    rows_with_style = {}
    for sid, v in discogs.items():
        row = index.get(("spotify", sid))
        if row is not None:
            rows_with_style[row] = style_block(vocab, v["style"])

    gb = len(songvec.GENRES) + 2
    keep = sorted(rows_with_style)
    print(f"{len(keep)} of them are in the corpus\n")

    remap = {row: i for i, row in enumerate(keep)}
    deezer_m = matrix[keep][:, :gb]
    discogs_m = np.stack([rows_with_style[r] for r in keep])
    both_m = np.concatenate([deezer_m, discogs_m], axis=1)

    groups = sittings(json.load(open("lb-listens.json")), index)
    small = []
    for user, ids in groups:
        kept = [remap[r] for r in ids if r in remap]
        if len(kept) >= 2:
            small.append((user, kept))
    print(f"{len(small)} sittings survive the restriction")

    rng = random.Random(7)
    rng.shuffle(small)
    cut = int(len(small) * 0.8)
    n = len(keep)
    plays = [r for _, ids in small[:cut] for r in ids]
    from bigablate import pairs
    a_tr, b_tr, y_tr = pairs(small[:cut], random.Random(3), n, plays, True)
    a_te, b_te, y_te = pairs(small[cut:], random.Random(3), n, plays, True)
    print(f"pairs {len(y_tr):,} train / {len(y_te):,} test\n")

    print(f"{'genre block':34}{'dims':>6}{'raw cosine':>12}{'learned':>10}")
    print('-' * 62)
    for label, m in [("Deezer genre", deezer_m), ("Discogs style", discogs_m),
                     ("both", both_m)]:
        tower = P.Tower(m.shape[1], seed=0)
        P.train(tower, m, a_tr, b_tr, y_tr, epochs=25, batch=512)
        emb, _ = tower.forward(m)
        norm = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)
        print(f"{label:34}{m.shape[1]:6}{P.auc((norm[a_te]*norm[b_te]).sum(1), y_te):12.3f}"
              f"{P.auc((emb[a_te]*emb[b_te]).sum(1), y_te):10.3f}")
