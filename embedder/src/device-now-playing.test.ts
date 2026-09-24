import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    HEARTBEAT_GRACE_MS,
    NowPlayingReport,
    Observation,
    liveUntil,
    parseLibraryPlays,
    parseNowPlayingReport,
    endedObservations,
    isNewFromDevice,
    takesOverDisplay,
    timingsFromObservations,
    withLibraryPlays,
    withReport,
} from "./device-now-playing";

const NOW = 1_800_000_000_000;
const MIN = 60e3;

function report(overrides: Partial<NowPlayingReport> & { catalogId?: string; durationMs?: number } = {}): NowPlayingReport {
    const { catalogId = "123", durationMs = 4 * MIN, ...rest } = overrides;

    return {
        deviceId: "device-0001",
        seq: 1,
        observedAt: NOW,
        state: "playing",
        appState: "foreground",
        track: { catalogId, title: "A Song", artist: "An Artist", album: "An Album", durationMs },
        positionMs: 0,
        ...rest,
    };
}

describe("parseNowPlayingReport", () => {
    const body = {
        deviceId: "device-0001",
        seq: 3,
        observedAt: NOW - 1000,
        state: "playing",
        appState: "background",
        track: { catalogId: "123", title: "A Song", artist: "An Artist", album: "An Album", durationMs: 200e3 },
        positionMs: 5000,
    };

    it("reads a report", () => {
        assert.deepEqual(parseNowPlayingReport(body, NOW), { ...body, observedAt: NOW });
    });

    it("times it by the server's clock, whatever the device's says", () => {
        // A phone two minutes slow would otherwise be stale on arrival
        assert.equal(parseNowPlayingReport({ ...body, observedAt: NOW - 2 * MIN }, NOW)?.observedAt, NOW);
        assert.equal(parseNowPlayingReport({ ...body, observedAt: NOW + 4 * MIN }, NOW)?.observedAt, NOW);
    });

    it("keeps a library-only song, but without a catalog id", () => {
        const parsed = parseNowPlayingReport({ ...body, track: { ...body.track, catalogId: "0" } }, NOW);

        assert.equal(parsed?.track?.catalogId, undefined);
        assert.equal(parsed?.track?.title, "A Song");
    });

    it("counts nothing loaded as stopped", () => {
        assert.equal(parseNowPlayingReport({ ...body, track: undefined }, NOW)?.state, "stopped");
    });

    it("refuses what is not a report", () => {
        for (const bad of [null, "x", { ...body, deviceId: "../x" }, { ...body, seq: -1 }, { ...body, seq: 1.5 }, { ...body, state: "rewinding" }, { ...body, track: { title: 5 } }])
            assert.equal(parseNowPlayingReport(bad, NOW), undefined, JSON.stringify(bad));
    });

    it("reads Tempo stopping watching, which is not the player stopping", () => {
        assert.equal(parseNowPlayingReport({ ...body, untracked: true }, NOW)?.untracked, true);
        assert.equal(parseNowPlayingReport({ ...body, untracked: "yes" }, NOW)?.untracked, undefined);
    });

    it("keeps the position within the song", () => {
        assert.equal(parseNowPlayingReport({ ...body, positionMs: 999e3 }, NOW)?.positionMs, 200e3);
    });
});

describe("isNewFromDevice", () => {
    it("takes only a later report from the device", () => {
        assert.equal(isNewFromDevice(5, report({ seq: 6 })), true);
        assert.equal(isNewFromDevice(5, report({ seq: 5 })), false);
        assert.equal(isNewFromDevice(5, report({ seq: 4 })), false);
        assert.equal(isNewFromDevice(undefined, report({ seq: 1 })), true);
    });
});

