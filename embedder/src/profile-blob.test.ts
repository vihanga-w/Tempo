import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import sharp from "sharp";

import { BLOB_GRID, colourBlobFromImage, isValidColourBlob } from "./profile-blob";

const BLOB_BYTES = BLOB_GRID * BLOB_GRID * 3;

/** A picture with known colours, so what comes out can be checked against it. */
async function solid(r: number, g: number, b: number, size = 128) {
    return sharp({
        create: { width: size, height: size, channels: 3, background: { r, g, b } },
    }).png().toBuffer();
}

/** Left half one colour, right half another. */
async function split(left: [number, number, number], right: [number, number, number]) {
    const size = 128;

    const base = await sharp({
        create: { width: size, height: size, channels: 3, background: { r: left[0], g: left[1], b: left[2] } },
    }).png().toBuffer();

    const patch = await sharp({
        create: { width: size / 2, height: size, channels: 3, background: { r: right[0], g: right[1], b: right[2] } },
    }).png().toBuffer();

    return sharp(base).composite([{ input: patch, left: size / 2, top: 0 }]).png().toBuffer();
}

function bytesOf(blob: string) {
    return Buffer.from(blob, "base64");
}

describe("colourBlobFromImage", () => {
    it("is exactly the size the client expects", async () => {
        const blob = await colourBlobFromImage(await solid(120, 40, 200));

        assert.ok(blob, "expected a blob");
        assert.equal(blob.length, 64, "64 characters of base64");
        assert.equal(bytesOf(blob).length, BLOB_BYTES, "48 bytes decoded");
        assert.ok(isValidColourBlob(blob));
    });

    it("carries the colour of the picture", async () => {
        const blob = await colourBlobFromImage(await solid(200, 30, 60));
        const bytes = bytesOf(blob!);

        // Every cell of a flat picture should be that colour, within the slack
        // encoding and resampling leave
        for (let pixel = 0; pixel < BLOB_GRID * BLOB_GRID; pixel++) {
            assert.ok(Math.abs(bytes[pixel * 3] - 200) <= 4, "red");
            assert.ok(Math.abs(bytes[pixel * 3 + 1] - 30) <= 4, "green");
            assert.ok(Math.abs(bytes[pixel * 3 + 2] - 60) <= 4, "blue");
        }
    });

    it("keeps where the colours are, not just which they are", async () => {
        const blob = await colourBlobFromImage(await split([220, 20, 20], [20, 20, 220]));
        const bytes = bytesOf(blob!);

        const cell = (row: number, column: number) => {
            const offset = (row * BLOB_GRID + column) * 3;

            return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
        };

        // Red on the left, blue on the right — the whole point of a grid rather
        // than a single average, which would make this a flat purple
        const [leftR, , leftB] = cell(0, 0);
        const [rightR, , rightB] = cell(0, BLOB_GRID - 1);

        assert.ok(leftR > leftB, "left of the picture should stay red");
        assert.ok(rightB > rightR, "right of the picture should stay blue");
    });

    it("strips alpha rather than letting it through", async () => {
        const transparent = await sharp({
            create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.5 } },
        }).png().toBuffer();

        const blob = await colourBlobFromImage(transparent);

        assert.ok(blob);
        assert.equal(bytesOf(blob).length, BLOB_BYTES, "three channels, not four");
    });

    it("copes with a picture that is not square", async () => {
        const wide = await sharp({
            create: { width: 400, height: 100, channels: 3, background: { r: 90, g: 90, b: 90 } },
        }).png().toBuffer();

        const blob = await colourBlobFromImage(wide);

        assert.ok(blob);
        assert.equal(bytesOf(blob).length, BLOB_BYTES);
    });

    /*
     * This runs inside whatever was refreshing somebody's account. Losing a
     * session because an avatar came back as a 404 page would be absurd, so it
     * answers null rather than throwing.
     */
    it("answers null for something that is not a picture", async () => {
        assert.equal(await colourBlobFromImage(Buffer.from("<html>404</html>")), null);
        assert.equal(await colourBlobFromImage(Buffer.alloc(0)), null);
    });
});

describe("isValidColourBlob", () => {
    it("accepts what the reducer produces", async () => {
        const blob = await colourBlobFromImage(await solid(1, 2, 3));

        assert.ok(isValidColourBlob(blob));
    });

    it("refuses anything else", () => {
        const bad: unknown[] = [
            undefined,
            null,
            "",
            123,
            {},
            [],
            "A".repeat(63),
            "A".repeat(65),
            // Padding, which 48 bytes never needs
            "A".repeat(62) + "==",
            // Base64url, which is not what is sent
            "A".repeat(62) + "-_",
            "not base64 at all!".padEnd(64, "!"),
        ];

        for (const value of bad)
            assert.equal(isValidColourBlob(value), false, `expected ${JSON.stringify(value)} to be refused`);
    });
});
