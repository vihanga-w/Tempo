/**
 * A song, described by what it is.
 *
 * The metadata half of the song vector: what Deezer knows about a track, its
 * album and its artist, and the fixed-length vector built from that. It is a
 * port of research/song-vector/songvec.py, which stays the reference — the
 * dimensions, their order and every constant here are that file's, and
 * song-features.test.ts checks the two agree on the same inputs.
 *
 * Nothing here may depend on who listened. Play counts, skips and session
 * lengths belong to a listener, and a vector that carried them could not be
 * compared between people or built for a song nobody has played yet.
 *
 * What is stored is the raw fields, never only the vector. The vector depends
 * on a vocabulary and on constants frozen from a corpus (see VectorContext), and
 * when those change every song has to be described again — from what was
 * already fetched, not by asking Deezer about every song a second time.
 */

/** The answer to asking a catalogue about something. */
export type Lookup<T> =
    | { kind: "found"; value: T }
    /** The catalogue answered and has nothing. For a new release, usually "not yet". */
    | { kind: "missing" }
    /** No answer at all: a timeout, a quota, a 5xx. Worth asking again soon. */
    | { kind: "failed" };

/**
 * The parts of a Deezer track the vector reads.
 *
 * Under Deezer's own names, so the port reads line for line against songvec.py.
 * Contributors are only ever counted, so only the count is kept.
 */
export interface DeezerTrackFields {
    id: number;
    isrc: string | null;
    /** Seconds. */
    duration: number;
    /** Deezer's popularity score. Zero when it has none. */
    rank: number;
    release_date: string | null;
    explicit_lyrics: boolean | null;
    explicit_content_lyrics: number | null;
    /** Loudness in dB. Zero is a real reading, so absence is null, not 0. */
    gain: number | null;
    /** Deezer reports 0 for almost every track, so 0 means absent. */
    bpm: number | null;
    contributor_count: number;
    album_id: number | null;
    artist_id: number | null;
}

export interface DeezerAlbumFields {
    id: number;
    genres: string[];
    release_date: string | null;
}

export interface DeezerArtistFields {
    id: number;
    /** Zero when Deezer has none. */
    nb_fan: number;
}

export interface SongFeatures {
    track: DeezerTrackFields;
    /** Null when the album could not be read; the vector then falls back to the track. */
    album: DeezerAlbumFields | null;
    artist: DeezerArtistFields | null;
}

const num = (value: unknown): number | null =>
    (typeof value === "number" && Number.isFinite(value)) ? value : null;

const str = (value: unknown): string | null =>
    (typeof value === "string" && value.length > 0) ? value : null;

export function isValidIsrc(isrc: unknown): isrc is string {
    return typeof isrc === "string" && /^[A-Za-z0-9]{12}$/.test(isrc);
}

/**
 * How far apart Spotify's and Deezer's lengths for one recording may be.
 *
 * The same master comes back within a second or two on both, and Deezer only
 * counts whole seconds, so five is generous for a real match and still tight
 * enough to catch a wrong one.
 */
export const DURATION_TOLERANCE_MS = 5000;

/**
 * Whether a Deezer track found by ISRC is plausibly the Spotify track it was
 * looked up for.
 *
 * An ISRC is meant to name exactly one recording, and mostly does, but some
 * distributors fill the field with a placeholder — ZZZZZ9999999 is a real,
 * unrelated track on Deezer — so a Spotify song carrying one would be described
 * as whatever Deezer happens to file under it. A wrong match is worse than
 * none: it puts a stranger's genre, era and popularity into the song's vector
 * with nothing to show they are not its own. Length is on both sides and costs
 * nothing to compare.
 *
 * With either length unknown there is nothing to compare, and the match stands.
 */
export function durationsAgree(deezerSeconds: number, spotifyMs: number | null | undefined): boolean {
    if (!spotifyMs || !deezerSeconds)
        return true;

    return Math.abs(deezerSeconds * 1000 - spotifyMs) <= DURATION_TOLERANCE_MS;
}

export function parseDeezerTrack(body: unknown): DeezerTrackFields | null {
    const track = body as any;
    const id = num(track?.id);

    if (id === null)
        return null;

    return {
        id,
        isrc: str(track.isrc),
        duration: num(track.duration) ?? 0,
        rank: num(track.rank) ?? 0,
        release_date: str(track.release_date),
        explicit_lyrics: (typeof track.explicit_lyrics === "boolean") ? track.explicit_lyrics : null,
        explicit_content_lyrics: num(track.explicit_content_lyrics),
        gain: num(track.gain),
        bpm: num(track.bpm),
        contributor_count: Array.isArray(track.contributors) ? track.contributors.length : 0,
        album_id: num(track.album?.id),
        artist_id: num(track.artist?.id),
    };
}

