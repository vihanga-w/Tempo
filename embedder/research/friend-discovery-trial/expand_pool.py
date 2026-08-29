"""
Building the pool a friend-based recommender ought to be drawing from.

Today the candidates are the exact tracks friends have played. Measured against
what these people actually went on to play, that pool contains 5% of their
new-artist discoveries — but the *artist* is there a quarter of the time. So
this fetches, for every artist anyone in the group plays, that artist's own
catalogue from Deezer, and asks the same question of the bigger pool.
"""
import os, json, ssl, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

# The agent proxy's trust store where it exists, the system one anywhere else.
# Naming it unconditionally made these scripts fail to import off that host.
_CA = "/root/.ccr/ca-bundle.crt"
ctx = (ssl.create_default_context(cafile=_CA) if os.path.exists(_CA)
       else ssl.create_default_context())
UA = "TempoTrial/1.0 (vihanga.we@gmail.com)"

def get(url):
    r = urllib.request.Request(url, headers={"User-Agent": UA})
    return json.load(urllib.request.urlopen(r, context=ctx, timeout=25))

HIST = json.load(open("friends-history.json"))
tracks = {}
for rows in HIST.values():
    for r in rows:
        t = r["item"]["track"]
        tracks.setdefault(t["id"], t)

isrcs = {tid: t["isrc"] for tid, t in tracks.items() if t.get("isrc")}
print(f"unique tracks {len(tracks)}, with isrc {len(isrcs)}", flush=True)

def resolve(item):
    tid, isrc = item
    try:
        d = get(f"https://api.deezer.com/2.0/track/isrc:{isrc}")
        return tid, (None if d.get("error") else d)
    except Exception:
        return tid, None

resolved = {}
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, (tid, d) in enumerate(ex.map(resolve, list(isrcs.items()))):
        resolved[tid] = d
        if i % 150 == 0:
            print(f"  resolved {i}", flush=True); time.sleep(0.4)

json.dump(resolved, open("group-deezer.json", "w"))
ok = {k: v for k, v in resolved.items() if v}
print(f"deezer resolved {len(ok)}/{len(isrcs)}", flush=True)

artists = {}
for tid, d in ok.items():
    a = d.get("artist") or {}
    if a.get("id"):
        artists[a["id"]] = a.get("name")
print(f"distinct deezer artists {len(artists)}", flush=True)

def top(aid):
    try:
        d = get(f"https://api.deezer.com/2.0/artist/{aid}/top?limit=30")
        return aid, d.get("data", [])
    except Exception:
        return aid, []

catalogue = {}
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, (aid, data) in enumerate(ex.map(top, list(artists))):
        catalogue[aid] = data
        if i % 100 == 0:
            print(f"  catalogues {i}", flush=True); time.sleep(0.4)

json.dump(catalogue, open("artist-catalogues.json", "w"))
print("tracks in expanded pool:", sum(len(v) for v in catalogue.values()), flush=True)