describe("takesOverDisplay", () => {
    const shownPlaying = { report: report({ seq: 5 }), liveUntil: NOW + MIN };
    const ipad = (state: NowPlayingReport["state"]) => report({ deviceId: "device-0002", seq: 1, state });

    it("always shows the device already shown", () => {
        assert.equal(takesOverDisplay(shownPlaying, report({ seq: 6, state: "paused" }), NOW), true);
    });

    it("does not let another device's paused song replace one playing", () => {
        assert.equal(takesOverDisplay(shownPlaying, ipad("paused"), NOW), false);
        assert.equal(takesOverDisplay(shownPlaying, ipad("stopped"), NOW), false);
    });

    it("lets another device take over by playing", () => {
        assert.equal(takesOverDisplay(shownPlaying, ipad("playing"), NOW), true);
    });

    it("lets another device take over once nothing live is playing", () => {
        assert.equal(takesOverDisplay({ ...shownPlaying, liveUntil: NOW - 1 }, ipad("paused"), NOW), true);
        assert.equal(takesOverDisplay(undefined, ipad("paused"), NOW), true);
    });
});

describe("liveUntil", () => {
    it("believes a playing report until the next heartbeat is well overdue", () => {
        assert.equal(liveUntil(report({ durationMs: 10 * MIN })), NOW + HEARTBEAT_GRACE_MS);
    });

    it("stops believing it once the song would have ended, which is itself a change", () => {
        assert.equal(liveUntil(report({ durationMs: 4 * MIN, positionMs: 4 * MIN - 5000 })), NOW + 5000 + 30e3);
    });

    it("believes a pause for the same grace", () => {
        assert.equal(liveUntil(report({ state: "paused" })), NOW + HEARTBEAT_GRACE_MS);
    });

    it("does not believe a stop at all", () => {
        assert.equal(liveUntil(report({ state: "stopped" })), NOW);
        assert.equal(liveUntil({ ...report(), track: undefined }), NOW);
    });
});

describe("withReport", () => {
    it("opens an observation for a song starting", () => {
        const [o] = withReport([], report({ positionMs: 2000 }), NOW);

        assert.equal(o.catalogId, "123");
        assert.equal(o.startedAt, NOW - 2000);
        assert.equal(o.closed, false);
    });

    it("extends it while the same song plays", () => {
        let obs = withReport([], report({ positionMs: 0 }), NOW);
        obs = withReport(obs, report({ seq: 2, observedAt: NOW + 30e3, positionMs: 30e3 }), NOW + 30e3);

        assert.equal(obs.length, 1);
        assert.equal(obs[0].reachedMs, 30e3);
        assert.equal(obs[0].lastSeenAt, NOW + 30e3);
    });

    it("closes it when another song starts", () => {
        let obs = withReport([], report(), NOW);
        obs = withReport(obs, report({ seq: 2, observedAt: NOW + 30e3, positionMs: 30e3 }), NOW + 30e3);
        obs = withReport(obs, report({ seq: 3, catalogId: "456", observedAt: NOW + MIN }), NOW + MIN);

        assert.deepEqual(obs.map(o => [o.catalogId, o.closed, o.seenToEnd]), [["123", true, true], ["456", false, false]]);
    });

    it("counts a song as heard up to the report that ended it, not its last heartbeat", () => {
        // A 95 second song, last reported at 64 seconds, followed at 95 by the next
        let obs = withReport([], report({ durationMs: 95e3, positionMs: 64e3 }), NOW);
        obs = withReport(obs, report({ seq: 2, catalogId: "456", observedAt: NOW + 31e3 }), NOW + 31e3);

        assert.equal(obs[0].reachedMs, 95e3);
        assert.equal(obs[0].lastSeenAt, NOW + 31e3);
    });

    it("does not count a song as seen to its end after the app said it was going to the background", () => {
        // iOS may suspend it at once; a report soon after cannot vouch for the gap
        let obs = withReport([], report({ positionMs: 100e3, appState: "background" }), NOW);
        obs = withReport(obs, report({ seq: 2, catalogId: "456", observedAt: NOW + 40e3 }), NOW + 40e3);

        assert.equal(obs[0].seenToEnd, false);
    });

    it("closes a song the player stops on, as seen to its end", () => {
        let obs = withReport([], report({ positionMs: 3 * MIN }), NOW);
        obs = withReport(obs, report({ seq: 2, observedAt: NOW + 30e3, positionMs: 3.5 * MIN, state: "stopped" }), NOW + 30e3);

        assert.deepEqual([obs[0].closed, obs[0].seenToEnd], [true, true]);
    });

    it("does not count a song as ended when Tempo stops watching, since it may play on", () => {
        let obs = withReport([], report({ positionMs: 90e3 }), NOW);
        obs = withReport(obs, { ...report({ seq: 2, observedAt: NOW + 10e3, state: "stopped" }), track: undefined, untracked: true }, NOW + 10e3);

        assert.deepEqual([obs[0].closed, obs[0].seenToEnd], [true, false]);
    });

    it("does not count a song as seen to its end when the device fell silent partway", () => {
        // Tempo suspended 20 s into a four minute song, opened again later
        let obs = withReport([], report({ positionMs: 20e3 }), NOW);
        obs = withReport(obs, report({ seq: 2, catalogId: "456", observedAt: NOW + 5 * MIN }), NOW + 5 * MIN);

        assert.deepEqual([obs[0].closed, obs[0].seenToEnd, obs[0].reachedMs], [true, false, 20e3]);
    });

    it("counts the same song back at its start as a replay", () => {
        let obs = withReport([], report({ positionMs: 3 * MIN }), NOW);
        obs = withReport(obs, report({ seq: 2, observedAt: NOW + MIN, positionMs: 2000 }), NOW + MIN);

        assert.equal(obs.length, 2);
        assert.equal(obs[0].closed, true);
    });

    it("does not start one for a pause, or a song only in the library", () => {
        assert.deepEqual(withReport([], report({ state: "paused" }), NOW), []);
        assert.deepEqual(withReport([], { ...report(), track: { ...report().track!, catalogId: undefined } }, NOW), []);
    });

    it("forgets old observations", () => {
        const old: Observation = { deviceId: "d", catalogId: "1", durationMs: 1, startedAt: 0, lastSeenAt: NOW - 7 * 3600e3, reachedMs: 1, playing: false, closed: true, seenToEnd: true, via: "live" };

        assert.equal(withReport([old], report(), NOW).some(o => o.catalogId === "1"), false);
    });
});

