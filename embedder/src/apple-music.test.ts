import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jwt from "jsonwebtoken";

import {
    AppleMusicClient,
    AppleMusicDeveloperToken,
    AppleMusicError,
    AppleMusicSongResource,
    artworkAt,
    catalogIdOf,
    songDataFromAppleMusic,
} from "./apple-music";

function withKey(test: (keyPath: string, publicKey: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "apple-music-"));
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

    try {
        const keyPath = join(dir, "AuthKey_TEST.p8");

        writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
        test(keyPath, publicKey.export({ type: "spki", format: "pem" }).toString());
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("AppleMusicDeveloperToken", () => {
    it("signs what Apple asks for: ES256, the key id, the team, and an expiry", () => {
        withKey((keyPath, publicKey) => {
            const now = Date.UTC(2026, 8, 24);
            const signer = new AppleMusicDeveloperToken({ keyId: "KEY1234567", teamId: "TEAM123456", keyPath }, () => now);

            const { token, expiresAt } = signer.current();
            const decoded = jwt.verify(token, publicKey, { algorithms: ["ES256"], complete: true, clockTimestamp: now / 1000 }) as jwt.Jwt;
            const payload = decoded.payload as jwt.JwtPayload;

            assert.equal(decoded.header.kid, "KEY1234567");
            assert.equal(payload.iss, "TEAM123456");
            assert.equal(payload.iat, now / 1000);
            assert.equal(payload.exp! * 1000, expiresAt);
            // Apple refuses anything over six months
            assert.ok(expiresAt - now <= 15777000 * 1000);
        });
    });

    it("reuses a token until it is getting old", () => {
        withKey(keyPath => {
            let now = Date.UTC(2026, 8, 24);
            const signer = new AppleMusicDeveloperToken({ keyId: "K", teamId: "T", keyPath }, () => now);

            const first = signer.current().token;

            now += 24 * 3600e3;
            assert.equal(signer.current().token, first);

            now += 30 * 24 * 3600e3;
            assert.notEqual(signer.current().token, first);
        });
    });

    it("says so when the key is missing", () => {
        assert.throws(() => new AppleMusicDeveloperToken({ keyId: "K", teamId: "T", keyPath: "/nonexistent/key.p8" }));
    });
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}) {
    return async (url: string, init: { headers: Record<string, string> }) => {
        seen.url = url;
        seen.headers = init.headers;

        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
}

async function failureOf(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (ex) {
        return (ex as AppleMusicError).failure;
    }

    return undefined;
}

describe("AppleMusicClient", () => {
    it("sends both tokens", async () => {
        const seen: { url?: string; headers?: Record<string, string> } = {};
        const client = new AppleMusicClient(() => "dev", fakeFetch(200, { data: [{ id: "gb" }] }, seen));

        assert.equal(await client.storefront("user"), "gb");
        assert.equal(seen.url, "https://api.music.apple.com/v1/me/storefront");
        assert.deepEqual(seen.headers, { Authorization: "Bearer dev", "Music-User-Token": "user" });
    });

    it("tells a listener's refused token from everything else", async () => {
        assert.equal(await failureOf(new AppleMusicClient(() => "dev", fakeFetch(403, {})).storefront("user")), "user-token");
        assert.equal(await failureOf(new AppleMusicClient(() => "dev", fakeFetch(429, {})).storefront("user")), "rate-limited");
        // A 401 is the developer token, which is not the listener's to fix
        assert.equal(await failureOf(new AppleMusicClient(() => "dev", fakeFetch(401, {})).storefront("user")), "unavailable");
        assert.equal(await failureOf(new AppleMusicClient(() => "dev", fakeFetch(500, {})).storefront("user")), "unavailable");
    });

    it("counts not reaching Apple as unavailable", async () => {
        const client = new AppleMusicClient(() => "dev", async () => { throw new Error("offline"); });

        assert.equal(await failureOf(client.recentlyPlayedTracks("user")), "unavailable");
    });

    it("refuses a storefront that is not one", async () => {
        const client = new AppleMusicClient(() => "dev", fakeFetch(200, { data: [{ id: "../x" }] }));

        assert.equal(await failureOf(client.storefront("user")), "unavailable");
    });

    it("asks the catalog only for catalog ids, in a storefront", async () => {
        const seen: { url?: string } = {};
        const client = new AppleMusicClient(() => "dev", fakeFetch(200, { data: [] }, seen));

        assert.deepEqual(await client.catalogSongs("us", ["i.abc", "../x"]), []);
        assert.equal(seen.url, undefined);

        await client.catalogSongs("us", ["1", "2"]);
        assert.equal(seen.url, "https://api.music.apple.com/v1/catalog/us/songs?ids=1,2&include=artists");
    });
});

describe("catalogIdOf", () => {
    it("is a catalog song's own id", () => {
        assert.equal(catalogIdOf({ id: "1440833098", type: "songs" }), "1440833098");
    });

    it("is the catalog id a library song names", () => {
        assert.equal(catalogIdOf({ id: "i.abc", type: "library-songs", attributes: { playParams: { catalogId: "123" } } }), "123");
    });

    it("is nothing for an upload, which only its owner could open", () => {
        assert.equal(catalogIdOf({ id: "i.abc", type: "library-songs", attributes: { playParams: { isLibrary: true } } }), undefined);
    });
});

describe("songDataFromAppleMusic", () => {
    const played: AppleMusicSongResource = {
        id: "i.abc",
        type: "library-songs",
        attributes: {
            name: "A Song",
            artistName: "An Artist",
            albumName: "An Album",
            durationInMillis: 200000,
            contentRating: "explicit",
            releaseDate: "2020-01-31",
            artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg" },
            playParams: { catalogId: "123" },
        },
    };

    const catalog: AppleMusicSongResource = {
        id: "123",
        type: "songs",
        attributes: { name: "A Song", isrc: "GBAAA2600001" },
        relationships: {
            artists: { data: [{ id: "900", attributes: { name: "An Artist" } }] },
            albums: { data: [{ id: "800" }] },
        },
    };

    it("is a Tempo song keyed by its catalog id, carrying the ISRC", () => {
        const song = songDataFromAppleMusic(played, catalog, 5)!;

        assert.equal(song.id, "am:123");
        assert.equal(song.isrc, "GBAAA2600001");
        assert.equal(song.duration, 200000);
        assert.equal(song.explicit, true);
        assert.equal(song.album.id, "am:800");
        assert.equal(song.album.releaseDate, Date.UTC(2020, 0, 31));
        assert.equal(song.meta.updatedAt, 5);
    });

    it("prefixes Apple's artist ids so they cannot collide with Spotify's", () => {
        assert.equal(songDataFromAppleMusic(played, catalog, 0)!.artists[0].id, "am:900");
    });

    it("still makes a song without the catalog's details", () => {
        const song = songDataFromAppleMusic(played, undefined, 0)!;

        assert.equal(song.id, "am:123");
        assert.equal(song.isrc, undefined);
        assert.equal(song.artists[0].name, "An Artist");
    });

    it("makes nothing of an upload", () => {
        assert.equal(songDataFromAppleMusic({ ...played, attributes: { ...played.attributes, playParams: {} } }, undefined, 0), undefined);
    });
});

describe("artworkAt", () => {
    it("fills in Apple's artwork template, so it loads anywhere", () => {
        assert.equal(artworkAt("https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}{c}.{f}", 600), "https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg");
    });

    it("leaves a filled-in URL alone", () => {
        assert.equal(artworkAt("https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg", 600), "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg");
    });
});

describe("songDataFromAppleMusic artwork", () => {
    it("stores artwork filled in", () => {
        const song = songDataFromAppleMusic(
            { id: "123", type: "songs", attributes: { name: "S", artwork: { url: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg" } } },
            undefined, 0)!;

        assert.equal(song.album.artUrl, "https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg");
    });
});
