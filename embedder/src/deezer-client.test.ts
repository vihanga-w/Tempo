import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DeezerClient, DEEZER_MAX_ATTEMPTS, DEEZER_ERROR } from "./deezer-client";

/**
 * The client against canned answers.
 *
 * What matters is how it reads Deezer, which mostly fails with HTTP 200: a
 * missing track must come back as missing (worth a week's wait), and a quota or
 * outage as failed (worth minutes), because the retry schedule turns on which.
 */

type Canned = { status?: number; body?: unknown; throws?: boolean };

function client(answers: Canned[]) {
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

    const deezer = new DeezerClient(fetchImpl, 0, async ms => { sleeps.push(ms); }, () => 0, 5000);

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

    it("gives up on a request that never answers, rather than waiting for ever", async () => {
        // A connection Deezer accepts and never answers would otherwise hold the
        // fetcher's one lookup for good. Each attempt is aborted at the deadline.
        let asked = 0;

        const hanging = (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise<any>((_, reject) => {
                asked++;
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });

        const deezer = new DeezerClient(hanging, 0, async () => {}, () => 0, 5000, 10);

        assert.deepEqual(await deezer.trackByIsrc("GBAAA2600001"), { kind: "failed" });
        assert.equal(asked, DEEZER_MAX_ATTEMPTS);
    });
});