describe("parseLibraryPlays", () => {
    it("keeps what makes sense", () => {
        const plays = parseLibraryPlays({
            items: [
                { catalogId: "123", lastPlayedAt: NOW - MIN, durationMs: 200e3 },
                { catalogId: "0", lastPlayedAt: NOW - MIN },
                { catalogId: "456", lastPlayedAt: NOW + 3600e3 },
                { catalogId: "../x", lastPlayedAt: NOW },
            ],
        }, NOW);

        assert.deepEqual(plays, [{ catalogId: "123", lastPlayedAt: NOW - MIN, durationMs: 200e3 }]);
    });

    it("refuses what is not a list", () => {
        assert.equal(parseLibraryPlays({ items: "x" }, NOW), undefined);
        assert.equal(parseLibraryPlays(null, NOW), undefined);
    });
});

describe("withLibraryPlays", () => {
    it("adds a closed observation ending when the song was last played", () => {
        const [o] = withLibraryPlays([], "device-0001", [{ catalogId: "123", lastPlayedAt: NOW - MIN, durationMs: 200e3 }], NOW);

        assert.deepEqual(
            [o.lastSeenAt, o.startedAt, o.closed, o.via],
            [NOW - MIN, NOW - MIN - 200e3, true, "library"],
        );
    });

    it("does not add a play already seen live", () => {
        const live = withReport([], report({ observedAt: NOW - MIN, positionMs: 0 }), NOW - MIN);
        const obs = withLibraryPlays(live, "device-0001", [{ catalogId: "123", lastPlayedAt: NOW - 30e3, durationMs: 4 * MIN }], NOW);

        assert.equal(obs.length, 1);
    });
});

