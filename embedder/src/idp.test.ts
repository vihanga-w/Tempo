import { strict as assert } from "node:assert";
import { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";

import { challengeOf, checkRequest, Codes, IDP_GRANTS, IDP_USERS, IdentityUser, IdpDeps, parseClients, registerIdp, sha256 } from "./idp";

const SECRET = "lilt-secret";
const REDIRECT = "https://lilt.example/spotify/link/callback";
const clients = parseClients(JSON.stringify([{ id: "lilt", name: "Lilt", secretSha256: sha256(SECRET), redirectUris: [REDIRECT] }]));
const VERIFIER = "v".repeat(50);
const request = { client_id: "lilt", redirect_uri: REDIRECT, state: "s1", code_challenge: challengeOf(VERIFIER) };
const BYO = { clientId: "a".repeat(32), clientSecret: "b".repeat(32) };

/** The store as a map of collection/id → document, with the paths DataStore takes. */
class MemStore {
    docs = new Map<string, any>();
    async get<T>(c: string, path?: string) { return (this.docs.get(`${c}/${path}`) ?? null) as T | null; }
    async set<T>(c: string, path?: string, value?: T) { this.docs.set(`${c}/${path}`, structuredClone(value)); return true; }
    async update<T>(c: string, path?: string, value?: Partial<T>) { this.docs.set(`${c}/${path}`, { ...this.docs.get(`${c}/${path}`), ...structuredClone(value) }); return true; }
    async idWhere(c: string, field: string, value: string) {
        for (const [k, v] of this.docs) {
            if (!k.startsWith(c + "/"))
                continue;

            if (field.split(".").reduce((o: any, f) => o?.[f], v) === value)
                return k.slice(c.length + 1);
        }

        return null;
    }
}

interface Call { url: string; init?: RequestInit }

/** Spotify as a script: each URL answers with the next of its responses. */
function fakeSpotify(script: Record<string, (() => Response)[]>) {
    const calls: Call[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);

        calls.push({ url: u, init });

        const key = Object.keys(script).find(k => u.startsWith(k));
        const next = key ? script[key]!.shift() : undefined;

        if (!next)
            throw new Error("unexpected call " + u);

        return next();
    }) as typeof fetch;

    return { fetch: f, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup(over: Partial<IdpDeps> & { fetch: typeof fetch }) {
    const db = new MemStore();
    let pending: ((code: string | undefined) => Promise<string>) | null = null;
    let clock = 1_000_000;
    const app = express();

    app.use(express.json());

    const deps: IdpDeps = {
        db,
        clients,
        webAppUrl: "https://tempo.example",
        spotifyRedirectUri: "https://tempo-be.example/spotify/callback",
        tempoClientId: "c".repeat(32),
        tempoClientSecret: "d".repeat(32),
        signedIn: async () => false,
        tempoIdForSpotifyUser: async () => undefined,
        accountOf: async () => null,
        monitorToken: async () => null,
        startSpotifySignIn: (cb) => { pending = cb; return "st"; },
        credentialsState: async () => "ok",
        now: () => clock,
        ...over,
    };
    const { playback } = registerIdp(app as never, deps);

    app.get("/idp/playback", (req, res) => void playback(req, res));

    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, init?: RequestInit) => globalThis.fetch(base + path, init);
    const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    return {
        db, call, post, close: () => server.close(),
        advance: (ms: number) => { clock += ms; },
        /** Spotify came back to /spotify/callback with this code. */
        callback: (code: string | undefined) => { assert.ok(pending, "no sign-in was started"); return pending!(code); },
    };
}

/** Start, come back from Spotify, trade the code: the grant token. */
async function connect(t: Awaited<ReturnType<typeof setup>>, creds: Record<string, string> = BYO) {
    const start = await t.post("/idp/spotify/start", { request, ...creds });

    assert.equal(start.status, 200, await start.clone().text());

    const back = new URL(await t.callback("spotify-code"));
    const code = back.searchParams.get("code");

    assert.ok(code, "no code in " + back);
    assert.equal(back.searchParams.get("state"), "s1");

    const tok = await t.post("/idp/token", { grant_type: "authorization_code", code, client_id: "lilt", client_secret: SECRET, redirect_uri: REDIRECT, code_verifier: VERIFIER });

    assert.equal(tok.status, 200);

    return (await tok.json() as { access_token: string }).access_token;
}

