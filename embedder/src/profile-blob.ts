import sharp from "sharp";
import { encode as encodeBlurHash, isBlurhashValid } from "blurhash";

import { REQ_USER_AGENT } from "./const";

/**
 * A blurred stand-in for a profile picture, small enough to travel with the
 * account it belongs to.
 *
 * A profile picture is fetched over the network like anything else, and until it
 * arrives the app has nothing to draw. Everywhere one appears there is a gap
 * first — a hole in a row of friends, a blank square above a name — and then it
 * pops in. The usual fix is a grey box, which replaces a hole with a different
 * hole.
 *
 * This is the picture itself, reduced until it is nothing but its colours. Drawn
 * into the space it will occupy and smoothed, it reads as an out of focus
 * version of what is about to appear, so the real picture resolving into place
 * looks like it is coming into focus rather than replacing something else.
 *
 * A grid this small — sixteen pixels, forty eight bytes, sixty four characters
 * of base64 — costs less to send with an account than a single HTTP request
 * would, which is what makes it worth putting on every account rather than
 * fetching separately.
 */

/** Sixteen pixels: enough for a light side and a dark side, and a hint of hue. */
export const BLOB_GRID = 4;

const BLOB_BYTES = BLOB_GRID * BLOB_GRID * 3;

/**
 * How many wave components a BlurHash keeps, across and down.
 *
 * Four by four is what BlurHash recommends for a square, and a profile picture
 * is always square. It comes out at 36 characters — fewer than the 64 the flat
 * grid above takes, for a great deal more of the picture: sixteen averaged
 * squares can say "pale, with something dark at the bottom", where the same
 * bytes spent on wave components say which side the head is on.
 */
export const BLURHASH_COMPONENTS = 4;

/**
 * What the picture is reduced to before encoding.
 *
 * BlurHash only keeps low frequencies, so feeding it the full-size image buys
 * nothing and costs the decode of a 300px JPEG per account. Sixty four square
 * is comfortably more than the components can represent.
 */
const BLURHASH_SOURCE = 64;

/**
 * Reduces a picture to its colours.
 *
 * Returns null rather than throwing, on anything at all. A missing blob costs a
 * placeholder; a throw here would be inside whatever was refreshing the account,
 * and losing somebody's session because their avatar 404'd would be absurd.
 */
export async function computeColourBlob(imageUrl: string): Promise<string | null> {
    const both = await computeProfilePlaceholders(imageUrl);

    return both?.blob ?? null;
}

/** Both placeholders for one picture, fetched once. */
export interface ProfilePlaceholders {
    /** The 4x4 grid. Kept while apps that only understand it are still out. */
    blob: string | null;
    /** The BlurHash, which is what anything current draws. */
    blurHash: string | null;
}

/**
 * Fetches a picture once and reduces it both ways.
 *
 * Two encodings rather than one because an app already installed only knows
 * about the grid, and dropping it would take the placeholder away from every
 * copy of Tempo already on a phone until each was updated. The grid can go once
 * the version that reads a BlurHash is the oldest one out there.
 */
export async function computeProfilePlaceholders(
    imageUrl: string,
): Promise<ProfilePlaceholders | null> {
    try {
        const response = await fetch(imageUrl, {
            headers: { "User-Agent": REQ_USER_AGENT },
        });

        if (!response.ok)
            return null;

        const input = Buffer.from(await response.arrayBuffer());

        return {
            blob: await colourBlobFromImage(input),
            blurHash: await blurHashFromImage(input),
        };
    } catch {
        return null;
    }
}

/**
 * The BlurHash for a picture.
 *
 * Split out from the fetch for the same reason as the grid: so it can be
 * exercised against a known image rather than against whatever the network
 * returns.
 */
export async function blurHashFromImage(input: Buffer): Promise<string | null> {
    try {
        const { data, info } = await sharp(input)
            .resize(BLURHASH_SOURCE, BLURHASH_SOURCE, { fit: "cover" })
            // encode reads four channels per pixel and will read past the end of
            // a three channel buffer, so the alpha is not optional
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const hash = encodeBlurHash(
            new Uint8ClampedArray(data),
            info.width,
            info.height,
            BLURHASH_COMPONENTS,
            BLURHASH_COMPONENTS,
        );

        return isBlurhashValid(hash).result ? hash : null;
    } catch {
        return null;
    }
}

/** Cheap sanity check for a hash read back out of the database. */
export function isValidBlurHash(hash: unknown): hash is string {
    if (typeof hash !== "string" || hash.length === 0)
        return false;

    return isBlurhashValid(hash).result;
}

/**
 * The reduction itself, given the bytes of a picture.
 *
 * Split out from the fetch so it can be exercised against a known image rather
 * than against whatever the network returns.
 */
export async function colourBlobFromImage(input: Buffer): Promise<string | null> {
    try {
        const raw = await sharp(input)
            // Averaging down to the grid is the blur. Doing it in one step means
            // every source pixel contributes, so a picture with one bright corner
            // keeps that corner rather than losing it to a nearest-neighbour pick
            .resize(BLOB_GRID, BLOB_GRID, { fit: "cover" })
            .removeAlpha()
            .raw()
            .toBuffer();

        if (raw.length !== BLOB_BYTES)
            return null;

        return raw.toString("base64");
    } catch {
        return null;
    }
}

/** Cheap sanity check for something read back out of the database. */
export function isValidColourBlob(blob: unknown): blob is string {
    if (typeof blob !== "string")
        return false;

    // 48 bytes of base64, no padding beyond the one character it needs
    if (!/^[A-Za-z0-9+/]{64}$/.test(blob))
        return false;

    return true;
}
