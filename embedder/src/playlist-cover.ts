import { readFile } from "fs/promises";
import sharp from "sharp";

/**
 * The cover Tempo puts on the playlists it writes to Spotify: its own mark.
 *
 * Spotify takes a cover as base64 JPEG of at most 256 KB, over a scope of
 * its own (ugc-image-upload). The mark ships with the server as a PNG with
 * transparent corners; it is laid on the app's black once, resized to a
 * cover's size, and kept in memory as the string Spotify wants, since it is
 * the same for every playlist there will ever be.
 */

export const COVER_MAX_BYTES = 256 * 1024;
export const COVER_SIZE = 640;
const PAGE_BLACK = { r: 13, g: 13, b: 14 };

/** The PNG at `path` as base64 JPEG within Spotify's limit, stepping quality down until it fits. */
export async function coverJpegBase64(path: string): Promise<string> {
    const source = await readFile(path);

    for (const quality of [90, 80, 70, 60]) {
        const jpeg = await sharp(source)
            .resize(COVER_SIZE, COVER_SIZE, { fit: "cover" })
            .flatten({ background: PAGE_BLACK })
            .jpeg({ quality, mozjpeg: true })
            .toBuffer();

        if (jpeg.byteLength <= COVER_MAX_BYTES)
            return jpeg.toString("base64");
    }

    throw new Error(`the playlist cover at ${path} cannot be brought under ${COVER_MAX_BYTES} bytes`);
}

let cached: Promise<string> | null = null;

/** The cover, made once. A failure is not kept, so the next ask tries again. */
export function playlistCover(path: string): Promise<string> {
    if (!cached)
        cached = coverJpegBase64(path).catch(ex => {
            cached = null;
            throw ex;
        });

    return cached;
}
