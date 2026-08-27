#!/usr/bin/env python3
"""
Discogs lookups for one slice of the work list.

Run a shard per machine. Discogs limits by IP, so two machines is two budgets --
though a free personal access token is the bigger lever: it takes one IP from 25
requests a minute to 60, which beats splitting unauthenticated work across two.
Both together is best.

    python3 discogs_shard.py --shard 0 --of 2
    python3 discogs_shard.py --shard 1 --of 2 --token YOUR_TOKEN

Each shard writes discogs-shard-<n>.json and resumes from it, so it is safe to
stop and restart. Merge with:

    python3 discogs_shard.py --merge
"""
import argparse, glob, json, os, ssl, sys, time, urllib.error, urllib.parse, urllib.request

UA = "TempoDiscoveryTrial/1.0 (+https://github.com/vihanga-w/tempo)"
CA = "/root/.ccr/ca-bundle.crt"       # ignored where it does not exist


def context():
    return ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()


def get(url, token, ctx):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Discogs token=" + token
    request = urllib.request.Request(url, headers=headers)
    return json.load(urllib.request.urlopen(request, context=ctx, timeout=30))


def lookup(track, token, ctx):
    if not track["artist"] or not track["title"]:
        return None

    query = urllib.parse.quote(track["artist"] + " " + track["title"])
    data = get("https://api.discogs.com/database/search?type=release&per_page=5&q=" + query, token, ctx)

    want = int(track["year"]) if track.get("year", "").isdigit() else None

    for result in (data.get("results") or []):
        # Discogs has no ISRC index, so matching is on name and the year is the
        # only check available that the right record came back
        if want and str(result.get("year", "")).isdigit():
            if abs(int(result["year"]) - want) > 2:
                continue
        if result.get("style") or result.get("genre"):
            return {"genre": result.get("genre") or [], "style": result.get("style") or [],
                    "year": result.get("year"), "matched": result.get("title")}
    return None


def merge():
    out = {}
    for path in sorted(glob.glob("discogs-shard-*.json")):
        part = json.load(open(path))
        out.update(part)
        print(f"  {path}: {len(part)}")
    json.dump(out, open("discogs.json", "w"))
    got = sum(1 for v in out.values() if v)
    styles = {s for v in out.values() if v for s in v["style"]}
    print(f"merged {len(out)} lookups, {got} matched ({got/max(1,len(out))*100:.0f}%), "
          f"{len(styles)} distinct styles -> discogs.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--of", type=int, default=1)
    ap.add_argument("--token", default=os.environ.get("DISCOGS_TOKEN", ""))
    ap.add_argument("--worklist", default="discogs-worklist.json")
    ap.add_argument("--merge", action="store_true")
    args = ap.parse_args()

    if args.merge:
        merge()
        return

    # 60 requests a minute with a token, 25 without, and a little headroom under
    # each so a burst at the start does not trip the limiter
    gap = 1.1 if args.token else 2.6

    work = json.load(open(args.worklist))
    mine = [t for i, t in enumerate(work) if i % args.of == args.shard]

    path = f"discogs-shard-{args.shard}.json"
    done = json.load(open(path)) if os.path.exists(path) else {}
    todo = [t for t in mine if t["id"] not in done]

    print(f"shard {args.shard} of {args.of}: {len(mine)} tracks, {len(done)} already done, "
          f"{len(todo)} to go, about {len(todo)*gap/60:.0f} minutes"
          f"{' (with token)' if args.token else ' (no token - pass --token to go 2.4x faster)'}",
          flush=True)

    ctx = context()
    backoff = gap

    for n, track in enumerate(todo):
        try:
            done[track["id"]] = lookup(track, args.token, ctx)
            backoff = gap
        except urllib.error.HTTPError as ex:
            if ex.code == 429:
                # the limiter is per minute, so waiting it out beats hammering
                backoff = min(backoff * 2, 120)
                print(f"  rate limited, sleeping {backoff:.0f}s", flush=True)
                time.sleep(backoff)
                continue
            done[track["id"]] = None
        except Exception:
            done[track["id"]] = None

        if n % 50 == 0:
            json.dump(done, open(path, "w"))
            got = sum(1 for v in done.values() if v)
            print(f"  {n}/{len(todo)}  matched {got}", flush=True)
        time.sleep(gap)

    json.dump(done, open(path, "w"))
    got = sum(1 for v in done.values() if v)
    print(f"shard {args.shard} done: {got}/{len(done)} matched", flush=True)


if __name__ == "__main__":
    main()
