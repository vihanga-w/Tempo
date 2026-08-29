"""What of the dump do we actually read, and what would a distilled copy cost?"""
import tarfile, zstandard, json
from collections import Counter

USED = {"user_name", "timestamp", "track_metadata.track_name", "track_metadata.artist_name"}

bytes_by_key = Counter()
total = rows = mbid_present = distilled = 0

dctx = zstandard.ZstdDecompressor()
with open("lb-incremental.tar.zst", "rb") as fh, dctx.stream_reader(fh) as reader:
    tar = tarfile.open(fileobj=reader, mode="r|")
    for member in tar:
        if not member.name.endswith(".listens"):
            continue
        f = tar.extractfile(member)
        for line in f:
            rows += 1
            total += len(line)
            try:
                d = json.loads(line)
            except Exception:
                continue
            for k, v in d.items():
                if k == "track_metadata" and isinstance(v, dict):
                    for k2, v2 in v.items():
                        bytes_by_key["track_metadata." + k2] += len(json.dumps(v2))
                else:
                    bytes_by_key[k] += len(json.dumps(v))
            meta = d.get("track_metadata") or {}
            mm = meta.get("mbid_mapping") or {}
            if mm.get("recording_mbid"):
                mbid_present += 1
            ident = mm.get("recording_mbid") or (str(meta.get("artist_name")) + "/" + str(meta.get("track_name")))
            distilled += len(json.dumps([d.get("user_name"), d.get("timestamp"), ident]))
            if rows >= 400000:
                break
        break

used = sum(v for k, v in bytes_by_key.items() if k in USED)
print(str(rows) + " rows sampled, " + format(total / 1e6, ".0f") + " MB of JSON")
print()
print("field".ljust(38) + "MB".rjust(8) + "share".rjust(8) + "  used?")
for k, v in bytes_by_key.most_common(14):
    mark = "  YES" if k in USED else "   no"
    print(k.ljust(38) + format(v / 1e6, "8.1f") + format(v / total * 100, "6.1f") + "%" + mark)
print()
print("fields we read:  " + format(used / 1e6, "8.1f") + " MB  (" + format(used / total * 100, ".1f") + "% of bytes)")
print("everything else: " + format((total - used) / 1e6, "8.1f") + " MB  (" + format((total - used) / total * 100, ".1f") + "%)")
print("distilled row (user, time, id): " + format(distilled / 1e6, ".1f") + " MB  ("
      + format(distilled / total * 100, ".1f") + "% of the JSON)")
print()
print("recording_mbid present on " + format(mbid_present / rows * 100, ".1f")
      + "% of rows - a real id, where we currently match on normalised strings")
