import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { evaluateStreakLoss, STREAK_BREAK_MS, StreakLossInput } from "./streak-loss";

const NOW = 1_700_000_000_000;
const MINUTE = 60e3;

/** A user mid-run, last active `gapMs` ago, polled every `nextRefreshTimeout`. */
function input(overrides: Partial<StreakLossInput> = {}): StreakLossInput {
    return {
        lastPlaySessionStart: NOW - (60 * MINUTE),
        prevItemTimestamp: NOW - (20 * MINUTE),
        interestingEventTimestamp: NOW - (20 * MINUTE),
        nextRefreshTimeout: 100e3,
        // Already due, so refreshOffset falls back to nextRefreshTimeout
        nextRefresh: NOW - 1,
        now: NOW,
        ...overrides,
    };
}

describe("evaluateStreakLoss — whether the run ended", () => {
    it("reports no loss when no run is in progress", () => {
        const result = evaluateStreakLoss(input({ lastPlaySessionStart: -1 }));

        assert.equal(result.lost, false);
        assert.equal(result.durationMs, 0);
    });

    it("keeps a run alive while the gap is under the threshold", () => {
        const lastActivity = NOW - (5 * MINUTE);

        const result = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
        }));

        assert.equal(result.lost, false);
    });

    it("ends a run once the padded gap reaches the threshold exactly", () => {
        // checkTime lands exactly STREAK_BREAK_MS ago: lastActivity + padding
        const padding = 100e3;
        const lastActivity = NOW - STREAK_BREAK_MS - padding;

        const result = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: padding,
        }));

        assert.equal(result.lost, true);
    });

    it("ends a run when the gap is well past the threshold", () => {
        const lastActivity = NOW - (50 * MINUTE);

        const result = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
        }));

        assert.equal(result.lost, true);
    });

    it("does not end a run whose last activity precedes its start", () => {
        // checkTime must exceed lastPlaySessionStart for a loss to register
        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: NOW - MINUTE,
            prevItemTimestamp: NOW - (30 * MINUTE),
            interestingEventTimestamp: NOW - (30 * MINUTE),
        }));

        assert.equal(result.lost, false);
    });

    it("ignores users with no timestamps at all", () => {
        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: 0,
            prevItemTimestamp: -2,
            interestingEventTimestamp: -1,
            nextRefreshTimeout: 0,
            nextRefresh: 0,
            now: 0,
        }));

        assert.equal(result.lost, false);
    });
});

describe("evaluateStreakLoss — the poll padding", () => {
    it("is tolerant: a gap under the threshold once padded keeps the run", () => {
        // 11 minutes of silence, but this user is only polled every 2 minutes,
        // so the unpadded gap would end the run and the padded one does not
        const lastActivity = NOW - (11 * MINUTE);

        const unpadded = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: 0,
        }));

        const padded = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: 2 * MINUTE,
        }));

        assert.equal(unpadded.lost, true);
        assert.equal(padded.lost, false);
    });

    it("takes the later of the interval and the scheduled next poll", () => {
        const lastActivity = NOW - (30 * MINUTE);

        // nextRefresh sits further out than nextRefreshTimeout, so it wins and
        // pads enough to keep the run alive
        const result = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: 1e3,
            nextRefresh: NOW + (25 * MINUTE),
        }));

        assert.equal(result.lost, false);
    });

    it("never pads by a negative amount", () => {
        const lastActivity = NOW - (30 * MINUTE);

        const result = evaluateStreakLoss(input({
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: -5000,
            nextRefresh: NOW - (10 * MINUTE),
        }));

        // Padding clamped to 0, so the raw 30 minute gap ends the run
        assert.equal(result.lost, true);
        assert.equal(result.durationMs, (60 * MINUTE) - (30 * MINUTE));
    });
});

describe("evaluateStreakLoss — the recorded duration", () => {
    it("measures to the last activity, not to the padded check time", () => {
        const start = NOW - (60 * MINUTE);
        const lastActivity = NOW - (20 * MINUTE);
        const padding = 100e3;

        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: padding,
        }));

        assert.equal(result.lost, true);
        assert.equal(result.durationMs, lastActivity - start);
        // The regression: padding must not inflate the recorded length
        assert.notEqual(result.durationMs, (lastActivity + padding) - start);
    });

    it("stays an integer when the poll interval is fractional", () => {
        // nextRefreshTimeout is 3600e3 / (hourlySchedule * 60), which divides
        // unevenly for most schedules. Those fractions leaking into the
        // recorded duration is what exposed this bug in production.
        const start = NOW - (60 * MINUTE);
        const lastActivity = NOW - (20 * MINUTE);

        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
            nextRefreshTimeout: 3600e3 / (7 * 60),
        }));

        assert.equal(result.lost, true);
        assert.equal(Number.isInteger(result.durationMs), true);
        assert.equal(result.durationMs, lastActivity - start);
    });

    it("uses the newest of the history item and the interesting event", () => {
        const start = NOW - (60 * MINUTE);
        const older = NOW - (40 * MINUTE);
        const newer = NOW - (20 * MINUTE);

        const historyNewer = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: newer,
            interestingEventTimestamp: older,
        }));

        const eventNewer = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: older,
            interestingEventTimestamp: newer,
        }));

        assert.equal(historyNewer.durationMs, newer - start);
        assert.equal(eventNewer.durationMs, newer - start);
    });

    it("falls back to the interesting event when there is no history", () => {
        const start = NOW - (60 * MINUTE);
        const lastActivity = NOW - (20 * MINUTE);

        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: -2,
            interestingEventTimestamp: lastActivity,
        }));

        assert.equal(result.lost, true);
        assert.equal(result.durationMs, lastActivity - start);
    });

    it("reports zero rather than a negative length", () => {
        // Padding carries checkTime past the start, so the run counts as ended,
        // while the activity itself predates it
        const start = NOW - (25 * MINUTE);

        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: NOW - (30 * MINUTE),
            interestingEventTimestamp: NOW - (30 * MINUTE),
            nextRefreshTimeout: 6 * MINUTE,
        }));

        assert.equal(result.lost, true);
        assert.equal(result.durationMs, 0);
    });

    it("reports zero whenever the run has not ended", () => {
        const result = evaluateStreakLoss(input({
            prevItemTimestamp: NOW - MINUTE,
            interestingEventTimestamp: NOW - MINUTE,
        }));

        assert.equal(result.lost, false);
        assert.equal(result.durationMs, 0);
    });

    it("records an overnight run at its real length", () => {
        // The 9h27m streak from production, which was correct because 100s of
        // padding is invisible at that scale
        const duration = 34_034_762;
        const start = NOW - duration - (30 * MINUTE);
        const lastActivity = start + duration;

        const result = evaluateStreakLoss(input({
            lastPlaySessionStart: start,
            prevItemTimestamp: lastActivity,
            interestingEventTimestamp: lastActivity,
        }));

        assert.equal(result.lost, true);
        assert.equal(result.durationMs, duration);
    });
});

describe("STREAK_BREAK_MS", () => {
    it("is ten minutes", () => {
        assert.equal(STREAK_BREAK_MS, 10 * MINUTE);
    });
});
