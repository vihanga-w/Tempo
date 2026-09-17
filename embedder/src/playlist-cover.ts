import { readFile } from "fs/promises";
import sharp from "sharp";

/**
 * The covers Tempo puts on the playlists it writes to Spotify.
 *
 * Spotify takes a cover as base64 JPEG of at most 256 KB, over a scope of
 * its own (ugc-image-upload). Two kinds are made here:
 *
 *   - the mark: Tempo's icon, laid on the app's black and resized. The same
 *     for every playlist there will ever be, so it is made once and kept.
 *   - a friends cover: the people whose plays made the playlist, as the
 *     initials in the avatar colours the app gives them, in a ring on a wash
 *     of the songs' own colours, with the mark in the corner. Different for
 *     every playlist, and remade when the friends change.
 *
 * Both are drawn as SVG and rasterised by sharp, which the server already
 * has for artwork. The server's image carries Inter for the text; anywhere
 * without it the fallback sans is used, which is worse but never blank.
 */

export const COVER_MAX_BYTES = 256 * 1024;
export const COVER_SIZE = 640;
const PAGE_BLACK = { r: 13, g: 13, b: 14 };
const BLACK_HEX = "#0D0D0E";

/** A JPEG within Spotify's limit from a sharp pipeline, stepping quality down until it fits. */
async function fitJpeg(make: (quality: number) => sharp.Sharp, what: string): Promise<string> {
    for (const quality of [90, 80, 70, 60]) {
        const jpeg = await make(quality).jpeg({ quality, mozjpeg: true }).toBuffer();

        if (jpeg.byteLength <= COVER_MAX_BYTES)
            return jpeg.toString("base64");
    }

    throw new Error(`${what} cannot be brought under ${COVER_MAX_BYTES} bytes`);
}

/** The PNG at `path` as base64 JPEG within Spotify's limit. */
export async function coverJpegBase64(path: string): Promise<string> {
    const source = await readFile(path);

    return fitJpeg(() => sharp(source)
        .resize(COVER_SIZE, COVER_SIZE, { fit: "cover" })
        .flatten({ background: PAGE_BLACK }), `the playlist cover at ${path}`);
}

let cachedMark: Promise<string> | null = null;

/** The mark, made once. A failure is not kept, so the next ask tries again. */
export function playlistCover(path: string): Promise<string> {
    if (!cachedMark)
        cachedMark = coverJpegBase64(path).catch(ex => {
            cachedMark = null;
            throw ex;
        });

    return cachedMark;
}

/* ------------------------------------------------------------ friends cover */

/**
 * The avatar colours, exactly as the app chooses them (src/lib/avatar-colour.ts
 * there), so a friend is the same colour on the cover as in the app. Seeded
 * on the account id and nothing else.
 */
const AVATAR_COLOURS: { from: string; ink: string }[] = [
    { from: "#3a2f5e", ink: "#c9b8f0" },
    { from: "#2b4a5c", ink: "#a5d0ec" },
    { from: "#2f5145", ink: "#a2dcc4" },
    { from: "#5a3a3a", ink: "#f0b3b3" },
    { from: "#54432a", ink: "#ecc999" },
    { from: "#453056", ink: "#d6b0ee" },
    { from: "#2e3f5c", ink: "#adc2ea" },
    { from: "#4d3350", ink: "#e2aee6" },
    { from: "#354a3a", ink: "#b0d9b8" },
    { from: "#4a3a2c", ink: "#e0bd9b" },
];

