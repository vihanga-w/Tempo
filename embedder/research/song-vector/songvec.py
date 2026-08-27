"""
A fixed-length vector for a song, built only from what the song is.

Nothing here may depend on who listened to it. That rules out play counts,
skip rates, session durations and everything else Tempo records — those belong
to the listener, not the track, and a song vector that carries them cannot be
compared between users or computed for a song nobody has played yet.

What is allowed is what the track carries on its own: who made it, when, how
long it is, how widely known it is, what the album was filed under. Global
popularity counts as a property of the song rather than of any listener, so
Deezer's rank and fan counts are in.

Sparse fields carry a presence bit beside the value. Without one, a missing
BPM imputed as zero is indistinguishable from a real 60 BPM track and the model
learns a relationship that is not there.

The bits earn their place twice over. Averaged across the songs one person
plays they stop being a repair for missing data and become a description of the
listener: somebody whose music the catalogues barely cover is not the same
listener as somebody whose music they cover completely, and that is worth
knowing about them whatever the missing values would have been. So nothing
downstream may drop or renormalise them away.
"""
import json, math
import numpy as np

SCRATCH = "."

# --- the genre vocabulary ----------------------------------------------------
#
# Fixed length means a fixed list of genres, but the list has to come from the
# catalogue rather than from a guess. Written by hand it missed five of the
# thirteen names in a forty-album sample — Indie Pop, Indie Rock, Techno/House,
# Singer & Songwriter, Film Scores — and those are precisely the labels that
# separate one listener from another; collapsing them into "other" throws away
# the resolution the block exists for.
#
# So it is learned from the albums once and written to disk. Kept on disk
# because a vector is only comparable to another vector built against the same
# vocabulary: regenerating it silently would reinterpret every stored embedding.

VOCAB_SIZE = 26
VOCAB_FILE = "genre-vocab.json"


def build_vocabulary(albums, path=VOCAB_FILE, size=VOCAB_SIZE):
    from collections import Counter

    counts = Counter()
    for album in albums.values():
        if not album:
            continue
        for g in (album.get("genres") or {}).get("data", []):
            counts[g["name"]] += 1

    vocab = [name for name, _ in counts.most_common(size)]
    json.dump({"genres": vocab, "counts": dict(counts)}, open(path, "w"), indent=1)
    return vocab


def load_vocabulary(path=VOCAB_FILE):
    return json.load(open(path))["genres"]


GENRES = []
GENRE_INDEX = {}


def _set_vocabulary(vocab):
    global GENRES, GENRE_INDEX, DIMS
    GENRES = list(vocab)
    GENRE_INDEX = {g: i for i, g in enumerate(GENRES)}
    DIMS[:] = _dims(GENRES)

def _dims(genres):
    return (
    [f"genre:{g}" for g in genres]
    + ["genre:other", "genre:present"]
    + ["age_log", "release_month_sin", "release_month_cos", "release_present"]
    + ["rank_pct", "fans_log", "artist_present"]
    + ["duration_log", "duration_short", "duration_long"]
    + ["explicit", "explicit_present"]
    + ["contributors_log", "featured"]
    + ["gain", "gain_present"]
    + ["bpm", "bpm_present"]
    )


DIMS = _dims([])

NOW_YEAR = 2026


def _percentiles(values):
    """Rank percentile, since Deezer's rank is heavily skewed."""
    order = sorted(values)
    return lambda v: (np.searchsorted(order, v) / max(1, len(order)))