const signIn = () => ({
    "https://accounts.spotify.com/api/token": [json(200, { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "user-read-playback-state user-read-currently-playing" })],
    "https://api.spotify.com/v1/me/player": [json(200, { is_playing: true, progress_ms: 61234, item: { type: "track", uri: "spotify:track:x", id: "x", name: "Song", artists: [{ name: "Artist" }], duration_ms: 200000 }, device: { name: "iPhone", type: "Smartphone" } })],
    "https://api.spotify.com/v1/me": [json(200, { id: "spot1", display_name: "Vee" })],
});

describe("checkRequest", () => {
    it("takes a registered app at its exact redirect", () => {
        assert.equal(checkRequest(clients, request).ok, true);
    });

    it("refuses an unknown app, another redirect, a plain challenge, no state", () => {
        assert.equal(checkRequest(clients, { ...request, client_id: "x" }).ok, false);
        assert.equal(checkRequest(clients, { ...request, redirect_uri: REDIRECT + "/x" }).ok, false);
        assert.equal(checkRequest(clients, { ...request, code_challenge: "short" }).ok, false);
        assert.equal(checkRequest(clients, { ...request, state: "" }).ok, false);
    });

    it("parses no clients from bad config instead of throwing", () => {
        assert.equal(parseClients("{nope").size, 0);
        assert.equal(parseClients(JSON.stringify([{ id: "x", secretSha256: "short", redirectUris: [] }])).size, 0);
    });
});

describe("Codes", () => {
    const ok = checkRequest(clients, request);

    assert.ok(ok.ok);

    it("is spent by one redemption", () => {
        const codes = new Codes(), c = codes.mint(ok.req, "spot1", "Vee", false);

        assert.equal(typeof codes.redeem(c, "lilt", REDIRECT, VERIFIER), "object");
        assert.equal(codes.redeem(c, "lilt", REDIRECT, VERIFIER), "invalid_grant");
    });

    it("refuses a wrong verifier, and the code is gone after it", () => {
        const codes = new Codes(), c = codes.mint(ok.req, "spot1", "Vee", false);

        assert.equal(codes.redeem(c, "lilt", REDIRECT, "w".repeat(50)), "invalid_grant");
        assert.equal(codes.redeem(c, "lilt", REDIRECT, VERIFIER), "invalid_grant");
    });

    it("refuses another app or redirect, and an expired code", () => {
        let t = 0;
        const codes = new Codes(() => t);

        assert.equal(codes.redeem(codes.mint(ok.req, "s", "n", false), "other", REDIRECT, VERIFIER), "invalid_grant");
        assert.equal(codes.redeem(codes.mint(ok.req, "s", "n", false), "lilt", REDIRECT + "x", VERIFIER), "invalid_grant");

        const c = codes.mint(ok.req, "s", "n", false);

        t += 5 * 60e3 + 1;
        assert.equal(codes.redeem(c, "lilt", REDIRECT, VERIFIER), "invalid_grant");
    });
});