export function avatarColour(userId: string): { from: string; ink: string } {
    let hash = 0;

    for (let i = 0; i < userId.length; i++)
        hash = (Math.imul(hash, 31) + userId.charCodeAt(i)) >>> 0;

    return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

export function avatarInitial(displayName?: string): string {
    const trimmed = (displayName ?? "").trim();

    return (trimmed === "" ? "?" : Array.from(trimmed)[0].toUpperCase());
}

export interface CoverFriend {
    id: string;
    name: string;
}

export interface FriendsCoverInput {
    name: string;
    friends: readonly CoverFriend[];
    /** Colours for the wash, as hex; the songs' own, or none for the default. */
    colours: readonly string[];
    /** The mark as PNG, for the corner. */
    markPng: Buffer;
    /** As many as the ring holds legibly; the rest are counted. */
    maxShown?: number;
}

/** No more faces than read at Spotify's sizes; beyond this it says "+n". */
export const RING_MAX = 8;

/** A hex colour moved `amount` of the way toward white. */
export function lifted(hex: string, amount: number): string {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());

    if (!m)
        return hex;

    const part = (v: string) => Math.round(parseInt(v, 16) + (255 - parseInt(v, 16)) * amount).toString(16).padStart(2, "0");

    return `#${part(m[1])}${part(m[2])}${part(m[3])}`;
}

/** Whether a colour is light enough to want dark ink on it. */
export function isLight(hex: string): boolean {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());

    if (!m)
        return false;

    const [r, g, b] = [m[1], m[2], m[3]].map(v => parseInt(v, 16) / 255);

    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.55;
}

