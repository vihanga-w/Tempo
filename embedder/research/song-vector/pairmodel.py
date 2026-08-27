"""
Learning what makes two songs go together.

The vectors in songvec.py describe songs. What they do not say is which
differences between two songs matter — whether a decade apart counts for more
than a genre apart, whether an obscure track sits closer to another obscure one
than to a famous track in the same genre. Nothing in the metadata answers that.
Listening does.

So the supervision is co-listening: two tracks somebody played in the same
sitting are a pair that goes together, two tracks drawn at random are not. That
uses behaviour to learn the metric while leaving the song vectors themselves
untouched by it — a song's description stays the same whoever is listening, and
can be computed for a song nobody has played.

Sittings are held out whole. Splitting on individual plays would put one half of
a pair in training and the other in test, and the model would score well by
having already seen the answer.
"""
import json, math, random
import numpy as np

import songvec
from songvec import DIMS, load

SESSION_GAP_MS = 30 * 60e3
EMBED = 16


# --- data --------------------------------------------------------------------

def sessions(history):
    """Runs of listening with no long silence in them."""
    out, current = [], []
    for row in history:
        if current and row["timestamp"] - current[-1]["timestamp"] > SESSION_GAP_MS:
            out.append(current)
            current = []
        current.append(row)
    if current:
        out.append(current)
    return out


def build(scratch="."):
    sv, deezer, catalogue = load(scratch)
    hist = json.load(open(f"{scratch}/friends-history.json"))
    hist = {k: sorted(v, key=lambda r: r["timestamp"]) for k, v in hist.items() if v}

    # every track we can describe, keyed the way history refers to it
    vectors, index = {}, {}
    for spotify_id, track in deezer.items():
        index[spotify_id] = len(vectors)
        vectors[spotify_id] = sv.vector(track)
    matrix = np.stack(list(vectors.values()))

    groups = []           # sittings, as lists of row indices into `matrix`
    for uid, rows in hist.items():
        for sitting in sessions(rows):
            ids = [index[r["item"]["track"]["id"]] for r in sitting
                   if r["item"]["track"]["id"] in index]
            if len(ids) >= 2:
                groups.append((uid, ids))
    return sv, matrix, index, groups, hist


def pairs_from(groups, rng, negatives_per_positive=1, n_songs=0):
    xs_a, xs_b, ys = [], [], []
    for _, ids in groups:
        for i in range(len(ids)):
            for j in range(i + 1, min(i + 6, len(ids))):   # within a sitting, nearby
                if ids[i] == ids[j]:
                    continue
                xs_a.append(ids[i]); xs_b.append(ids[j]); ys.append(1.0)
                for _ in range(negatives_per_positive):
                    xs_a.append(ids[i]); xs_b.append(rng.randrange(n_songs)); ys.append(0.0)
    return np.array(xs_a), np.array(xs_b), np.array(ys, dtype=np.float32)


# --- a small tower, trained by hand ------------------------------------------

class Tower:
    """features -> embedding. Two layers is enough for 40 inputs."""

    def __init__(self, n_in, hidden=48, out=EMBED, seed=0):
        rng = np.random.default_rng(seed)
        scale = lambda a, b: rng.normal(0, math.sqrt(2 / a), (a, b)).astype(np.float32)
        self.W1, self.b1 = scale(n_in, hidden), np.zeros(hidden, np.float32)
        self.W2, self.b2 = scale(hidden, out), np.zeros(out, np.float32)
        self.params = ["W1", "b1", "W2", "b2"]
        self._m = {p: np.zeros_like(getattr(self, p)) for p in self.params}
        self._v = {p: np.zeros_like(getattr(self, p)) for p in self.params}
        self._t = 0

    def forward(self, x):
        h_pre = x @ self.W1 + self.b1
        h = np.maximum(h_pre, 0)
        z = h @ self.W2 + self.b2
        norm = np.linalg.norm(z, axis=1, keepdims=True) + 1e-8
        return z / norm, (x, h_pre, h, z, norm)

    def backward(self, grad_out, cache):
        x, h_pre, h, z, norm = cache
        # d(z/|z|)
        dz = (grad_out - (grad_out * z).sum(1, keepdims=True) * z / norm ** 2) / norm
        gW2 = h.T @ dz
        gb2 = dz.sum(0)
        dh = dz @ self.W2.T
        dh[h_pre <= 0] = 0
        gW1 = x.T @ dh
        gb1 = dh.sum(0)
        return {"W1": gW1, "b1": gb1, "W2": gW2, "b2": gb2}

    def step(self, grads, lr=3e-3, decay=1e-4):
        self._t += 1
        for p in self.params:
            g = grads[p] + decay * getattr(self, p)
            self._m[p] = 0.9 * self._m[p] + 0.1 * g
            self._v[p] = 0.999 * self._v[p] + 0.001 * g * g
            m = self._m[p] / (1 - 0.9 ** self._t)
            v = self._v[p] / (1 - 0.999 ** self._t)
            setattr(self, p, getattr(self, p) - lr * m / (np.sqrt(v) + 1e-8))


