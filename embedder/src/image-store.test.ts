import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseSize, supersededVariantKeys } from "./image-store";

/**
 * The sweep deletes objects out of the bucket, so the matcher it uses is the one
 * piece of this that is genuinely dangerous to get wrong. These are the cases
 * that decide whether it deletes the right things and, more importantly, leaves
 * everything else alone.
 */
describe("supersededVariantKeys", () => {
    const IMAGE = "ab67616d0000b273c5649add";
    const KEEP = `scdn/${IMAGE}/96x96-q82.webp`;

    it("takes the same variant at an older quality", () => {
        assert.deepEqual(
            supersededVariantKeys(IMAGE, "96x96", KEEP, [`scdn/${IMAGE}/96x96-q90.webp`]),
            [`scdn/${IMAGE}/96x96-q90.webp`],
        );
    });

    it("takes the unsuffixed key from before the quality was in it", () => {
        assert.deepEqual(
            supersededVariantKeys(IMAGE, "96x96", KEEP, [`scdn/${IMAGE}/96x96.webp`]),
            [`scdn/${IMAGE}/96x96.webp`],
        );
    });

    it("never takes the key it was told to keep", () => {
        assert.deepEqual(supersededVariantKeys(IMAGE, "96x96", KEEP, [KEEP]), []);
    });

    it("leaves other sizes alone", () => {
        const others = [
            `scdn/${IMAGE}/144x144-q90.webp`,
            `scdn/${IMAGE}/original-q90.webp`,
            `scdn/${IMAGE}/48x48.webp`,
        ];

        assert.deepEqual(supersededVariantKeys(IMAGE, "96x96", KEEP, others), []);
    });

    /*
     * The one that would be a disaster. Without anchoring, the pattern for
     * "6x6" matches "96x96" and the pattern for "96x96" matches "196x196", so
     * producing one small thumbnail would delete the large ones.
     */
    it("does not confuse a size with one that contains it", () => {
        assert.deepEqual(
            supersededVariantKeys(IMAGE, "6x6", `scdn/${IMAGE}/6x6-q82.webp`, [
                `scdn/${IMAGE}/96x96-q90.webp`,
                `scdn/${IMAGE}/196x196-q90.webp`,
            ]),
            [],
        );

        assert.deepEqual(
            supersededVariantKeys(IMAGE, "96x96", KEEP, [`scdn/${IMAGE}/196x196-q90.webp`]),
            [],
        );
    });

    it("leaves anything not shaped like a variant where it is", () => {
        const strays = [
            `scdn/${IMAGE}/96x96-q90.avif`,
            `scdn/${IMAGE}/96x96-extra.webp`,
            `scdn/${IMAGE}/96x96-q90.webp.bak`,
            `scdn/${IMAGE}/96x96-qNINETY.webp`,
        ];

        assert.deepEqual(supersededVariantKeys(IMAGE, "96x96", KEEP, strays), []);
    });

    it("never reaches into another image's prefix", () => {
        assert.deepEqual(
            supersededVariantKeys(IMAGE, "96x96", KEEP, ["scdn/someoneelse/96x96-q90.webp"]),
            [],
        );
    });

    it("handles the original, which has no size", () => {
        const keepOriginal = `scdn/${IMAGE}/original-q82.webp`;

        assert.deepEqual(
            supersededVariantKeys(IMAGE, null, keepOriginal, [
                `scdn/${IMAGE}/original.webp`,
                `scdn/${IMAGE}/original-q90.webp`,
                keepOriginal,
                `scdn/${IMAGE}/96x96-q90.webp`,
            ]),
            [`scdn/${IMAGE}/original.webp`, `scdn/${IMAGE}/original-q90.webp`],
        );
    });

    it("takes several older qualities at once", () => {
        assert.deepEqual(
            supersededVariantKeys(IMAGE, "96x96", KEEP, [
                `scdn/${IMAGE}/96x96.webp`,
                `scdn/${IMAGE}/96x96-q70.webp`,
                `scdn/${IMAGE}/96x96-q90.webp`,
                KEEP,
            ]),
            [
                `scdn/${IMAGE}/96x96.webp`,
                `scdn/${IMAGE}/96x96-q70.webp`,
                `scdn/${IMAGE}/96x96-q90.webp`,
            ],
        );
    });

    /*
     * An image id is validated before it reaches here, but the id becomes part
     * of a regular expression, so a metacharacter surviving into it would change
     * what the pattern matches rather than failing to match.
     */
    it("treats a regex metacharacter in an id as a literal", () => {
        assert.deepEqual(
            supersededVariantKeys("a.c", "96x96", "scdn/a.c/96x96-q82.webp", [
                "scdn/abc/96x96-q90.webp",
            ]),
            [],
        );
    });
});

describe("parseSize", () => {
    it("accepts a size the app asks for", () => {
        assert.equal(parseSize("96x96"), "96x96");
    });

    it("refuses nonsense rather than passing it to the resizer", () => {
        for (const bad of ["", "x", "96", "96x", "abcxdef", "-4x-4", "96x96x96"])
            assert.equal(parseSize(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
    });

    /*
     * The reason the clamp exists: the service this replaced handed the
     * requested dimensions straight to ImageMagick, so one request for a
     * 20000x20000 variant was a denial of service.
     */
    it("refuses a size large enough to be an attack", () => {
        assert.equal(parseSize("20000x20000"), null);
    });
});
