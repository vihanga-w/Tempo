"""
Matching the ListenBrainz catalogue to Deezer, and describing it.

Deezer's advanced search (artist:"..." track:"...") answers nothing any more, so
this searches plainly and accepts a result only when its artist and title key
to exactly what the listen keys to, by mine_listenbrainz's own rule. The first
result for "frank ocean nikes" is right; the second is a Polish song about the
sea. Anything that does not key the same is not a match, however high it ranks.

Each match is then read whole from /track/{id} — the same shape the server
reads by ISRC — with its album and artist, so the model is trained on exactly
what it will be given in production.

Deezer allows fifty requests in five seconds per address. One request at a time
never gets near that, because each spends most of its time waiting on the
reply, so several workers share one limiter that starts at most nine a second
between them, and all of them stand back together when Deezer says the quota is
spent.

Resumable: every answer is appended to a JSONL file as it arrives and a rerun
skips what is already known. A lookup that got no answer is recorded as failed
and tried again on the next run.

    python deezer_catalogue.py 30000     # the first 30,000 of lb-spellings.json
"""
import json, os, ssl, sys, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mine_listenbrainz import key  # noqa: E402

try:
    import certifi
    CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CONTEXT = ssl.create_default_context()

API = "https://api.deezer.com"
USER_AGENT = "TempoResearch/1.0 (+https://tempo.vihangaw.xyz)"

# Between request starts, across every worker: nine a second, under Deezer's ten
GAP_S = 0.11
WORKERS = 6
QUOTA_PAUSE_S = 5.0

_limiter = threading.Lock()
_next_start = [0.0]


def _wait_turn():
    with _limiter:
        now = time.monotonic()
        start = max(now, _next_start[0])
        _next_start[0] = start + GAP_S
    if start > now:
        time.sleep(start - now)


def _stand_back(seconds):
    """Every worker waits, not only the one that was told: the quota is shared."""
    with _limiter:
        _next_start[0] = max(_next_start[0], time.monotonic() + seconds)


def get(path):
    """("found", body), ("missing", None) or ("failed", None)."""
    for attempt in range(1, 5):
        _wait_turn()

        try:
            request = urllib.request.Request(API + path, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=20, context=CONTEXT) as response:
                body = json.load(response)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "missing", None
            if e.code == 429 or e.code >= 500:
                _stand_back(2 * attempt)
                continue
            return "failed", None
        except Exception:
            _stand_back(2 * attempt)
            continue

        error = body.get("error") if isinstance(body, dict) else None
        if not error:
            return "found", body
        if error.get("code") == 800:          # "no data"
            return "missing", None
        if error.get("code") in (4, 700):      # quota, busy: its window is five seconds
            _stand_back(QUOTA_PAUSE_S)
            continue
        return "failed", None
    return "failed", None


# Only what songvec reads is kept. A full track carries every country it is
# available in, which would make the catalogue many times its size for nothing.

def slim_track(t):
    return {
        **{k: t.get(k) for k in ("id", "title", "title_short", "isrc", "duration", "rank", "release_date",
                                 "explicit_lyrics", "explicit_content_lyrics", "gain", "bpm")},
        "contributors": [{"id": c.get("id")} for c in (t.get("contributors") or [])],
        "album": {"id": (t.get("album") or {}).get("id")},
        "artist": {"id": (t.get("artist") or {}).get("id"), "name": (t.get("artist") or {}).get("name")},
    }


def slim_album(a):
    return {
        "id": a.get("id"),
        "genres": {"data": [{"name": g.get("name")} for g in (a.get("genres") or {}).get("data", [])]},
        "release_date": a.get("release_date"),
    }


def slim_artist(a):
    return {"id": a.get("id"), "name": a.get("name"), "nb_fan": a.get("nb_fan")}


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as fh:
        for line in fh:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass    # a line cut short when a run was stopped; its track is simply asked again
    return out


def first_matching(wanted, body):
    for result in (body or {}).get("data", []):
        artist = (result.get("artist") or {}).get("name")
        keys = {"\t".join(key(artist, result.get("title"))), "\t".join(key(artist, result.get("title_short")))}
        if wanted in keys:
            return result
    return None


def main(n):
    spellings = json.load(open("lb-spellings.json"))[:n]

    # The latest answer for each key wins, so a failure retried into a match counts as a match
    matches = {m["i"]: m for m in read_jsonl("dz-matches.jsonl")}
    tracks = {t["id"]: t for t in read_jsonl("dz-tracks.jsonl")}
    albums = {a["id"]: a for a in read_jsonl("dz-albums.jsonl")}
    artists = {a["id"]: a for a in read_jsonl("dz-artists.jsonl")}

    out = {name: open(f"dz-{name}.jsonl", "a") for name in ("matches", "tracks", "albums", "artists")}
    state, io = threading.Lock(), threading.Lock()

    def write(name, record):
        with io:
            out[name].write(json.dumps(record) + "\n")
            out[name].flush()

    def settle(i):
        """One track, start to finish. Returns how it went."""
        s = spellings[i]
        try:
            kind, body = get("/search?limit=10&q=" + urllib.parse.quote(f'{s["artist"]} {s["title"]}'))
            if kind == "failed":
                write("matches", {"i": i, "status": "failed"})
                return "failed"

            hit = first_matching(s["key"], body)
            if not hit:
                write("matches", {"i": i, "status": "nomatch"})
                return "nomatch"

            track_id = hit["id"]
            with state:
                track = tracks.get(track_id)
            if track is None:
                kind, body = get(f"/track/{track_id}")
                if kind != "found":
                    status = "failed" if kind == "failed" else "nomatch"
                    write("matches", {"i": i, "status": status})
                    return status
                track = slim_track(body)
                with state:
                    tracks[track_id] = track
                write("tracks", track)

            # Two workers can ask about the same album at once; the second answer
            # is a duplicate line, and the loader keeps the last, so it is harmless
            for store, name, path, slim, ident in (
                (albums, "albums", "/album/{}", slim_album, (track.get("album") or {}).get("id")),
                (artists, "artists", "/artist/{}", slim_artist, (track.get("artist") or {}).get("id")),
            ):
                if ident is None:
                    continue
                with state:
                    known = ident in store
                if known:
                    continue
                kind, body = get(path.format(ident))
                if kind == "failed":
                    write("matches", {"i": i, "status": "failed"})
                    return "failed"
                record = slim(body) if kind == "found" else {"id": ident, "missing": True}
                with state:
                    store[ident] = record
                write(name, record)

            write("matches", {"i": i, "status": "found", "track": track_id})
            return "found"
        except Exception as ex:
            print(f"  track {i} failed: {ex!r}", flush=True)
            write("matches", {"i": i, "status": "failed"})
            return "failed"

    todo = [i for i in range(len(spellings)) if matches.get(i, {}).get("status") in (None, "failed")]
    print(f"{len(spellings):,} tracks, {len(spellings) - len(todo):,} already settled, {len(todo):,} to go,"
          f" {WORKERS} workers", flush=True)

    started, tally = time.monotonic(), {"found": 0, "nomatch": 0, "failed": 0}

    with ThreadPoolExecutor(WORKERS) as pool:
        for done, status in enumerate(pool.map(settle, todo), 1):
            tally[status] += 1
            if done % 500 == 0:
                rate = done / (time.monotonic() - started)
                print(f"  {done:,}/{len(todo):,}  {tally}  {rate:.1f}/s,"
                      f" about {(len(todo) - done) / rate / 60:.0f} min left", flush=True)

    for fh in out.values():
        fh.close()
    print(f"done: {tally}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(int(sys.argv[1]))