class SongVectors:
    def __init__(self, deezer, albums, artists, catalogue=None):
        self.deezer = deezer
        self.albums = albums
        self.artists = artists

        ranks = [t["rank"] for t in deezer.values() if t and t.get("rank")]
        if catalogue:
            ranks += [t["rank"] for v in catalogue.values() for t in v if t.get("rank")]
        self._rank_pct = _percentiles([math.log1p(r) for r in ranks])

        fans = [a["nb_fan"] for a in artists.values() if a and a.get("nb_fan")]
        self._max_fans = math.log1p(max(fans)) if fans else 1.0

    def genre_names(self, track):
        album = self.albums.get(str((track.get("album") or {}).get("id")))
        if not album:
            return []
        return [g["name"] for g in (album.get("genres") or {}).get("data", [])]

    def vector(self, track):
        v = np.zeros(len(DIMS), dtype=np.float32)
        at = {name: i for i, name in enumerate(DIMS)}

        # --- genre, L1-normalised over the fixed vocabulary
        names = self.genre_names(track)
        if names:
            v[at["genre:present"]] = 1.0
            share = 1.0 / len(names)
            for name in names:
                if name in GENRE_INDEX:
                    v[GENRE_INDEX[name]] += share
                else:
                    v[at["genre:other"]] += share

        # --- era
        album = self.albums.get(str((track.get("album") or {}).get("id")))
        date = (album or {}).get("release_date") or track.get("release_date")
        if date and date != "0000-00-00":
            try:
                year, month = int(date[:4]), int(date[5:7])
                v[at["age_log"]] = min(1.0, math.log1p(max(0, NOW_YEAR - year)) / math.log1p(70))
                v[at["release_month_sin"]] = math.sin(2 * math.pi * month / 12)
                v[at["release_month_cos"]] = math.cos(2 * math.pi * month / 12)
                v[at["release_present"]] = 1.0
            except ValueError:
                pass

        # --- how widely known
        if track.get("rank"):
            v[at["rank_pct"]] = float(self._rank_pct(math.log1p(track["rank"])))
        artist = self.artists.get(str((track.get("artist") or {}).get("id")))
        if artist and artist.get("nb_fan"):
            v[at["fans_log"]] = math.log1p(artist["nb_fan"]) / self._max_fans
            v[at["artist_present"]] = 1.0

        # --- shape of the track itself
        seconds = track.get("duration") or 0
        if seconds:
            v[at["duration_log"]] = min(1.0, math.log1p(seconds) / math.log1p(600))
            v[at["duration_short"]] = 1.0 if seconds < 120 else 0.0
            v[at["duration_long"]] = 1.0 if seconds > 330 else 0.0

        if track.get("explicit_content_lyrics") is not None:
            v[at["explicit"]] = min(1.0, track["explicit_content_lyrics"] / 4)
            v[at["explicit_present"]] = 1.0
        elif track.get("explicit_lyrics") is not None:
            v[at["explicit"]] = 1.0 if track["explicit_lyrics"] else 0.0
            v[at["explicit_present"]] = 1.0

        contributors = track.get("contributors") or []
        if contributors:
            v[at["contributors_log"]] = min(1.0, math.log1p(len(contributors)) / math.log1p(8))
            v[at["featured"]] = 1.0 if len(contributors) > 1 else 0.0

        if track.get("gain") is not None and track["gain"] != 0:
            v[at["gain"]] = min(1.0, max(0.0, (track["gain"] + 20) / 20))
            v[at["gain_present"]] = 1.0

        if track.get("bpm"):
            v[at["bpm"]] = min(1.0, max(0.0, (track["bpm"] - 60) / 140))
            v[at["bpm_present"]] = 1.0

        return v


def load(scratch=SCRATCH, rebuild_vocabulary=False):
    import os

    deezer = json.load(open(f"{scratch}/group-deezer.json"))
    deezer = {k: v for k, v in deezer.items() if v}
    albums = {k: v for k, v in json.load(open(f"{scratch}/albums.json")).items() if v}
    artists = {k: v for k, v in json.load(open(f"{scratch}/artists.json")).items() if v}
    catalogue = json.load(open(f"{scratch}/artist-catalogues.json"))

    path = f"{scratch}/{VOCAB_FILE}"

    if rebuild_vocabulary or not os.path.exists(path):
        _set_vocabulary(build_vocabulary(albums, path))
    else:
        _set_vocabulary(load_vocabulary(path))

    return SongVectors(deezer, albums, artists, catalogue), deezer, catalogue


if __name__ == "__main__":
    sv, deezer, _ = load()
    print(f"{len(DIMS)} dimensions")
    mat = np.stack([sv.vector(t) for t in deezer.values()])
    nonzero = (mat != 0).mean(axis=0)
    print(f"{'dimension':22}{'non-zero':>10}{'mean':>8}{'sd':>8}")
    for name, nz, m, s in zip(DIMS, nonzero, mat.mean(axis=0), mat.std(axis=0)):
        if nz > 0.001:
            print(f"{name:22}{nz*100:9.1f}%{m:8.3f}{s:8.3f}")
    dead = [n for n, nz in zip(DIMS, nonzero) if nz <= 0.001]
    print(f"\nnever populated: {dead}")