describe("connect and read playback", () => {
    it("makes an identity-only account, asks Spotify only for playback, and relays it", async () => {
        const sp = fakeSpotify(signIn());
        const t = await setup({ fetch: sp.fetch });

        try {
            const start = await t.post("/idp/spotify/start", { request, ...BYO });
            const authUrl = new URL((await start.json() as { authUrl: string }).authUrl);

            assert.equal(authUrl.searchParams.get("client_id"), BYO.clientId);
            assert.equal(authUrl.searchParams.get("scope"), "user-read-playback-state user-read-currently-playing");

            const back = new URL(await t.callback("spotify-code"));
            const tok = await t.post("/idp/token", { grant_type: "authorization_code", code: back.searchParams.get("code"), client_id: "lilt", client_secret: SECRET, redirect_uri: REDIRECT, code_verifier: VERIFIER });
            const grant = (await tok.json() as { access_token: string }).access_token;

            const user = await t.db.get<IdentityUser>(IDP_USERS, "spot1");

            assert.equal(user?.serverCreds.clientSecret, BYO.clientSecret);
            assert.equal(user?.data.refreshToken, "rt1");
            // Only the hash of a grant is stored
            assert.equal(await t.db.get(IDP_GRANTS, grant), null);
            assert.ok(await t.db.get(IDP_GRANTS, sha256(grant)));

            const pb = await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } });
            const body = await pb.json() as { playing: boolean; progressMs: number; item: { name: string; artists: string[] }; device: { type: string } };

            assert.equal(pb.status, 200);
            assert.deepEqual([body.playing, body.progressMs, body.item.name, body.item.artists, body.device.type], [true, 61234, "Song", ["Artist"], "Smartphone"]);

            // Within the interval: the last reading again, no Spotify call
            const again = await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } });

            assert.equal((await again.json() as { cached?: boolean }).cached, true);
            assert.equal(sp.calls.filter(c => c.url.includes("/me/player")).length, 1);
        } finally {
            t.close();
        }
    });

    it("refuses a grant once the app disconnects", async () => {
        const sp = fakeSpotify(signIn());
        const t = await setup({ fetch: sp.fetch });

        try {
            const grant = await connect(t);
            const del = await t.call("/idp/grant", { method: "DELETE", headers: { authorization: `Bearer ${grant}` } });

            assert.equal(del.status, 200);
            assert.equal((await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } })).status, 401);
        } finally {
            t.close();
        }
    });

    it("leaves a Tempo user's account alone and reads with its monitor's token", async () => {
        const sp = fakeSpotify(signIn());
        const t = await setup({
            fetch: sp.fetch,
            tempoIdForSpotifyUser: async (id) => id === "spot1" ? "tempo1" : undefined,
            accountOf: async () => ({ spotifyId: "spot1", name: "Vee", ownApp: true }),
            monitorToken: async () => "monitor-token",
        });

        try {
            const grant = await connect(t);

            assert.equal(await t.db.get(IDP_USERS, "spot1"), null);

            await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } });

            const read = sp.calls.find(c => c.url.includes("/me/player"));

            assert.equal(new Headers(read?.init?.headers).get("authorization"), "Bearer monitor-token");
        } finally {
            t.close();
        }
    });

    it("takes a client ID alone for an app Tempo already holds the secret for", async () => {
        const sp = fakeSpotify(signIn());
        const t = await setup({ fetch: sp.fetch });

        try {
            await t.db.set(IDP_USERS, "spot1", { spotifyId: "spot1", serverCreds: BYO, data: {} });
            await connect(t, { clientId: BYO.clientId });

            const exchange = sp.calls.find(c => c.url === "https://accounts.spotify.com/api/token");

            assert.equal(new Headers(exchange?.init?.headers).get("authorization"), "Basic " + Buffer.from(`${BYO.clientId}:${BYO.clientSecret}`).toString("base64"));
        } finally {
            t.close();
        }
    });

    it("asks for the secret when Tempo does not know the app", async () => {
        const t = await setup({ fetch: fakeSpotify({}).fetch });

        try {
            assert.equal((await t.post("/idp/spotify/start", { request, clientId: BYO.clientId })).status, 400);
        } finally {
            t.close();
        }
    });

    it("sends someone not listed on their own app back to that step", async () => {
        const sp = fakeSpotify({ ...signIn(), "https://api.spotify.com/v1/me": [json(403, { error: { status: 403 } })] });
        const t = await setup({ fetch: sp.fetch });

        try {
            await t.post("/idp/spotify/start", { request, ...BYO });

            const back = new URL(await t.callback("spotify-code"));

            assert.equal(back.origin + back.pathname, "https://tempo.example/connect");
            assert.equal(back.searchParams.get("error"), "user-management");
            assert.equal(back.searchParams.get("client_id"), "lilt");
        } finally {
            t.close();
        }
    });

    it("does not make an identity account on Tempo's own app", async () => {
        const sp = fakeSpotify(signIn());
        const t = await setup({ fetch: sp.fetch });

        try {
            await t.post("/idp/spotify/start", { request });

            const back = new URL(await t.callback("spotify-code"));

            assert.equal(back.searchParams.get("error"), "tempo-full");
            assert.equal(await t.db.get(IDP_USERS, "spot1"), null);
        } finally {
            t.close();
        }
    });

    it("goes back to the app with access_denied when the person says no on Spotify", async () => {
        const t = await setup({ fetch: fakeSpotify({}).fetch });

        try {
            await t.post("/idp/spotify/start", { request, ...BYO });

            const back = new URL(await t.callback(undefined));

            assert.equal(back.origin + back.pathname, "https://lilt.example/spotify/link/callback");
            assert.equal(back.searchParams.get("error"), "access_denied");
        } finally {
            t.close();
        }
    });

    it("refuses a token request with the wrong app secret", async () => {
        const t = await setup({ fetch: fakeSpotify({}).fetch });

        try {
            const r = await t.post("/idp/token", { grant_type: "authorization_code", code: "x", client_id: "lilt", client_secret: "nope", redirect_uri: REDIRECT, code_verifier: VERIFIER });

            assert.equal(r.status, 401);
        } finally {
            t.close();
        }
    });

    it("refreshes an expired identity token and keeps a rotated refresh token", async () => {
        const sp = fakeSpotify({
            ...signIn(),
            "https://accounts.spotify.com/api/token": [
                json(200, { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "s" }),
                json(200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
            ],
        });
        const t = await setup({ fetch: sp.fetch });

        try {
            const grant = await connect(t);

            t.advance(3600e3);

            const pb = await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } });

            assert.equal(pb.status, 200);

            const user = await t.db.get<IdentityUser>(IDP_USERS, "spot1");

            assert.deepEqual([user?.data.accessToken, user?.data.refreshToken], ["at2", "rt2"]);
            assert.equal(new Headers(sp.calls.find(c => c.url.includes("/me/player"))?.init?.headers).get("authorization"), "Bearer at2");
        } finally {
            t.close();
        }
    });

    it("passes Spotify's rate limit on without retrying", async () => {
        const sp = fakeSpotify({ ...signIn(), "https://api.spotify.com/v1/me/player": [() => new Response("", { status: 429, headers: { "retry-after": "7" } })] });
        const t = await setup({ fetch: sp.fetch });

        try {
            const grant = await connect(t);
            const pb = await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } });

            assert.equal(pb.status, 429);
            assert.equal((await pb.json() as { retryAfter: number }).retryAfter, 7);
        } finally {
            t.close();
        }
    });
});

