"""
The song model, trained on the ListenBrainz catalogue and written out for the
server to use.

The recipe is the research's shipped embedding (vonga_feed.py): songvec's
46-dimension vector into a 46 -> 48 -> 16 tower, trained on co-listening in
thirty-minute sittings with negatives drawn in proportion to how often songs
are played, ten epochs at a batch of 1024. What is new is that the result is
kept. The research saved only the embeddings it produced; the server needs the
weights, and everything the vector was built against:

    vocabulary   genre-vocab.json, as committed; never regenerated here
    rankTable    every rank in the catalogue, raw and ascending
    maxFans      the largest fan count in the catalogue
    nowYear      the year ages are measured from

Those travel with the weights because the tower only means anything for
vectors built against them, and recomputing them as a catalogue grows would
quietly change what every stored vector means. The rank table is raw ranks
rather than their logs: the percentile is the same either way, and whole
numbers compare exactly in Python and TypeScript alike.

Before the final model the recipe is scored on listeners it never trained on,
so the bundle carries an honest number for what it does. Parity samples go in
too — songs, their vectors and their embeddings — so the server's port can be
checked against this file.

Run from the directory lb_catalogue.py and deezer_catalogue.py wrote to:

    python train_bundle.py ../../models/song-vector-1.json
"""
import json, os, random, sys, time
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pairmodel as P, songvec  # noqa: E402
from songvec import SongVectors  # noqa: E402
from bigtrain import sittings  # noqa: E402
from bigablate import pairs  # noqa: E402

VERSION = "song-vector-1"
EPOCHS = 10
BATCH = 1024
HELD_OUT_SHARE = 0.2
PARITY_SAMPLES = 8

# Seven days of ListenBrainz is far more listening than the research had: over a
# million sittings, which bigablate.pairs would turn into some 75 million pairs,
# built as Python lists — about 8 GB of them — before numpy sees any. A fixed
# sample of whole sittings keeps memory and time sane, and at 300,000 is still
# about eight times the research's own 36,000. The bundle records how many
# there were and how many were used. Overridable, so the sampling can be tried
# on something small.
MAX_TRAIN_SITTINGS = int(os.environ.get("MAX_TRAIN_SITTINGS", 300_000))
MAX_TEST_SITTINGS = int(os.environ.get("MAX_TEST_SITTINGS", 60_000))


def capped(groups, limit, seed):
    """At most `limit` whole sittings, the same ones every run."""
    return groups if len(groups) <= limit else random.Random(seed).sample(groups, limit)


def read_jsonl(path):
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def catalogue():
    tracks = {str(t["id"]): t for t in read_jsonl("dz-tracks.jsonl")}
    albums = {str(a["id"]): a for a in read_jsonl("dz-albums.jsonl") if not a.get("missing")}
    artists = {str(a["id"]): a for a in read_jsonl("dz-artists.jsonl") if not a.get("missing")}
    return tracks, albums, artists


def listening(to_track):
    """Every listen of a matched track, per listener, oldest first, as bigtrain.sittings wants it."""
    z = np.load("lb-listens.npz")
    listens = defaultdict(list)
    for user, ts, k in zip(z["user"].tolist(), z["ts"].tolist(), z["track"].tolist()):
        track = to_track.get(k)
        if track is not None:
            listens[user].append((ts, "deezer", track))
    for plays in listens.values():
        plays.sort()
    return listens


def auc_table(matrix, tower, a, b, y):
    emb, _ = tower.forward(matrix)
    norm = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-8)
    genre = len(songvec.GENRES) + 2
    gnorm = matrix[:, :genre] / (np.linalg.norm(matrix[:, :genre], axis=1, keepdims=True) + 1e-8)
    return {
        "learned": float(P.auc((emb[a] * emb[b]).sum(1), y)),
        "raw_cosine": float(P.auc((norm[a] * norm[b]).sum(1), y)),
        "genre_only": float(P.auc((gnorm[a] * gnorm[b]).sum(1), y)),
    }