describe("timingsFromObservations", () => {
    function observed(catalogId: string, lastSeenAt: number, reachedMs = 4 * MIN, closed = true, seenToEnd = closed): Observation {
        return { deviceId: "d", catalogId, durationMs: 4 * MIN, startedAt: lastSeenAt - reachedMs, lastSeenAt, reachedMs, playing: !closed, closed, seenToEnd, via: "live" };
    }

    it("gives a play the device saw end its real end, and how much of it was heard", () => {
        const { timings } = timingsFromObservations([{ catalogId: "123" }], [observed("123", NOW - MIN, 1 * MIN)], NOW - 3 * MIN, NOW);

        assert.deepEqual(timings, [{ endedAt: NOW - MIN, fraction: 0.25, exact: true }]);
    });

    it("gives a song still playing no end later than the poll's read, and says nothing of how much was heard", () => {
        // Began a minute ago, four minutes long: its end has not happened yet
        const { timings } = timingsFromObservations([{ catalogId: "123" }], [observed("123", NOW, 1 * MIN, false)], NOW - 3 * MIN, NOW);

        assert.deepEqual(timings, [{ endedAt: NOW, exact: false, openEnded: true }]);
    });

    it("does not take the moment a phone fell silent for the end of the song", () => {
        // Suspended 20 s in; the song may well have played out
        const { timings } = timingsFromObservations([{ catalogId: "123" }], [observed("123", NOW - 3 * MIN, 20e3, true, false)], NOW - 4 * MIN, NOW);

        assert.equal(timings[0]?.exact, false);
        assert.equal(timings[0]?.fraction, undefined);
        assert.equal(timings[0]?.openEnded, true);
        assert.equal(timings[0]?.endedAt, Math.min(NOW, NOW - 3 * MIN - 20e3 + 4 * MIN));
    });

    it("matches newest to newest, and uses each observation once", () => {
        const { timings, observations } = timingsFromObservations(
            [{ catalogId: "123" }, { catalogId: "123" }],
            [observed("123", NOW - 5 * MIN), observed("123", NOW - MIN)],
            NOW - 10 * MIN,
            NOW,
        );

        assert.deepEqual(timings.map(t => t?.endedAt), [NOW - MIN, NOW - 5 * MIN]);
        assert.ok(observations.every(o => o.used));
    });

    it("leaves a play the device did not see to the poll's timing", () => {
        const { timings } = timingsFromObservations([{ catalogId: "999" }, { catalogId: undefined }], [observed("123", NOW)], NOW - 3 * MIN, NOW);

        assert.deepEqual(timings, [undefined, undefined]);
    });

    it("does not reuse an observation of a play the poll already had", () => {
        const { timings } = timingsFromObservations([{ catalogId: "123" }], [observed("123", NOW - 30 * MIN)], NOW - 3 * MIN, NOW);

        assert.deepEqual(timings, [undefined]);
    });

    it("does not change the observations it was given", () => {
        const given = [observed("123", NOW)];

        timingsFromObservations([{ catalogId: "123" }], given, undefined, NOW);

        assert.equal(given[0].used, undefined);
    });
});

describe("endedObservations", () => {
    it("finds a play timed while still going that the phone has now seen end", () => {
        let obs = withReport([], report({ positionMs: 0 }), NOW);
        const timed = timingsFromObservations([{ catalogId: "123" }], obs, NOW - 3 * MIN, NOW).observations;
        const after = withReport(timed, report({ seq: 2, catalogId: "456", observedAt: NOW + 20e3 }), NOW + 20e3);

        const ended = endedObservations(timed, after);

        assert.equal(ended.length, 1);
        assert.equal(ended[0].reachedMs, 20e3);
    });

    it("finds nothing for one nobody used, or that was already closed", () => {
        const obs = withReport([], report({ positionMs: 0 }), NOW);
        const after = withReport(obs, report({ seq: 2, catalogId: "456", observedAt: NOW + 20e3 }), NOW + 20e3);

        assert.deepEqual(endedObservations(obs, after), []);
        assert.deepEqual(endedObservations(after, after), []);
    });
});
