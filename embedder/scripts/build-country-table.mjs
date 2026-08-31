/**
 * Regenerates src/country-centroids.ts from Natural Earth.
 *
 * Run when Natural Earth publishes a new release, or never. The table it writes
 * is checked in deliberately: the globe needs a coordinate for every country the
 * moment a passport is read, and a build step that reaches across the network is
 * a build step that fails on a bad day.
 *
 *     node scripts/build-country-table.mjs
 *
 * LABEL_X / LABEL_Y are used rather than a computed centroid. A centroid puts
 * Norway's marker in the sea and Chile's in Argentina; the label point is placed
 * by a cartographer to sit inside the country and clear of its neighbours, which
 * is exactly what a map pin wants.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector"
    + "/master/geojson/ne_50m_admin_0_countries.geojson";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "country-centroids.ts");

const response = await fetch(SOURCE);

if (!response.ok)
    throw new Error(`Natural Earth returned ${response.status}`);

const { features } = await response.json();
const rows = new Map();

for (const { properties } of features) {
    const iso = (properties.ISO_A2_EH ?? "").trim();

    if (!iso || iso === "-99" || rows.has(iso))
        continue;

    const { LABEL_X: lon, LABEL_Y: lat } = properties;

    if (typeof lon !== "number" || typeof lat !== "number")
        continue;

    rows.set(iso, [
        (properties.NAME_LONG ?? properties.NAME ?? "").trim(),
        Number(lat.toFixed(3)),
        Number(lon.toFixed(3)),
        (properties.CONTINENT ?? "").trim(),
    ]);
}

const body = [...rows.keys()].sort()
    .map(iso => {
        const [name, lat, lon, continent] = rows.get(iso);

        return `    ${iso}: ["${name.replace(/"/g, '\\"')}", ${lat}, ${lon}, "${continent}"],`;
    })
    .join("\n");

const existing = readFileSync(OUT, "utf8");
const BLOCK = /const ROWS: \{ \[iso2: string\]: CountryRow \} = \{\n[\s\S]*?\n\};/;

// Test for the block rather than comparing before and after: regenerating
// against an unchanged Natural Earth release produces an identical file, and
// that is a success, not a failure to find anything.
if (!BLOCK.test(existing))
    throw new Error("Could not find the ROWS block to replace; has the file been restructured?");

const rewritten = existing.replace(
    BLOCK,
    `const ROWS: { [iso2: string]: CountryRow } = {\n${body}\n};`,
);

writeFileSync(OUT, rewritten);

console.log(
    `Wrote ${rows.size} countries to ${OUT}`
    + (rewritten === existing ? " (unchanged)" : ""),
);
