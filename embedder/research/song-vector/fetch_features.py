"""Album genres and artist scale — the two metadata fields the song vector
needs that a track lookup does not carry."""
import json, ssl, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ctx = ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
UA = "TempoTrial/1.0 (vihanga.we@gmail.com)"

def get(url):
    r = urllib.request.Request(url, headers={"User-Agent": UA})
    return json.load(urllib.request.urlopen(r, context=ctx, timeout=25))

DEEZER = json.load(open("group-deezer.json"))
CATALOGUE = json.load(open("artist-catalogues.json"))

albums, artists = set(), set()
for d in DEEZER.values():
    if not d: continue
    if (d.get("album") or {}).get("id"): albums.add(d["album"]["id"])
    if (d.get("artist") or {}).get("id"): artists.add(d["artist"]["id"])
for tracks in CATALOGUE.values():
    for t in tracks:
        if (t.get("album") or {}).get("id"): albums.add(t["album"]["id"])
        if (t.get("artist") or {}).get("id"): artists.add(t["artist"]["id"])
print(f"albums {len(albums)}  artists {len(artists)}", flush=True)

def fetch(kind):
    def one(i):
        try:
            d = get(f"https://api.deezer.com/2.0/{kind}/{i}")
            return i, (None if d.get("error") else d)
        except Exception:
            return i, None
    return one

for kind, ids, out in [("album", albums, "albums.json"), ("artist", artists, "artists.json")]:
    got = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for n, (i, d) in enumerate(ex.map(fetch(kind), list(ids))):
            got[str(i)] = d
            if n % 200 == 0:
                print(f"  {kind} {n}/{len(ids)}", flush=True); time.sleep(0.4)
    json.dump(got, open(out, "w"))
    ok = sum(1 for v in got.values() if v)
    print(f"{kind}: {ok}/{len(ids)} resolved", flush=True)
