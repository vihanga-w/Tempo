import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { getPreviewWithISRC, usePreviewClient, previewExpiry } from "./deezer-helper";

/**
 * Preview URLs are signed and lapse, so they are cached until shortly before
 * they do and asked for again after. And a feed must never fail over one: no
 * preview is an answer.
 */

const EXP = Math.floor(Date.now() / 1000) + 3600;
const signed = (isrc: string) =>
    `https://cdnt-preview.dzcdn.net/api/1/1/${isrc}.mp3?hdnea=exp=${EXP}~acl=/api/1/1/*~data=user_id=0~hmac=abc`;

describe("previews", () => {
    it("reads when a signed preview lapses", () => {
        assert.equal(previewExpiry(signed("GBAAA2600100")), EXP * 1000);
        assert.equal(previewExpiry("https://example.com/unsigned.mp3"), null);
    });

    it("asks once, then serves the cached URL until it nears its expiry", async () => {
        let calls = 0;

        usePreviewClient({ previewByIsrc: async (isrc: string) => { calls++; return signed(isrc); } });

        const first = await getPreviewWithISRC("GBAAA2600101");
        const second = await getPreviewWithISRC("GBAAA2600101");

        assert.equal(first, signed("GBAAA2600101"));
        assert.equal(second, first);
        assert.equal(calls, 1);
    });

    it("gives no preview, rather than failing, when there is none to be had", async () => {
        usePreviewClient({ previewByIsrc: async () => null });
        assert.equal(await getPreviewWithISRC("GBAAA2600102"), null);

        usePreviewClient({ previewByIsrc: async () => { throw new Error("Deezer is down"); } });
        assert.equal(await getPreviewWithISRC("GBAAA2600103"), null);
    });
});