describe("audit fixes", () => {
    it("ties the Spotify sign-in to this browser and always shows Spotify's consent", async () => {
        const t = await setup({ fetch: fakeSpotify({}).fetch });

        try {
            const r = await t.post("/idp/spotify/start", { request, ...BYO });
            const cookie = r.headers.get("set-cookie") ?? "";
            const authUrl = new URL((await r.json() as { authUrl: string }).authUrl);

            assert.match(cookie, /^tempo_idp_nonce=[A-Za-z0-9_-]{32};/);
            assert.match(cookie, /HttpOnly/);
            assert.match(cookie, /Path=\/spotify\/callback/);
            assert.equal(authUrl.searchParams.get("show_dialog"), "true");
        } finally {
            t.close();
        }
    });

    it("uses a saved app's secret only for the account it was saved for", async () => {
        const sp = fakeSpotify({ ...signIn(), "https://api.spotify.com/v1/me": [json(200, { id: "someone-else", display_name: "X" })] });
        const t = await setup({ fetch: sp.fetch });

        try {
            await t.db.set(IDP_USERS, "spot1", { spotifyId: "spot1", serverCreds: BYO, data: { accessToken: "old" } });
            await t.post("/idp/spotify/start", { request, clientId: BYO.clientId });

            const back = new URL(await t.callback("spotify-code"));

            assert.equal(back.searchParams.get("error"), "not-your-app");
            assert.equal(back.searchParams.get("code"), null);
            assert.equal(await t.db.get(IDP_USERS, "someone-else"), null);
            assert.equal((await t.db.get<IdentityUser>(IDP_USERS, "spot1"))?.data.accessToken, "old");
        } finally {
            t.close();
        }
    });

    it("refuses an address that keeps sending made-up grants, without a database read each", async () => {
        const t = await setup({ fetch: fakeSpotify({}).fetch });
        let reads = 0;
        const get = t.db.get.bind(t.db);

        t.db.get = (async (c: string, p?: string) => { reads++; return get(c, p); }) as typeof t.db.get;

        try {
            let last = 0;

            for (let i = 0; i < 35; i++)
                last = (await t.call("/idp/playback", { headers: { authorization: `Bearer ${"x".repeat(42)}${i % 10}` } })).status;

            assert.equal(last, 429);
            assert.equal(reads, 30);
        } finally {
            t.close();
        }
    });

    it("says how old a reading is, so the app need not share Tempo's clock", async () => {
        const t = await setup({ fetch: fakeSpotify(signIn()).fetch });

        try {
            const grant = await connect(t);

            const first = await (await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } })).json() as { ageMs: number };

            assert.equal(first.ageMs, 0);
            t.advance(400);

            const again = await (await t.call("/idp/playback", { headers: { authorization: `Bearer ${grant}` } })).json() as { ageMs: number; cached?: boolean };

            assert.deepEqual([again.cached, again.ageMs], [true, 400]);
        } finally {
            t.close();
        }
    });
});