export function parseDeezerAlbum(body: unknown): DeezerAlbumFields | null {
    const album = body as any;
    const id = num(album?.id);

    if (id === null)
        return null;

    const genres = Array.isArray(album.genres?.data)
        ? album.genres.data.map((g: any) => g?.name).filter((n: unknown): n is string => typeof n === "string")
        : [];

    return { id, genres, release_date: str(album.release_date) };
}

export function parseDeezerArtist(body: unknown): DeezerArtistFields | null {
    const artist = body as any;
    const id = num(artist?.id);

    if (id === null)
        return null;

    return { id, nb_fan: num(artist.nb_fan) ?? 0 };
}

// --- the vector ---------------------------------------------------------------

/**
 * The genre vocabulary, exactly as committed in research/song-vector/genre-vocab.json.
 *
 * Written out rather than read at runtime so the image does not depend on the
 * research directory, and pinned by a test against that file: a vector is only
 * comparable to another built against the same list, so this must never drift.
 */
export const GENRE_VOCABULARY: readonly string[] = [
    "Rap/Hip Hop", "Pop", "Alternative", "R&B", "Dance", "Rock", "Electro", "Country",
    "Indie Pop", "Indie Rock", "Films/Games", "Film Scores", "Singer & Songwriter",
    "Techno/House", "Latin Music", "International Pop", "Reggae", "Folk",
    "Indie Rock/Rock Pop", "Contemporary R&B", "African Music", "Soul & Funk",
    "Dancehall/Ragga", "Indie Pop/Folk", "Asian Music", "Christian",
];

/** The year the research measured age from. A model version fixes its own. */
export const REFERENCE_NOW_YEAR = 2026;

/**
 * Everything the vector needs besides the song.
 *
 * Two of these are measured on a corpus rather than written down: rank is a
 * percentile against the corpus's ranks, and fans are scaled by its largest
 * fan count. Recomputed as the catalogue grows, they would quietly change what
 * every stored vector means, so they are frozen alongside the model that was
 * trained against them, like the vocabulary.
 */
export interface VectorContext {
    vocabulary: readonly string[];
    nowYear: number;
    /** log1p of every rank in the corpus, ascending. */
    rankTable: readonly number[];
    /** log1p of the largest fan count in the corpus. */
    maxFansLog: number;
}

/** The dimension names, in order. songvec.py's `_dims()`. */
export function dimensionNames(vocabulary: readonly string[] = GENRE_VOCABULARY): string[] {
    return [
        ...vocabulary.map(g => `genre:${g}`),
        "genre:other", "genre:present",
        "age_log", "release_month_sin", "release_month_cos", "release_present",
        "rank_pct", "fans_log", "artist_present",
        "duration_log", "duration_short", "duration_long",
        "explicit", "explicit_present",
        "contributors_log", "featured",
        "gain", "gain_present",
        "bpm", "bpm_present",
    ];
}

/** Built the way SongVectors.__init__ builds it, from a corpus of ranks and fan counts. */
export function contextFromCorpus(
    corpus: { ranks: number[]; fans: number[] },
    vocabulary: readonly string[] = GENRE_VOCABULARY,
    nowYear = REFERENCE_NOW_YEAR,
): VectorContext {
    const rankTable = corpus.ranks
        .filter(rank => !!rank)
        .map(rank => Math.log1p(rank))
        .sort((a, b) => a - b);

    // A reduce rather than Math.max(...fans), which runs out of stack on a big corpus
    const maxFans = corpus.fans.reduce((max, fans) => (fans && fans > max) ? fans : max, 0);

    return {
        vocabulary,
        nowYear,
        rankTable,
        maxFansLog: maxFans > 0 ? Math.log1p(maxFans) : 1.0,
    };
}

/** Python's int() on a string: digits with an optional sign, surrounding space allowed. */
function pyInt(text: string): number | null {
    return /^\s*[+-]?\d+\s*$/.test(text) ? parseInt(text, 10) : null;
}

/** numpy's searchsorted, left side: the first index whose value is not below `value`. */
function searchsortedLeft(sorted: readonly number[], value: number): number {
    let lo = 0;
    let hi = sorted.length;

    while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (sorted[mid] < value)
            lo = mid + 1;
        else
            hi = mid;
    }

    return lo;
}

/**
 * The release date the vector uses, as a year and month.
 *
 * The album's date wins whenever it is set at all — including "0000-00-00",
 * which then counts as no date rather than falling through to the track's. And
 * a year on its own is no date either: songvec.py reads the month with int(),
 * which fails on an empty string and drops the whole era block. Both are kept,
 * because the model was trained on exactly that behaviour.
 */
function releaseOf(features: SongFeatures): { year: number; month: number } | null {
    const date = features.album?.release_date || features.track.release_date;

    if (!date || date === "0000-00-00")
        return null;

    const year = pyInt(date.slice(0, 4));
    const month = pyInt(date.slice(5, 7));

    return (year === null || month === null) ? null : { year, month };
}

