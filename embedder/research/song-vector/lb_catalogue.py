"""
The catalogue the song model is trained on, taken from what the world plays.

The research built its catalogue from five friends' histories and their
artists' top tracks. That tied the constants frozen into the model — the rank
percentiles and the largest fan count — to one friend group's taste, and the
model now serves everyone. So the catalogue is the most-listened tracks in the
ListenBrainz dumps instead, matched to Deezer by deezer_catalogue.py.

Two passes, because the dumps are far too big to hold:

    count    how often each track was played, keyed the way mine_listenbrainz
             keys it, so one song spelled five ways by five scrobblers is one
             song. Writes lb-top.json: the most-played keys, and how much of all
             listening each cut-off covers.
    extract  for the kept keys only, the commonest spelling of each (what
             Deezer is searched with) and every listen of them, as compact
             arrays: lb-spellings.json and lb-listens.npz.

Every .listens member of every dump is read. The daily incrementals carry one
each (about 4 GB of JSON a day), so mine_listenbrainz.py stopping after the first
lost nothing on them, but nothing promises the layout stays that way.

    python lb_catalogue.py count   lb/*.tar.zst
    python lb_catalogue.py extract 30000 lb/*.tar.zst
"""
import json, os, sys, tarfile
from array import array
from collections import Counter, defaultdict

import numpy as np
import zstandard

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mine_listenbrainz import key  # noqa: E402


def rows(paths):
    """Every listen in every .listens member of every dump, parsed."""
    for path in paths:
        print(f"  reading {os.path.basename(path)}", flush=True)
        with open(path, "rb") as fh, zstandard.ZstdDecompressor().stream_reader(fh) as reader:
            tar = tarfile.open(fileobj=reader, mode="r|")
            for member in tar:
                if not member.isfile() or not member.name.endswith(".listens"):
                    continue
                for line in tar.extractfile(member):
                    try:
                        yield json.loads(line)
                    except ValueError:
                        continue


def track_key(row):
    """The matching key for a listen, or None when there is nothing to match on."""
    meta = row.get("track_metadata") or {}
    artist, title = key(meta.get("artist_name"), meta.get("track_name"))
    # Non-Latin names normalise to nothing, and "" would merge every one of them
    if not artist or not title:
        return None
    return f"{artist}\t{title}"


def count(paths, keep=100_000):
    counts = Counter()
    total = 0
    for row in rows(paths):
        k = track_key(row)
        if k is None:
            continue
        counts[k] += 1
        total += 1
        if total % 5_000_000 == 0:
            print(f"  {total / 1e6:.0f}M keyed listens, {len(counts):,} tracks", flush=True)

    top = counts.most_common(keep)
    coverage, running = {}, 0
    for i, (_, n) in enumerate(top, 1):
        running += n
        if i in (5_000, 10_000, 20_000, 30_000, 50_000, 100_000):
            coverage[i] = running / total

    json.dump({
        "total_listens": total,
        "distinct_tracks": len(counts),
        "coverage": coverage,
        "top": [[k, n] for k, n in top],
    }, open("lb-top.json", "w"))

    print(f"\n{total:,} keyed listens of {len(counts):,} distinct tracks")
    for n, share in coverage.items():
        print(f"  top {n:>7,} tracks cover {share:6.1%} of listening")


def extract(paths, n):
    top = json.load(open("lb-top.json"))["top"][:n]
    index = {k: i for i, (k, _) in enumerate(top)}
    spellings = defaultdict(Counter)
    users = {}
    user_col, ts_col, track_col = array("q"), array("q"), array("q")
    skipped = 0

    for row in rows(paths):
        k = track_key(row)
        i = index.get(k) if k else None
        if i is None:
            continue

        meta = row.get("track_metadata") or {}
        spellings[i][(meta.get("artist_name") or "", meta.get("track_name") or "")] += 1

        user = row.get("user_name") or row.get("user_id")
        ts = row.get("listened_at", row.get("timestamp"))
        try:
            ts = int(ts)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if user is None:
            skipped += 1
            continue

        user_col.append(users.setdefault(user, len(users)))
        ts_col.append(ts)
        track_col.append(i)

    out = []
    for i, (k, listens) in enumerate(top):
        (artist, title), _ = spellings[i].most_common(1)[0] if spellings[i] else (("", ""), 0)
        out.append({"key": k, "listens": listens, "artist": artist, "title": title})
    json.dump(out, open("lb-spellings.json", "w"))

    np.savez_compressed(
        "lb-listens.npz",
        user=np.frombuffer(user_col, dtype=np.int64),
        ts=np.frombuffer(ts_col, dtype=np.int64),
        track=np.frombuffer(track_col, dtype=np.int64),
    )
    print(f"{len(track_col):,} listens of the top {n:,} tracks from {len(users):,} listeners"
          f" ({skipped:,} without a user or a usable time)")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "count":
        count(sorted(sys.argv[2:]))
    elif len(sys.argv) >= 4 and sys.argv[1] == "extract":
        extract(sorted(sys.argv[3:]), int(sys.argv[2]))
    else:
        sys.exit(__doc__)
