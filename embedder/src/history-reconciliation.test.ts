import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    alreadyAccountedFor,
    newReconciliationState,
    recordReconciliation,
    recordSongEvent,
    RECONCILE_EVERY_EVENTS,
    RECONCILE_MIN_INTERVAL_MS,
    ReconciliationState,
    shouldReconcile,
} from "./history-reconciliation";

const NOW = 1_700_000_000_000;

/** A user who last had a check long enough ago not to be blocked by the floor. */
function ready(overrides: Partial<ReconciliationState> = {}): ReconciliationState {
    return {
        eventsSinceLastRun: 0,
        lastRunAt: NOW - RECONCILE_MIN_INTERVAL_MS - 1,
        lastImportedPlayedAt: 0,
        ...overrides,
    };
}

/** Plays `count` songs. */
function play(state: ReconciliationState, count: number): ReconciliationState {
    let next = state;

    for (let i = 0; i < count; i++)
        next = recordSongEvent(next);

    return next;
}

describe("recordSongEvent", () => {
    it("counts towards the next check", () => {
        const state = play(newReconciliationState(), 3);

        assert.equal(state.eventsSinceLastRun, 3);
    });

    it("leaves everything else alone", () => {
        const before = ready({ lastImportedPlayedAt: NOW - 1000 });
        const after = recordSongEvent(before);

        assert.equal(after.lastRunAt, before.lastRunAt);
        assert.equal(after.lastImportedPlayedAt, before.lastImportedPlayedAt);
    });
});

describe("shouldReconcile", () => {
    it("does not check an account that cannot read play history", () => {
        const state = play(ready(), 50);

        const decision = shouldReconcile(state, { now: NOW, hasScope: false });

        assert.equal(decision.run, false);
        assert.equal(decision.reason, "no-scope");
    });

    it("does not check before enough songs have played", () => {
        const state = play(ready(), RECONCILE_EVERY_EVENTS - 1);

        const decision = shouldReconcile(state, { now: NOW, hasScope: true });

        assert.equal(decision.run, false);
        assert.equal(decision.reason, "waiting-for-events");
    });

    it("checks once enough songs have played", () => {
        const state = play(ready(), RECONCILE_EVERY_EVENTS);

        const decision = shouldReconcile(state, { now: NOW, hasScope: true });

        assert.equal(decision.run, true);
        assert.equal(decision.reason, "enough-events");
    });

    it("checks straight away on returning from silence", () => {
        const decision = shouldReconcile(ready(), {
            now: NOW,
            hasScope: true,
            returnedFromSilence: true,
        });

        assert.equal(decision.run, true);
        assert.equal(decision.reason, "returned-from-silence");
    });

    it("holds off a second check inside the interval", () => {
        const state = play({ ...ready(), lastRunAt: NOW - 1000 }, RECONCILE_EVERY_EVENTS * 10);

        const decision = shouldReconcile(state, { now: NOW, hasScope: true });

        assert.equal(decision.run, false);
        assert.equal(decision.reason, "too-soon");
    });

    it("holds off even on returning from silence", () => {
        // Otherwise toggling playback repeatedly would spend a request each time
        const state = { ...ready(), lastRunAt: NOW - 1000 };

        const decision = shouldReconcile(state, {
            now: NOW,
            hasScope: true,
            returnedFromSilence: true,
        });

        assert.equal(decision.run, false);
        assert.equal(decision.reason, "too-soon");
    });

    it("checks again exactly at the interval", () => {
        const state = play({ ...ready(), lastRunAt: NOW - RECONCILE_MIN_INTERVAL_MS }, RECONCILE_EVERY_EVENTS);

        assert.equal(shouldReconcile(state, { now: NOW, hasScope: true }).run, true);
    });

    it("checks a user who has never been checked", () => {
        const state = play(newReconciliationState(), RECONCILE_EVERY_EVENTS);

        assert.equal(shouldReconcile(state, { now: NOW, hasScope: true }).run, true);
    });

    it("refuses on scope before anything else", () => {
        // The reason matters: a scopeless account is not waiting for a timer
        const state = { ...ready(), lastRunAt: NOW };

        assert.equal(
            shouldReconcile(state, { now: NOW, hasScope: false, returnedFromSilence: true }).reason,
            "no-scope",
        );
    });
});