def train(tower, matrix, a, b, y, epochs=40, batch=256, seed=0, temperature=4.0):
    rng = np.random.default_rng(seed)
    n = len(y)
    for epoch in range(epochs):
        order = rng.permutation(n)
        total = 0.0
        for start in range(0, n, batch):
            idx = order[start:start + batch]
            xa, xb, yy = matrix[a[idx]], matrix[b[idx]], y[idx]
            ea, ca = tower.forward(xa)
            eb, cb = tower.forward(xb)
            cos = (ea * eb).sum(1)
            logit = temperature * cos
            pred = 1 / (1 + np.exp(-logit))
            total += float(np.mean(-(yy * np.log(pred + 1e-9) + (1 - yy) * np.log(1 - pred + 1e-9))))
            d = ((pred - yy) * temperature / len(idx))[:, None]
            ga = tower.backward(d * eb, ca)
            gb = tower.backward(d * ea, cb)
            tower.step({k: ga[k] + gb[k] for k in ga})
        if epoch % 10 == 9:
            print(f"  epoch {epoch+1:3}  loss {total / max(1, n // batch):.4f}")
    return tower


# --- scoring -----------------------------------------------------------------

def auc(scores, labels):
    order = np.argsort(scores)
    ranks = np.empty(len(scores), float)
    ranks[order] = np.arange(1, len(scores) + 1)
    pos, neg = labels == 1, labels == 0
    if not pos.any() or not neg.any():
        return 0.5
    return (ranks[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * neg.sum())


def cosine_rows(matrix, a, b):
    xa, xb = matrix[a], matrix[b]
    na = np.linalg.norm(xa, axis=1) + 1e-8
    nb = np.linalg.norm(xb, axis=1) + 1e-8
    return (xa * xb).sum(1) / (na * nb)


if __name__ == "__main__":
    rng = random.Random(11)
    sv, matrix, index, groups, hist = build()
    print(f"{matrix.shape[0]} songs described, {len(DIMS)} dimensions, {len(groups)} sittings")

    rng.shuffle(groups)
    cut = int(len(groups) * 0.75)
    train_groups, test_groups = groups[:cut], groups[cut:]

    n = matrix.shape[0]
    a_tr, b_tr, y_tr = pairs_from(train_groups, rng, 2, n)
    a_te, b_te, y_te = pairs_from(test_groups, rng, 2, n)
    print(f"pairs: {len(y_tr)} train ({int(y_tr.sum())} positive), {len(y_te)} test ({int(y_te.sum())} positive)\n")

    tower = Tower(matrix.shape[1])
    train(tower, matrix, a_tr, b_tr, y_tr)

    emb, _ = tower.forward(matrix)
    learned = (emb[a_te] * emb[b_te]).sum(1)
    raw = cosine_rows(matrix, a_te, b_te)
    genre_block = len(songvec.GENRES) + 2      # the genre one-hot, "other", and the presence bit
    genre_only = cosine_rows(matrix[:, :genre_block], a_te, b_te)

    print(f"\n{'how two songs are compared':34}{'AUC':>8}")
    print('-' * 42)
    print(f"{'chance':34}{0.5:8.3f}")
    print(f"{'raw metadata cosine':34}{auc(raw, y_te):8.3f}")
    print(f"{'genre block only':34}{auc(genre_only, y_te):8.3f}")
    print(f"{'learned embedding':34}{auc(learned, y_te):8.3f}")
