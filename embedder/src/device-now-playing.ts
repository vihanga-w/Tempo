/**
 * What the Tempo app on somebody's phone says the Music app is playing.
 *
 * The Apple Music API has no "now playing". The phone does: while Tempo is
 * open, or has only just gone to the background, the app watches the system
 * music player and reports every change straight to the server, and repeats
 * itself every half minute while music plays. That is a heartbeat, and it
 * stops the moment iOS suspends the app — so a report is believed only for as
 * long as the next one should have arrived by, and after that the listener is
 * "recently played" from the three-minute poll again, not a frozen "now".
 *
 * What the phone saw is kept a while as observations, too: when a song began
 * and how far it got. The poll is still what records plays — it misses
 * nothing, the phone misses whatever happened while it was not running — but
 * a play the phone saw takes the phone's times, which are real, instead of
 * ones worked out from when the poll noticed.
 */

export type DevicePlaybackState = "playing" | "paused" | "stopped";

export interface NowPlayingReport {
    /** One install of the app. Reports from different devices are told apart by it. */
    deviceId: string;
    /** Counts up per device, so a report that arrives late is not taken for the latest. */
    seq: number;
    /** When the device read the player, by its own clock. */
    observedAt: number;
    state: DevicePlaybackState;
    /** Whether the app was in front when it read, or on its way out. */
    appState: "foreground" | "background";
    /** Absent when nothing is loaded in the player. */
    track?: {
        /** The Apple Music catalog id; absent for a song only in the library, which cannot be a Tempo song. */
        catalogId?: string;
        title: string;
        artist: string;
        album: string;
        durationMs: number;
    };
    positionMs: number;
}

/** How long past its own time a report is believed if nothing follows it. */
export const HEARTBEAT_GRACE_MS = 90e3;

/** How far a device's clock may be from the server's before its times are not used. */
const CLOCK_SKEW_LIMIT_MS = 5 * 60e3;

