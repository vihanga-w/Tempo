import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

import { REQ_USER_AGENT } from "./const";
import {
    R2_ACCESS_KEY_ID,
    R2_BUCKET,
    R2_ENDPOINT,
    R2_PUBLIC_URL,
    R2_SECRET_ACCESS_KEY,
} from "./env";

/**
 * Album art and profile pictures, converted once and kept in R2.
 *
 * Spotify image ids are content-addressed and immutable, so a variant only ever
 * has to be produced once. This replaces the separate image-cdn service, which
 * kept its own on-disk and in-memory caches and had to be scaled and paid for
 * alongside the API.
 */

/**
 * Bounds on the sizes the app may ask for.
 *
 * The old service passed the requested dimensions straight to ImageMagick, so
 * `?s=20000x20000` was a one-request denial of service. Clamping rather than
 * listing exact sizes keeps the UI free to pick its own dimensions without a
 * server change, while still bounding the work per request.
 *
 * Dimensions snap to a multiple of SIZE_STEP so a handful of near-identical
 * requests share one stored variant instead of producing one each.
 */
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 1024;
const SIZE_STEP = 4;

/** Sharpening multiplier retained from the previous ImageMagick pipeline. */
const RENDER_SCALE = 1.5;

const SPOTIFY_IMAGE_PREFIX = "https://i.scdn.co/image/";

/** Spotify image ids are hex-ish base tokens; reject anything else outright. */
const IMAGE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

const client = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

/**
 * Variants currently being produced, so that N concurrent requests for the same
 * uncached image do one download and one conversion rather than N of each.
 */
const inFlight = new Map<string, Promise<boolean>>();

/** Keys we have already confirmed exist, so the common path skips the HEAD. */
const knownPresent = new Set<string>();

export function isValidImageId(imageId: string) {
    return IMAGE_ID_PATTERN.test(imageId);
}

/**
 * Parses a `WxH` size, returning the normalised form or null if it is unusable.
 * Callers treat null-with-input as a client error and null-without-input as
 * "give me the original".
 */
export function parseSize(raw: string | undefined): string | null {
    if (!raw)
        return null;

    const parts = raw.split("x");

    if (parts.length !== 2)
        return null;

    const dimensions = parts.map(v => {
        if (!/^\d+$/.test(v))
            return null;

        const parsed = parseInt(v, 10);

        if (!Number.isFinite(parsed) || parsed < MIN_DIMENSION || parsed > MAX_DIMENSION)
            return null;

        // Snap up to the next step so variants coalesce
        return Math.min(MAX_DIMENSION, Math.ceil(parsed / SIZE_STEP) * SIZE_STEP);
    });

    if (dimensions.some(v => v === null))
        return null;

    return `${dimensions[0]}x${dimensions[1]}`;
}

export function describeSizeLimits() {
    return `width and height must be integers between ${MIN_DIMENSION} and ${MAX_DIMENSION}`;
}

function objectKey(imageId: string, size: string | null) {
    return size ? `scdn/${imageId}/${size}.webp` : `scdn/${imageId}/original.webp`;
}

/** True when the bucket is publicly reachable and we can redirect to it. */
export function hasPublicUrl() {
    return R2_PUBLIC_URL !== undefined;
}

/**
 * Public URL for a variant, or null when the bucket is not publicly exposed —
 * in which case callers stream the bytes with readVariant instead.
 */
export function publicUrlFor(imageId: string, size: string | null) {
    if (!R2_PUBLIC_URL)
        return null;

    return `${R2_PUBLIC_URL}/${objectKey(imageId, size)}`;
}

async function existsInR2(key: string) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));

        return true;
    } catch (ex: any) {
        const status = ex?.$metadata?.httpStatusCode;

        if (status === 404 || ex?.name === "NotFound")
            return false;

        // A transient R2 error should not be reported as "missing", or we would
        // re-download and re-upload the image on every request
        throw ex;
    }
}

async function produceVariant(imageId: string, size: string | null, key: string) {
    const source = SPOTIFY_IMAGE_PREFIX + imageId;

    const response = await fetch(source, {
        headers: { "User-Agent": REQ_USER_AGENT },
    });

    if (!response.ok)
        throw new Error(`Spotify CDN returned ${response.status} for ${imageId}`);

    const input = Buffer.from(await response.arrayBuffer());

    let pipeline = sharp(input);

    if (size) {
        const [width, height] = size.split("x").map(v => parseInt(v, 10));

        pipeline = pipeline.resize(
            Math.round(width * RENDER_SCALE),
            Math.round(height * RENDER_SCALE),
            { fit: "cover" }
        );
    }

    const output = await pipeline.webp({ quality: 90 }).toBuffer();

    await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: output,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
    }));

    return true;
}

/**
 * Makes sure the requested variant is in R2, producing it if it is not.
 * Resolves true when the object is available.
 */
export async function ensureVariant(imageId: string, size: string | null): Promise<boolean> {
    const key = objectKey(imageId, size);

    if (knownPresent.has(key))
        return true;

    const existing = inFlight.get(key);

    if (existing)
        return existing;

    const work = (async () => {
        if (await existsInR2(key)) {
            knownPresent.add(key);

            return true;
        }

        await produceVariant(imageId, size, key);

        knownPresent.add(key);

        return true;
    })()
    .finally(() => {
        inFlight.delete(key);
    });

    inFlight.set(key, work);

    return work;
}

/**
 * Reads an object back so the API can serve it directly.
 *
 * Used while R2_PUBLIC_URL is unset. Responses carry immutable cache headers, so
 * with Cloudflare in front most repeat requests never reach this. Once public
 * access is enabled, the route redirects instead and this stops being called.
 */
export async function readVariant(imageId: string, size: string | null) {
    const key = objectKey(imageId, size);

    const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));

    if (!result.Body)
        return null;

    return Buffer.from(await result.Body.transformToByteArray());
}
