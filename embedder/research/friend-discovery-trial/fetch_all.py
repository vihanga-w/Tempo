"""Pull every friend's playback history off the Tempo API into one file."""
import os, json, urllib.request, ssl, time, datetime as dt

TOK = open(".tok").read().strip()
API = "https://tempo-be.vihangaw.xyz"
ME  = "yh1q376ly901c0qk03n9kaphh"
# The agent proxy's trust store where it exists, the system one anywhere else.
# Naming it unconditionally made these scripts fail to import off that host.
_CA = "/root/.ccr/ca-bundle.crt"
ctx = (ssl.create_default_context(cafile=_CA) if os.path.exists(_CA)
       else ssl.create_default_context())

def get(u):
    r = urllib.request.Request(u, headers={"x-api-token": TOK, "User-Agent": "TempoTrial/1.0"})
    return json.load(urllib.request.urlopen(r, context=ctx, timeout=60))

friends = get(f"{API}/me/friends")["data"]
ids = {ME}
for f in friends:
    ids.add(f["u1Id"]); ids.add(f["u2Id"])
ids = sorted(ids)

out = {}
for uid in ids:
    rows, page = [], 0
    try:
        while True:
            d = get(f"{API}/profile/{uid}/history/{page}")
            batch = d.get("data", [])
            rows += batch
            if d.get("isFinalPage") or not batch or page > 400:
                break
            page += 1
            time.sleep(0.05)
    except Exception as ex:
        print(f"{uid:32} FAILED {ex}")
        continue
    name = rows[0]["username"] if rows else "?"
    out[uid] = rows
    if rows:
        ts = [r["timestamp"] for r in rows]
        span = (max(ts) - min(ts)) / 86400e3
        print(f"{name:12} {uid:32} plays {len(rows):5}  unique {len({r['item']['track']['id'] for r in rows}):5}  span {span:5.1f}d")
    else:
        print(f"{'?':12} {uid:32} plays     0")

json.dump(out, open("friends-history.json", "w"))
print("total plays", sum(len(v) for v in out.values()))
