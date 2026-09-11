import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DeezerClient, DeezerBudget, DeezerMode, DEEZER_MAX_ATTEMPTS, DEEZER_ERROR } from "./deezer-client";

/**
 * The client against canned answers.
 *
 * What matters is how it reads Deezer, which mostly fails with HTTP 200: a
 * missing track must come back as missing (worth a week's wait), and a quota or
 * outage as failed (worth minutes), because the retry schedule turns on which.
 */

type Canned = { status?: number; body?: unknown; throws?: boolean };

function client(answers: Canned[], opts: { mode?: DeezerMode; budget?: DeezerBudget } = {}) {
    const urls: string[] = [];
    const sleeps: number[] = [];
    let i = 0;

    const fetchImpl = async (url: string) => {
        urls.push(url);

        const answer = answers[Math.min(i++, answers.length - 1)];

        if (answer.throws)
            throw new Error("ECONNRESET");

        const status = answer.status ?? 200;

        return { ok: status >= 200 && status < 300, status, json: async () => answer.body };
    };

    const deezer = new DeezerClient(
        fetchImpl, 0, async ms => { sleeps.push(ms); }, () => 0, 5000, opts.budget ?? null, opts.mode ?? "background",
    );

    return { deezer, urls, sleeps };
}

const TRACK = { id: 1001, isrc: "GBAAA2600001", duration: 245, rank: 600000, album: { id: 501 }, artist: { id: 301 } };

describe("DeezerClient", () => {
    it("finds a track by ISRC", async () => {
        const { deezer, urls } = client([{ body: TRACK }]);
        const answer = await deezer.trackByIsrc("gbaaa2600001");

        assert.equal(answer.kind, "found");
        assert.equal(answer.kind === "found" && answer.value.album_id, 501);
        assert.equal(urls[0], "https://api.deezer.com/2.0/track/isrc:GBAAA2600001");
    });

    it("reads Deezer's 'no data' as missing, not failed", async () => {
        const { deezer } = client([{ body: { error: { type: "DataException", message: "no data", code: DEEZER_ERROR.NO_DATA } } }]);

        assert.deepEqual(await deezer.trackByIsrc("GBAAA2600001"), { kind: "missing" });
    });

    it("waits out a quota and asks again", async () => {
        const { deezer, urls, sleeps } = client([
            { body: { error: { type: "Exception", message: "Quota limit exceeded", code: DEEZER_ERROR.QUOTA } } },
            { body: TRACK },
        ]);

        const answer = await deezer.trackByIsrc("GBAAA2600001");

        assert.equal(answer.kind, "found");
        assert.equal(urls.length, 2);
        assert.deepEqual(sleeps, [5000]);
    });

    it("gives up on an outage as failed, after a bounded number of tries", async () => {
        const { deezer, urls } = client([{ status: 503 }]);

        assert.deepEqual(await deezer.trackByIsrc("GBAAA2600001"), { kind: "failed" });
        assert.equal(urls.length, DEEZER_MAX_ATTEMPTS);
    });

    it("tries again after the network drops a request", async () => {
        const { deezer } = client([{ throws: true }, { body: TRACK }]);

        assert.equal((await deezer.trackByIsrc("GBAAA2600001")).kind, "found");
    });

    it("reads a 404 as missing", async () => {
        const { deezer } = client([{ status: 404 }]);

        assert.deepEqual(await deezer.album(501), { kind: "missing" });
    });

    it("does not ask about something that cannot be an ISRC or an id", async () => {
        const { deezer, urls } = client([{ body: TRACK }]);

        assert.deepEqual(await deezer.trackByIsrc("not-an-isrc"), { kind: "missing" });
        assert.deepEqual(await deezer.album(-1), { kind: "missing" });
        assert.equal(urls.length, 0);
    });

    it("reads an album's genres and an artist's fans", async () => {
        const { deezer } = client([
            { body: { id: 501, genres: { data: [{ name: "Pop" }, { name: "Dance" }] }, release_date: "2026-09-04" } },
            { body: { id: 301, nb_fan: 1260527 } },
        ]);

        assert.deepEqual(await deezer.album(501), {
            kind: "found", value: { id: 501, genres: ["Pop", "Dance"], release_date: "2026-09-04" },
        });

        assert.deepEqual(await deezer.artist(301), { kind: "found", value: { id: 301, nb_fan: 1260527 } });
    });
});

describe("DeezerBudget", () => {
    // Capacity 10, two a second, on a clock that only moves when somebody waits
    function budget() {
        const clock = { t: 0 };
        const b = new DeezerBudget(10, 2, () => clock.t, async ms => { clock.t += ms; });

        return { clock, b };
    }

    it("lets a burst through up to its capacity, then refills at its rate", () => {
        const { clock, b } = budget();

        for (let i = 0; i < 10; i++)
            assert.equal(b.tryTake(), true);

        assert.equal(b.tryTake(), false);

        clock.t += 500;
        assert.equal(b.tryTake(), true);
    });

    it("makes the background wait rather than take the reserve", async () => {
        const { clock, b } = budget();

        // Four left, and a reserve of five means six are needed
        for (let i = 0; i < 6; i++)
            b.tryTake();

        await b.take(5);

        assert.equal(clock.t, 1000);
    });

    it("stops everybody for the window once Deezer says the quota is spent", () => {
        const { clock, b } = budget();

        b.drain(5000);
        assert.equal(b.tryTake(), false);

        clock.t += 5000;
        assert.equal(b.tryTake(), true);
    });
});

describe("DeezerClient, interactive", () => {
    const PREVIEW = "https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp=1789999999~acl=/*~hmac=abc";

    it("finds a preview, and none in an error body", async () => {
        const found = client([{ body: { ...TRACK, preview: PREVIEW } }], { mode: "interactive" });
        const none = client([{ body: { error: { code: DEEZER_ERROR.NO_DATA } } }], { mode: "interactive" });

        assert.equal(await found.deezer.previewByIsrc("GBAAA2600001"), PREVIEW);
        assert.equal(await none.deezer.previewByIsrc("GBAAA2600001"), null);
    });

    it("asks once, and does not wait out a quota with somebody waiting", async () => {
        const { deezer, urls, sleeps } = client(
            [{ body: { error: { code: DEEZER_ERROR.QUOTA } } }, { body: TRACK }],
            { mode: "interactive" },
        );

        assert.equal(await deezer.previewByIsrc("GBAAA2600001"), null);
        assert.equal(urls.length, 1);
        assert.deepEqual(sleeps, []);
    });

    it("goes without, rather than waits, when the shared budget is spent", async () => {
        // One request's worth, and a clock that never refills it
        const shared = new DeezerBudget(1, 1, () => 0, async () => {});
        const { deezer, urls } = client([{ body: { ...TRACK, preview: PREVIEW } }], { mode: "interactive", budget: shared });

        assert.equal(await deezer.previewByIsrc("GBAAA2600001"), PREVIEW);
        assert.equal(await deezer.previewByIsrc("GBAAA2600002"), null);
        assert.equal(urls.length, 1);
    });
});