/**
 * The song vector. songvec.py's `SongVectors.vector`, line for line.
 *
 * Presence bits sit beside every sparse value, because a missing reading
 * imputed as zero is otherwise indistinguishable from a real one. Two quirks
 * are reproduced on purpose rather than tidied: `explicit_content_lyrics / 4`
 * treats Deezer's enum as a scale, and rank has no presence bit, so a missing
 * rank reads as maximally obscure. Changing either is a new model version.
 */
export function songVector(features: SongFeatures, context: VectorContext): number[] {
    const { track, album, artist } = features;
    const G = context.vocabulary.length;
    const v = new Array<number>(G + 20).fill(0);

    const at = {
        other: G, present: G + 1,
        age: G + 2, monthSin: G + 3, monthCos: G + 4, releasePresent: G + 5,
        rank: G + 6, fans: G + 7, artistPresent: G + 8,
        durationLog: G + 9, durationShort: G + 10, durationLong: G + 11,
        explicit: G + 12, explicitPresent: G + 13,
        contributors: G + 14, featured: G + 15,
        gain: G + 16, gainPresent: G + 17,
        bpm: G + 18, bpmPresent: G + 19,
    };

    // --- genre, L1-normalised over the fixed vocabulary
    const names = album?.genres ?? [];

    if (names.length > 0) {
        const index = new Map(context.vocabulary.map((g, i) => [g, i] as [string, number]));
        const share = 1.0 / names.length;

        v[at.present] = 1.0;

        for (const name of names)
            v[index.get(name) ?? at.other] += share;
    }

    // --- era
    const release = releaseOf(features);

    if (release) {
        v[at.age] = Math.min(1.0, Math.log1p(Math.max(0, context.nowYear - release.year)) / Math.log1p(70));
        v[at.monthSin] = Math.sin(2 * Math.PI * release.month / 12);
        v[at.monthCos] = Math.cos(2 * Math.PI * release.month / 12);
        v[at.releasePresent] = 1.0;
    }

    // --- how widely known
    if (track.rank)
        v[at.rank] = searchsortedLeft(context.rankTable, Math.log1p(track.rank)) / Math.max(1, context.rankTable.length);

    if (artist && artist.nb_fan) {
        v[at.fans] = Math.log1p(artist.nb_fan) / context.maxFansLog;
        v[at.artistPresent] = 1.0;
    }

    // --- shape of the track itself
    const seconds = track.duration || 0;

    if (seconds) {
        v[at.durationLog] = Math.min(1.0, Math.log1p(seconds) / Math.log1p(600));
        v[at.durationShort] = seconds < 120 ? 1.0 : 0.0;
        v[at.durationLong] = seconds > 330 ? 1.0 : 0.0;
    }

    if (track.explicit_content_lyrics !== null) {
        v[at.explicit] = Math.min(1.0, track.explicit_content_lyrics / 4);
        v[at.explicitPresent] = 1.0;
    } else if (track.explicit_lyrics !== null) {
        v[at.explicit] = track.explicit_lyrics ? 1.0 : 0.0;
        v[at.explicitPresent] = 1.0;
    }

    if (track.contributor_count) {
        v[at.contributors] = Math.min(1.0, Math.log1p(track.contributor_count) / Math.log1p(8));
        v[at.featured] = track.contributor_count > 1 ? 1.0 : 0.0;
    }

    // 0 dB is a real gain, so presence is "not null", not "truthy"
    if (track.gain !== null) {
        v[at.gain] = Math.min(1.0, Math.max(0.0, (track.gain + 20) / 20));
        v[at.gainPresent] = 1.0;
    }

    if (track.bpm) {
        v[at.bpm] = Math.min(1.0, Math.max(0.0, (track.bpm - 60) / 140));
        v[at.bpmPresent] = 1.0;
    }

    return v;
}

// --- what is still missing ----------------------------------------------------

/** A part of the description that is missing now but could arrive later. */
export type FeatureGap = "track" | "genre" | "release" | "fans" | "rank" | "gain";

/**
 * What is worth asking Deezer about again.
 *
 * A brand-new release is often thinner than it will be in a week: the album
 * not yet filed under a genre, the artist's page not yet counting fans, the
 * track not yet ranked or measured for loudness, or the ISRC not matched at all.
 * Each of those fills in by itself, so each one keeps the song on the retry
 * schedule until it does.
 *
 * BPM is deliberately not a gap. Deezer reports 0 for nearly everything, old
 * releases included, so waiting for it would retry every song for ever; the
 * vector carries a presence bit for it and does without. Duration, explicitness
 * and credits arrive with the track itself, so a found track already has them.
 */
export function gapsIn(features: SongFeatures | null): FeatureGap[] {
    if (!features)
        return ["track"];

    const gaps: FeatureGap[] = [];

    if (!features.album || features.album.genres.length === 0)
        gaps.push("genre");

    if (!releaseOf(features))
        gaps.push("release");

    if (!features.artist || !features.artist.nb_fan)
        gaps.push("fans");

    if (!features.track.rank)
        gaps.push("rank");

    if (features.track.gain === null)
        gaps.push("gain");

    return gaps;
}
