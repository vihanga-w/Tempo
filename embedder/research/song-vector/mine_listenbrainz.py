"""
Pulling co-listening supervision out of the open ListenBrainz dump.

The metric model is starved: 49 sittings from five accounts is not enough to
learn what a difference between two songs means, which is why every block but
genre made it worse. ListenBrainz publishes real listens under CC0, a full dump
plus a new incremental every day, and one day of it is 2.6 GB.

Only listens of tracks this project can already describe are kept — there is no
point in a pair whose vector cannot be built. Matching is on artist and title,
normalised, since the dump's MBIDs and Deezer's ids do not meet.
"""
import json, re, tarfile, zstandard
from collections import defaultdict

DUMP = "lb-incremental.tar.zst"

_paren = re.compile(r"[\(\[].*?[\)\]]")
_feat = re.compile(r"\b(feat|ft|featuring|with)\b.*$", re.I)
_noise = re.compile(r"[^a-z0-9]+")


def key(artist, title):
    """Same track, whoever typed the metadata."""
    title = _paren.sub(" ", title or "")
    title = _feat.sub(" ", title)
    artist = _feat.sub(" ", _paren.sub(" ", artist or ""))
    artist = artist.split(",")[0].split("&")[0]
    return _noise.sub("", artist.lower()), _noise.sub("", title.lower())


def describable():
    """Every track a vector can be built for, keyed for matching."""
    out = {}
    deezer = {k: v for k, v in json.load(open("group-deezer.json")).items() if v}
    for sid, t in deezer.items():
        out[key((t.get("artist") or {}).get("name"), t.get("title"))] = ("spotify", sid)
    for tracks in json.load(open("artist-catalogues.json")).values():
        for t in tracks:
            k = key((t.get("artist") or {}).get("name"), t.get("title"))
            out.setdefault(k, ("deezer", str(t["id"])))
    return out


if __name__ == "__main__":
    index = describable()
    print(f"{len(index)} describable tracks", flush=True)

    per_user = defaultdict(list)
    seen = matched = 0

    with open(DUMP, "rb") as fh, zstandard.ZstdDecompressor().stream_reader(fh) as reader:
        tar = tarfile.open(fileobj=reader, mode="r|")
        for member in tar:
            if not member.name.endswith(".listens"):
                continue
            stream = tar.extractfile(member)
            for line in stream:
                seen += 1
                if seen % 2_000_000 == 0:
                    print(f"  {seen/1e6:.0f}M listens, {matched} matched, "
                          f"{len(per_user)} users", flush=True)
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                meta = row.get("track_metadata") or {}
                hit = index.get(key(meta.get("artist_name"), meta.get("track_name")))
                if not hit:
                    continue
                matched += 1
                per_user[row["user_name"]].append((row["timestamp"], hit[0], hit[1]))
            break

    print(f"\n{seen} listens read, {matched} of describable tracks, {len(per_user)} users", flush=True)
    keep = {u: sorted(v) for u, v in per_user.items() if len(v) >= 2}
    print(f"{len(keep)} users with at least two", flush=True)
    json.dump(keep, open("lb-listens.json", "w"))