function escape(text: string): string {
    return text.replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** The names under the title: "Maya, Jon and Sam", or "Maya, Jon and 5 others". */
export function friendsLine(friends: readonly CoverFriend[], maxNamed = 3): string {
    const names = friends.map(f => f.name.trim()).filter(Boolean);

    if (names.length === 0)
        return "";

    if (names.length <= maxNamed)
        return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    const rest = names.length - (maxNamed - 1);

    return `${names.slice(0, maxNamed - 1).join(", ")} and ${rest} others`;
}

/** The wash gradients, the bottom fade, and the plate that clips the mark. */
function coverDefs(colours: readonly string[], markX: number, markY: number, markSize: number): string {
    const [a = "#A480FF", b = "#FF5F8F", c = "#4FE3C1"] = colours;

    return `<defs>
  <radialGradient id="wa" cx="0.2" cy="0.15" r="0.8"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
  <radialGradient id="wb" cx="0.85" cy="0.35" r="0.7"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient>
  <radialGradient id="wc" cx="0.5" cy="0.95" r="0.7"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="${BLACK_HEX}" stop-opacity="0"/><stop offset="1" stop-color="${BLACK_HEX}" stop-opacity="0.9"/></linearGradient>
  <clipPath id="plate"><rect x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" rx="20"/></clipPath>
</defs>`;
}

/** The black, the wash and the fade every cover starts from. */
function coverGround(S: number, washOpacity: [number, number, number]): string {
    return `<rect width="${S}" height="${S}" fill="${BLACK_HEX}"/>
<rect width="${S}" height="${S}" fill="url(#wa)" opacity="${washOpacity[0]}"/>
<rect width="${S}" height="${S}" fill="url(#wb)" opacity="${washOpacity[1]}"/>
<rect width="${S}" height="${S}" fill="url(#wc)" opacity="${washOpacity[2]}"/>
<rect width="${S}" height="${S}" fill="url(#fade)"/>`;
}

/** The name and the line under it, bottom left, and the mark bottom right on its plate. */
function coverWords(S: number, title: string, line: string, markPng: Buffer, markX: number, markY: number, markSize: number): string {
    return `<text x="32" y="${S - 66}" fill="#ffffff" font-family="Inter, sans-serif" font-weight="800" font-size="40" letter-spacing="-1.2">${escape(title)}</text>
<text x="32" y="${S - 34}" fill="#ffffff" fill-opacity="0.62" font-family="Inter, sans-serif" font-weight="500" font-size="19">${escape(line)}</text>
<image x="${markX}" y="${markY}" width="${markSize}" height="${markSize}" clip-path="url(#plate)" xlink:href="data:image/png;base64,${markPng.toString("base64")}"/>`;
}

const MARK_SIZE = 88;
const MARK_X = COVER_SIZE - MARK_SIZE - 28;
const MARK_Y = COVER_SIZE - MARK_SIZE - 28;

/**
 * The friends cover as SVG. Layout, on a 640 square:
 *
 *   - a ring of avatars centred a little above the middle, its radius
 *     growing with how many there are, and never reaching the text below;
 *   - the playlist's name and the friends' names at the bottom left;
 *   - the mark at the bottom right, on its own black plate.
 */
export function friendsCoverSvg(input: FriendsCoverInput): string {
    const S = COVER_SIZE;
    const shown = input.friends.slice(0, input.maxShown ?? RING_MAX);
    const hidden = input.friends.length - shown.length;
    const n = shown.length + (hidden > 0 ? 1 : 0);
    const [a = "#A480FF"] = input.colours;
    // The text's top edge; the ring keeps clear of it
    const textTop = S - 118;
    const avatarR = n <= 4 ? 46 : n <= 6 ? 42 : 38;
    const cx = S / 2;
    const cy = 262;
    const radius = n <= 1 ? 0 : n <= 3 ? 150 : n <= 5 ? 178 : 196;
    const ringBottom = cy + radius + avatarR;
    // Pull the ring up if a large one would run into the words
    const lift = Math.max(0, ringBottom - (textTop - 24));
    const centreY = cy - lift;

    const avatars = shown.map((f, i) => {
        const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const x = cx + Math.cos(angle) * radius;
        const y = centreY + Math.sin(angle) * radius;
        const colour = avatarColour(f.id);

        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${avatarR}" fill="${colour.from}"/>`
            + `<text x="${x.toFixed(1)}" y="${(y + avatarR * 0.34).toFixed(1)}" text-anchor="middle" fill="${colour.ink}" font-family="Inter, sans-serif" font-weight="800" font-size="${Math.round(avatarR * 0.9)}">${escape(avatarInitial(f.name))}</text>`;
    });

    if (hidden > 0) {
        const angle = -Math.PI / 2 + ((n - 1) / n) * Math.PI * 2;
        const x = cx + Math.cos(angle) * radius;
        const y = centreY + Math.sin(angle) * radius;
        // Coloured from the wash it sits on, lifted well clear of it, so the
        // count reads whatever the songs' colours were
        const disc = lifted(a, 0.45);
        const ink = (isLight(disc) ? BLACK_HEX : "#ffffff");

        avatars.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${avatarR}" fill="${disc}"/>`
            + `<text x="${x.toFixed(1)}" y="${(y + avatarR * 0.3).toFixed(1)}" text-anchor="middle" fill="${ink}" font-family="Inter, sans-serif" font-weight="800" font-size="${Math.round(avatarR * 0.7)}">+${hidden}</text>`);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
${coverDefs(input.colours, MARK_X, MARK_Y, MARK_SIZE)}
${coverGround(S, [0.4, 0.35, 0.25])}
${radius > 0 ? `<circle cx="${cx}" cy="${centreY}" r="${radius}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>` : ""}
${avatars.join("\n")}
${coverWords(S, input.name, friendsLine(input.friends), input.markPng, MARK_X, MARK_Y, MARK_SIZE)}
</svg>`;
}

/* ---------------------------------------------------------------- fan cover */

export interface FanCoverInput {
    name: string;
    /** The line under the name: "for Vihanga · Liked in Discover". */
    line: string;
    /** Up to three artworks, as JPEG or PNG, front of the fan last. */
    artworks: readonly Buffer[];
    colours: readonly string[];
    markPng: Buffer;
}

/**
 * The fan cover as SVG: up to three of the playlist's covers held like a
 * hand of cards, on a wash of their colours, the name bottom left and the
 * mark bottom right. Reads as a mix of music even at Spotify's smallest.
 */
export function fanCoverSvg(input: FanCoverInput): string {
    const S = COVER_SIZE;
    const cards = input.artworks.slice(0, 3);
    const size = 300;
    const cx = S / 2;
    const cy = S / 2 - 48;
    const spread = cards.length === 1 ? 0 : cards.length === 2 ? 30 : 46;
    const tilt = cards.length === 1 ? 0 : cards.length === 2 ? 9 : 14;

    const fan = cards.map((art, i) => {
        const offset = i - (cards.length - 1) / 2;
        const angle = offset * tilt;
        const mime = (art[0] === 0x89 ? "image/png" : "image/jpeg");

        return `<g transform="translate(${(cx + offset * spread).toFixed(1)} ${cy}) rotate(${angle}) translate(${-size / 2} ${-size / 2})">
  <rect x="-6" y="-6" width="${size + 12}" height="${size + 12}" rx="18" fill="${BLACK_HEX}" fill-opacity="0.7"/>
  <clipPath id="card${i}"><rect width="${size}" height="${size}" rx="14"/></clipPath>
  <image width="${size}" height="${size}" clip-path="url(#card${i})" preserveAspectRatio="xMidYMid slice" xlink:href="data:${mime};base64,${art.toString("base64")}"/>
</g>`;
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
${coverDefs(input.colours, MARK_X, MARK_Y, MARK_SIZE)}
${coverGround(S, [0.3, 0.25, 0.3])}
${fan.join("\n")}
${coverWords(S, input.name, input.line, input.markPng, MARK_X, MARK_Y, MARK_SIZE)}
</svg>`;
}

/** The fan cover as base64 JPEG within Spotify's limit. */
export async function fanCoverJpegBase64(input: FanCoverInput): Promise<string> {
    const svg = Buffer.from(fanCoverSvg(input));

    return fitJpeg(() => sharp(svg, { density: 96 }).flatten({ background: PAGE_BLACK }), "the fan cover");
}

/** An artwork shrunk to what the fan shows it at, so three of them fit inside Spotify's limit. */
export async function artworkForFan(image: Buffer): Promise<Buffer> {
    return sharp(image).resize(320, 320, { fit: "cover" }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

/** The friends cover as base64 JPEG within Spotify's limit. */
export async function friendsCoverJpegBase64(input: FriendsCoverInput): Promise<string> {
    const svg = Buffer.from(friendsCoverSvg(input));

    return fitJpeg(() => sharp(svg, { density: 96 }).flatten({ background: PAGE_BLACK }), "the friends cover");
}

/**
 * The colours of some artwork, for the wash.
 *
 * Not the most common colour: on album art that is usually black, or the
 * grey of a photograph, and a wash of black is no wash. Each image is read
 * small, its pixels sorted into a dozen hues, and the hue that the most
 * colourful pixels share is the answer — a dark red sleeve gives red, not
 * the black around it. Art with no colour in it at all gives its own mean,
 * lifted so it still shows. Anything that cannot be fetched or read within
 * its time is left out.
 */
export async function artworkColours(
    urls: readonly string[],
    fetchImage: (url: string) => Promise<Buffer | null>,
): Promise<string[]> {
    const colours: string[] = [];

    for (const url of urls) {
        try {
            const image = await fetchImage(url);

            if (!image)
                continue;

            const { data, info } = await sharp(image).resize(48, 48, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

            colours.push(liveliestColour(data, info.channels));
        } catch {
            // Left out
        }
    }

    return colours;
}

const HUE_BUCKETS = 12;

/** The colour of the hue that the most colourful pixels share; or the mean, lifted, when nothing is colourful. */
export function liveliestColour(pixels: Buffer, channels: number): string {
    const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
    let meanR = 0, meanG = 0, meanB = 0, count = 0;

    for (let i = 0; i + 2 < pixels.length; i += channels) {
        const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));

        meanR += r; meanG += g; meanB += b; count++;

        // Only pixels with colour in them, and neither near-black nor near-white
        if (sat < 0.25 || l < 0.12 || l > 0.9)
            continue;

        let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;

        if (hue < 0)
            hue += 6;

        const bucket = buckets[Math.min(HUE_BUCKETS - 1, Math.floor(hue / 6 * HUE_BUCKETS))];
        const weight = sat;

        bucket.weight += weight;
        bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight;
    }

    const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
    const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));

    if (best.weight > 0)
        return `#${hex(best.r / best.weight)}${hex(best.g / best.weight)}${hex(best.b / best.weight)}`;

    if (count === 0)
        return "#A480FF";

    const lift = (v: number) => v + (1 - v) * 0.35;

    return `#${hex(lift(meanR / count))}${hex(lift(meanG / count))}${hex(lift(meanB / count))}`;
}

/** Fetches one image with a time budget, for artworkColours. Null on anything but success. */
export async function fetchImageWithin(url: string, ms = 5000): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok)
            return null;

        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