describe("recordReconciliation", () => {
    it("clears the count and stamps the run", () => {
        const state = recordReconciliation(play(ready(), 7), { now: NOW });

        assert.equal(state.eventsSinceLastRun, 0);
        assert.equal(state.lastRunAt, NOW);
    });

    it("advances the watermark to what was imported", () => {
        const state = recordReconciliation(ready(), { now: NOW, importedThrough: NOW - 60e3 });

        assert.equal(state.lastImportedPlayedAt, NOW - 60e3);
    });

    it("never walks the watermark backwards", () => {
        // A page returning older plays than the last check must not cause
        // everything after it to be imported a second time
        const state = recordReconciliation(
            ready({ lastImportedPlayedAt: NOW - 1000 }),
            { now: NOW, importedThrough: NOW - 60e3 },
        );

        assert.equal(state.lastImportedPlayedAt, NOW - 1000);
    });

    it("keeps the watermark when a check found nothing", () => {
        const state = recordReconciliation(ready({ lastImportedPlayedAt: NOW - 1000 }), { now: NOW });

        assert.equal(state.lastImportedPlayedAt, NOW - 1000);
    });

    it("stops a check running again immediately after one", () => {
        const after = recordReconciliation(play(ready(), 20), { now: NOW });

        assert.equal(shouldReconcile(after, { now: NOW, hasScope: true }).reason, "too-soon");
    });
});

describe("alreadyAccountedFor", () => {
    it("recognises a play already imported", () => {
        const state = ready({ lastImportedPlayedAt: NOW });

        assert.equal(alreadyAccountedFor(state, NOW - 1000), true);
        assert.equal(alreadyAccountedFor(state, NOW), true);
    });

    it("lets through a play newer than the watermark", () => {
        const state = ready({ lastImportedPlayedAt: NOW });

        assert.equal(alreadyAccountedFor(state, NOW + 1), false);
    });

    it("lets everything through for a user never checked", () => {
        assert.equal(alreadyAccountedFor(newReconciliationState(), 1), false);
    });
});

describe("a listening session over time", () => {
    it("checks on returning, then every few songs, never faster than the floor", () => {
        let state = newReconciliationState();
        let now = NOW;

        const runs: string[] = [];

        const tick = (songs: number, minutes: number, returned = false) => {
            state = play(state, songs);
            now += minutes * 60e3;

            const decision = shouldReconcile(state, { now, hasScope: true, returnedFromSilence: returned });

            if (decision.run) {
                runs.push(decision.reason);
                state = recordReconciliation(state, { now });
            }
        };

        tick(1, 1, true);                       // comes back from a silence
        tick(1, 1);                             // too soon, and not enough songs
        tick(RECONCILE_EVERY_EVENTS, 2);        // enough songs, still inside the floor
        tick(0, 5);                             // floor passed, count still standing
        tick(RECONCILE_EVERY_EVENTS, 10);       // and again later

        assert.deepEqual(runs, ["returned-from-silence", "enough-events", "enough-events"]);
    });

    it("costs one check per user per interval at most, however much they play", () => {
        let state = newReconciliationState();
        let runs = 0;

        // An hour of listening, a song every two minutes
        for (let minute = 0; minute <= 60; minute += 2) {
            state = recordSongEvent(state);

            const now = NOW + (minute * 60e3);

            if (shouldReconcile(state, { now, hasScope: true }).run) {
                runs++;
                state = recordReconciliation(state, { now });
            }
        }

        assert.ok(runs <= 60e3 * 60 / RECONCILE_MIN_INTERVAL_MS, `ran ${runs} times`);
        assert.ok(runs >= 5, `ran only ${runs} times`);
    });
});