function isString(value: unknown, max: number): value is string {
    return typeof value === "string" && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/**
 * A report as sent, checked, or undefined when it is not one.
 *
 * The device's clock is trusted only while it agrees with the server's to
 * within a few minutes; past that, the server's time is used instead, since a
 * phone set to the wrong day would otherwise put plays there.
 */
export function parseNowPlayingReport(body: unknown, now: number): NowPlayingReport | undefined {
    if (typeof body !== "object" || body === null)
        return undefined;

    const b = body as Record<string, any>;

    if (!isString(b.deviceId, 128) || !/^[A-Za-z0-9-]{8,128}$/.test(b.deviceId))
        return undefined;

    if (!isFiniteNumber(b.seq) || b.seq < 0 || !Number.isInteger(b.seq))
        return undefined;

    if (b.state !== "playing" && b.state !== "paused" && b.state !== "stopped")
        return undefined;

    const appState = (b.appState === "background" ? "background" : "foreground");
    const observedAt = (isFiniteNumber(b.observedAt) && Math.abs(b.observedAt - now) <= CLOCK_SKEW_LIMIT_MS ? b.observedAt : now);
    const positionMs = (isFiniteNumber(b.positionMs) && b.positionMs >= 0 ? b.positionMs : 0);

    let track: NowPlayingReport["track"];

    if (b.track !== undefined && b.track !== null) {
        const t = b.track;

        if (!isString(t.title, 512) || !isString(t.artist ?? "", 512) || !isString(t.album ?? "", 512))
            return undefined;

        const catalogId = (isString(t.catalogId, 20) && /^\d{1,20}$/.test(t.catalogId) && t.catalogId !== "0" ? t.catalogId : undefined);

        track = {
            catalogId,
            title: t.title,
            artist: t.artist ?? "",
            album: t.album ?? "",
            durationMs: (isFiniteNumber(t.durationMs) && t.durationMs > 0 ? t.durationMs : 0),
        };
    }

    return {
        deviceId: b.deviceId,
        seq: b.seq,
        observedAt,
        state: (track ? b.state : "stopped"),
        appState,
        track,
        positionMs: (track && track.durationMs > 0 ? Math.min(positionMs, track.durationMs) : positionMs),
    };
}

/**
 * Whether `report` replaces `latest`.
 *
 * From the same device, only a later one does: requests overtake each other.
 * From another device, whichever read the player last — somebody who picks up
 * their iPad is playing on the iPad now.
 */
export function supersedes(latest: NowPlayingReport | undefined, report: NowPlayingReport): boolean {
    if (!latest)
        return true;

    if (latest.deviceId === report.deviceId)
        return report.seq > latest.seq;

    return report.observedAt >= latest.observedAt;
}

/**
 * Until when a report is believed without another.
 *
 * Playing: the next heartbeat is due within half a minute, so a report goes
 * stale after HEARTBEAT_GRACE_MS — or sooner, once the song would have ended,
 * since a song ending is itself a change the device would have reported.
 * Paused: the same grace; a paused player is still somebody listening. Stopped
 * or empty: not at all.
 */
export function liveUntil(report: NowPlayingReport): number {
    if (report.state === "stopped" || !report.track)
        return report.observedAt;

    const grace = report.observedAt + HEARTBEAT_GRACE_MS;

    if (report.state !== "playing" || report.track.durationMs <= 0)
        return grace;

    const songEnds = report.observedAt + Math.max(0, report.track.durationMs - report.positionMs) + 30e3;

    return Math.min(grace, songEnds);
}

/**
 * A song the device saw playing: when it began, and how far it got.
 *
 * Built up from report after report, and closed when the device reports
 * something else. An open one is the song playing now, or the last one before
 * the device went quiet.
 */
export interface Observation {
    deviceId: string;
    catalogId: string;
    durationMs: number;
    startedAt: number;
    lastSeenAt: number;
    /** The furthest into the song any report put it. */
    reachedMs: number;
    closed: boolean;
    /** Set once a play recorded from the poll has taken this one's times. */
    used?: boolean;
    /** Where it came from: live reports, or the device's library counts. */
    via: "live" | "library";
}

/** How many observations are kept per listener. */
const OBSERVATIONS_KEPT = 60;

/** How long observations are kept: comfortably longer than any gap between poll reads. */
export const OBSERVATION_LIFETIME_MS = 6 * 3600e3;

/**
 * The observations with `report` taken into account.
 *
 * A report of the song an open observation is about extends it; one of a
 * different song, or of the same song back near its start after being well
 * into it (a replay), closes it and opens another.
 */
export function withReport(observations: Observation[], report: NowPlayingReport, now: number): Observation[] {
    const kept = observations.filter(o => now - o.lastSeenAt <= OBSERVATION_LIFETIME_MS);
    const openIndex = kept.findIndex(o => o.deviceId === report.deviceId && !o.closed && o.via === "live");
    const open = (openIndex >= 0 ? kept[openIndex] : undefined);
    const catalogId = report.track?.catalogId;

    const replayed = (open && catalogId === open.catalogId
        && report.positionMs + 10e3 < open.reachedMs && report.positionMs < 30e3);

    if (open && catalogId === open.catalogId && !replayed) {
        kept[openIndex] = {
            ...open,
            lastSeenAt: Math.max(open.lastSeenAt, report.observedAt),
            reachedMs: Math.max(open.reachedMs, report.positionMs),
        };

        return kept;
    }

    if (open)
        kept[openIndex] = { ...open, closed: true };

    // Only a playing catalog song begins an observation: a paused one may
    // never be played, and a library-only one is never a Tempo song
    if (!catalogId || report.state !== "playing" || !report.track)
        return kept.slice(-OBSERVATIONS_KEPT);

    kept.push({
        deviceId: report.deviceId,
        catalogId,
        durationMs: report.track.durationMs,
        startedAt: report.observedAt - report.positionMs,
        lastSeenAt: report.observedAt,
        reachedMs: report.positionMs,
        closed: false,
        via: "live",
    });

    return kept.slice(-OBSERVATIONS_KEPT);
}

/** A library song the device found played since it last looked. */
export interface LibraryPlay {
    catalogId: string;
    /** The library's "last played" for it: when its most recent play was. */
    lastPlayedAt: number;
    durationMs: number;
}

/**
 * Checks a library report as sent, keeping what makes sense of it.
 */
export function parseLibraryPlays(body: unknown, now: number): LibraryPlay[] | undefined {
    const items = (body as { items?: unknown })?.items;

    if (!Array.isArray(items) || items.length > 500)
        return undefined;

    const plays: LibraryPlay[] = [];

    for (const item of items) {
        const i = item as Record<string, any>;

        if (!isString(i?.catalogId, 20) || !/^\d{1,20}$/.test(i.catalogId) || i.catalogId === "0")
            continue;

        if (!isFiniteNumber(i.lastPlayedAt) || i.lastPlayedAt > now + CLOCK_SKEW_LIMIT_MS || i.lastPlayedAt < now - 30 * 24 * 3600e3)
            continue;

        plays.push({
            catalogId: i.catalogId,
            lastPlayedAt: Math.min(i.lastPlayedAt, now),
            durationMs: (isFiniteNumber(i.durationMs) && i.durationMs > 0 ? i.durationMs : 0),
        });
    }

    return plays;
}

/**
 * The observations with the device's library plays added.
 *
 * The library records when a song was last played, and nothing about how far
 * it got, so each is a closed observation ending then. Whether "last played"
 * marks a play's start or its end is not documented; its end is the likelier
 * reading, and within a song's length either way.
 */
export function withLibraryPlays(observations: Observation[], deviceId: string, plays: LibraryPlay[], now: number): Observation[] {
    const kept = observations.filter(o => now - o.lastSeenAt <= OBSERVATION_LIFETIME_MS);

    for (const play of plays) {
        if (now - play.lastPlayedAt > OBSERVATION_LIFETIME_MS)
            continue;

        // Already seen live, or already reported: the same play
        const known = kept.some(o => o.catalogId === play.catalogId
            && Math.abs(o.lastSeenAt - play.lastPlayedAt) <= Math.max(play.durationMs, 60e3));

        if (known)
            continue;

        kept.push({
            deviceId,
            catalogId: play.catalogId,
            durationMs: play.durationMs,
            startedAt: play.lastPlayedAt - play.durationMs,
            lastSeenAt: play.lastPlayedAt,
            reachedMs: play.durationMs,
            closed: true,
            via: "library",
        });
    }

    return kept.slice(-OBSERVATIONS_KEPT);
}

/** A play's times as the device saw them. */
export interface ObservedTiming {
    endedAt: number;
    /** How much of the song was heard, 0 to 1; only known for a song the device saw end. */
    fraction?: number;
}

/**
 * Takes the device's times for plays the poll has just found, where the
 * device saw them.
 *
 * @param plays the new plays, newest first, by catalog id
 * @param since when the poll last read the list without them
 * @returns for each play, the device's timing, or undefined where it saw none;
 *          and the observations with the ones used marked, so no observation
 *          times two plays
 *
 * Matched newest to newest: the most recent play of a song is the most
 * recent observation of it. An observation from before `since` less its own
 * length is a play the poll already had.
 */
export function timingsFromObservations(
    plays: { catalogId: string | undefined }[],
    observations: Observation[],
    since: number | undefined,
): { timings: (ObservedTiming | undefined)[]; observations: Observation[] } {
    const next = observations.map(o => ({ ...o }));

    const timings = plays.map(play => {
        if (!play.catalogId)
            return undefined;

        let best: Observation | undefined;

        for (const o of next) {
            if (o.used || o.catalogId !== play.catalogId)
                continue;

            if (since !== undefined && o.lastSeenAt < since - Math.max(o.durationMs, 60e3))
                continue;

            if (!best || o.lastSeenAt > best.lastSeenAt)
                best = o;
        }

        if (!best)
            return undefined;

        best.used = true;

        const fraction = (best.via === "live" && best.closed && best.durationMs > 0
            ? Math.min(1, best.reachedMs / best.durationMs)
            : undefined);

        return { endedAt: best.lastSeenAt, fraction };
    });

    return { timings, observations: next };
}
