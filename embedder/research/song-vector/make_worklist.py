"""One portable file of everything still needing a Discogs lookup."""
import json

out, seen = [], set()

deezer = {k: v for k, v in json.load(open("group-deezer.json")).items() if v}
for sid, t in deezer.items():
    out.append({"id": "sp:" + sid,
                "artist": (t.get("artist") or {}).get("name", ""),
                "title": t.get("title", ""),
                "year": (t.get("release_date") or "")[:4]})
    seen.add("sp:" + sid)

for tracks in json.load(open("artist-catalogues.json")).values():
    for t in tracks:
        key = "dz:" + str(t["id"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": key,
                    "artist": (t.get("artist") or {}).get("name", ""),
                    "title": t.get("title", ""),
                    "year": ""})

json.dump(out, open("discogs-worklist.json", "w"))
print(f"{len(out)} tracks to look up")
