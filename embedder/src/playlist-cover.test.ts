import { describe, it } from "node:test";
import assert from "node:assert";

import { COVER_MAX_BYTES, coverJpegBase64 } from "./playlist-cover";

describe("the playlist cover", () => {
    it("is a JPEG within Spotify's limit, made from the mark that ships with the server", async () => {
        const base64 = await coverJpegBase64("static/playlist-cover.png");
        const bytes = Buffer.from(base64, "base64");

        assert.ok(bytes.byteLength <= COVER_MAX_BYTES, `${bytes.byteLength} bytes`);
        // A JPEG starts FF D8 FF
        assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    });
});