def main(out_path):
    started = time.time()

    songvec._set_vocabulary(songvec.load_vocabulary(os.path.join(HERE, "genre-vocab.json")))
    tracks, albums, artists = catalogue()
    sv = SongVectors(tracks, albums, artists, None)

    ids = list(tracks)
    index = {("deezer", tid): row for row, tid in enumerate(ids)}
    matrix = np.stack([sv.vector(tracks[tid]) for tid in ids])

    to_track = {}
    for m in read_jsonl("dz-matches.jsonl"):
        if m["status"] == "found":
            to_track[m["i"]] = str(m["track"])
        else:
            to_track.pop(m["i"], None)

    groups = sittings(listening(to_track), index)
    listeners = sorted({u for u, _ in groups})
    print(f"{matrix.shape[0]:,} tracks, {len(groups):,} sittings from {len(listeners):,} listeners", flush=True)

    # --- scored on listeners it never saw
    rng = random.Random(7)
    rng.shuffle(listeners)
    held = set(listeners[:int(len(listeners) * HELD_OUT_SHARE)])
    train_groups = capped([g for g in groups if g[0] not in held], MAX_TRAIN_SITTINGS, 11)
    test_groups = capped([g for g in groups if g[0] in held], MAX_TEST_SITTINGS, 12)
    n = matrix.shape[0]

    a_tr, b_tr, y_tr = pairs(train_groups, random.Random(3), n, [r for _, ids_ in train_groups for r in ids_], True)
    a_te, b_te, y_te = pairs(test_groups, random.Random(4), n, [r for _, ids_ in test_groups for r in ids_], True)
    print(f"held out {len(held):,} listeners: {len(y_tr):,} training pairs, {len(y_te):,} test pairs", flush=True)

    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a_tr, b_tr, y_tr, epochs=EPOCHS, batch=BATCH)
    evaluation = auc_table(matrix, tower, a_te, b_te, y_te)
    evaluation.update({"held_out_listeners": len(held), "test_pairs": int(len(y_te))})
    print(f"held-out AUC: {evaluation}", flush=True)

    # --- the model that ships, trained on everyone (or a fixed sample of everyone)
    final_groups = capped(groups, MAX_TRAIN_SITTINGS, 13)
    plays = [r for _, ids_ in final_groups for r in ids_]
    a, b, y = pairs(final_groups, random.Random(3), n, plays, True)
    print(f"final model: {len(final_groups):,} of {len(groups):,} sittings, {len(y):,} pairs", flush=True)
    tower = P.Tower(matrix.shape[1], seed=0)
    P.train(tower, matrix, a, b, y, epochs=EPOCHS, batch=BATCH)

    # --- parity samples: the vector and the embedding, straight from this code
    picks = random.Random(5).sample(ids, min(PARITY_SAMPLES, len(ids)))
    parity = []
    for tid in picks:
        t = tracks[tid]
        vector = sv.vector(t)
        emb, _ = tower.forward(vector[None, :])
        parity.append({
            "track": t,
            "album": albums.get(str((t.get("album") or {}).get("id"))),
            "artist": artists.get(str((t.get("artist") or {}).get("id"))),
            "vector": [float(x) for x in vector],
            "embedding": [float(x) for x in emb[0]],
        })

    ranks = sorted(int(t["rank"]) for t in tracks.values() if t.get("rank"))
    fans = [a_["nb_fan"] for a_ in artists.values() if a_.get("nb_fan")]
    dumps = json.load(open("lb-top.json"))

    bundle = {
        "version": VERSION,
        "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vocabulary": list(songvec.GENRES),
        "nowYear": songvec.NOW_YEAR,
        "rankTable": ranks,
        "maxFans": max(fans) if fans else 0,
        "dims": list(songvec.DIMS),
        "tower": {p: getattr(tower, p).tolist() for p in ("W1", "b1", "W2", "b2")},
        "recipe": {"hidden": int(tower.b1.shape[0]), "embedding": int(tower.b2.shape[0]), "epochs": EPOCHS,
                   "batch": BATCH, "temperature": 4.0, "negatives": "popularity-matched, one per positive",
                   "session_gap_s": 30 * 60},
        "source": {"listenbrainz_listens": dumps["total_listens"], "tracks": int(matrix.shape[0]),
                   "sittings": len(groups), "sittings_used": len(final_groups), "listeners": len(listeners),
                   "training_pairs": int(len(y))},
        "evaluation": evaluation,
        "parity": parity,
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(bundle, fh, separators=(",", ":"))
    print(f"wrote {out_path} ({os.path.getsize(out_path) / 1e3:.0f} kB) in {(time.time() - started) / 60:.0f} min")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
