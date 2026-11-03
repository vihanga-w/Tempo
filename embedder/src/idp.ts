/**
 * Tempo as a sign-in and Spotify connection for other apps (Lilt first).
 *
 * Spotify admits five listeners to an app in development mode, so an app such
 * as Lilt cannot hold one Spotify app for everybody. Tempo already gets each
 * person set up with a Spotify app of their own; this lets another app borrow
 * that connection instead of making people do it twice.
 *
 * The flow is OAuth's authorisation code with PKCE:
 *   1. The app sends the person to Tempo's /connect page with its client id,
 *      redirect URI, state and code challenge.
 *   2. The page either asks a signed-in Tempo user to agree (POST
 *      /idp/authorize), or signs the person in with Spotify (POST
 *      /idp/spotify/start, then Tempo's usual /spotify/callback).
 *   3. Tempo sends them back to the app with a one-time code, which the app's
 *      server trades for a grant at POST /idp/token.
 *   4. The app's server reads that person's playback through GET /idp/playback.
 *      Spotify's tokens never leave Tempo, and the grant can do nothing else.
 *
 * People who arrive this way without a Tempo account get an identity-only
 * record in a collection of its own (idp_users), not in "users": none of
 * Tempo's social features (friends, search, leaderboards, feeds, playback
 * polling) read that collection, so they are not on Tempo in any visible sense.
 * If they later sign up for Tempo itself, the grant follows their Spotify id to
 * the full account, and /spotify/byo/start can reuse the app they already made.
 *
 * Grants are random tokens stored only as their SHA-256, each revocable alone.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Application, Request, Response } from "express";

/** The scopes an identity-only sign-in asks Spotify for: reading playback, nothing else. */
export const IDP_SPOTIFY_SCOPES = ["user-read-playback-state", "user-read-currently-playing"].join(" ");
/** What a grant allows. One scope for now. */
export const PLAYBACK_SCOPE = "playback:read";

const CODE_TTL_MS = 5 * 60e3;
const GRANT_CACHE_MS = 30e3;
/** The fastest a grant may read playback: its own Spotify app's quota, or Tempo's shared one. */
export const OWN_APP_MIN_MS = 900;
export const TEMPO_APP_MIN_MS = 5000;

export interface IdpClient { id: string; name: string; secretSha256: string; redirectUris: string[] }

/** IDP_CLIENTS: a JSON list of {id, name, secretSha256, redirectUris}. Absent or bad: no clients. */
export function parseClients(raw: string | undefined): Map<string, IdpClient> {
    const out = new Map<string, IdpClient>();

    if (!raw)
        return out;

    try {
        for (const c of JSON.parse(raw) as IdpClient[]) {
            if (typeof c?.id === "string" && /^[a-f0-9]{64}$/.test(c.secretSha256) && Array.isArray(c.redirectUris) && c.redirectUris.every(u => typeof u === "string"))
                out.set(c.id, { id: c.id, name: String(c.name || c.id).slice(0, 40), secretSha256: c.secretSha256, redirectUris: c.redirectUris });
        }
    } catch (ex) {
        console.error("IDP_CLIENTS is not valid JSON; no apps can connect:", (ex as Error).message);
    }

    return out;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** PKCE S256: the challenge a verifier makes. */
export const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

function sameHex(a: string, b: string) {
    const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");

    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** What the app asked for, checked against its registration. Exact redirect URI match only. */
export interface ConnectRequest { clientId: string; redirectUri: string; state: string; codeChallenge: string }
export function checkRequest(clients: Map<string, IdpClient>, body: unknown): { ok: true; req: ConnectRequest; client: IdpClient } | { ok: false; why: string } {
    const b = (body ?? {}) as Record<string, unknown>;
    const clientId = typeof b.client_id === "string" ? b.client_id : "";
    const redirectUri = typeof b.redirect_uri === "string" ? b.redirect_uri : "";
    const state = typeof b.state === "string" ? b.state : "";
    const codeChallenge = typeof b.code_challenge === "string" ? b.code_challenge : "";
    const client = clients.get(clientId);

    if (!client)
        return { ok: false, why: "unknown app" };

    if (!client.redirectUris.includes(redirectUri))
        return { ok: false, why: "redirect not registered for this app" };

    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
        return { ok: false, why: "code_challenge must be an S256 challenge" };

    if (!state || state.length > 200)
        return { ok: false, why: "state is required" };

    return { ok: true, req: { clientId, redirectUri, state, codeChallenge }, client };
}

/** Where to send the person back to, with a code or an error. */
export function backTo(redirectUri: string, params: Record<string, string>) {
    const url = new URL(redirectUri);

    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);

    return url.toString();
}

// ---- one-time codes (in memory: a code lives five minutes, a restart just means signing in again) ----
interface PendingCode { req: ConnectRequest; spotifyId: string; name: string; tempoApp: boolean; expires: number }

export class Codes {
    private codes = new Map<string, PendingCode>();

    constructor(private now: () => number = Date.now) { }

    mint(req: ConnectRequest, spotifyId: string, name: string, tempoApp: boolean) {
        for (const [k, v] of this.codes)
            if (v.expires < this.now())
                this.codes.delete(k);

        const code = b64url(randomBytes(32));

        this.codes.set(sha256(code), { req, spotifyId, name, tempoApp, expires: this.now() + CODE_TTL_MS });

        return code;
    }

    /** Spends a code: once, by the app it was issued to, at the redirect it was issued for, with the matching verifier. */
    redeem(code: string, clientId: string, redirectUri: string, verifier: string): PendingCode | string {
        const key = sha256(code), p = this.codes.get(key);

        if (!p || p.expires < this.now())
            return "invalid_grant";

        // Spent even when the rest is wrong: a code someone else holds is worth one try.
        this.codes.delete(key);

        if (p.req.clientId !== clientId || p.req.redirectUri !== redirectUri)
            return "invalid_grant";

        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challengeOf(verifier) !== p.req.codeChallenge)
            return "invalid_grant";

        return p;
    }
}

// ---- storage ----
export interface IdpStore {
    get<T>(collectionId: string, path?: string, notNull?: boolean, dontFail?: boolean): Promise<T | null>;
    set<T>(collectionId: string, path?: string, value?: T): Promise<unknown>;
    update<T>(collectionId: string, path?: string, value?: Partial<T>): Promise<unknown>;
    idWhere(collectionId: string, field: string, value: string): Promise<string | null>;
}

/** A person known to Tempo only through another app. */
export interface IdentityUser {
    spotifyId: string;
    displayName: string;
    data: { accessToken: string; refreshToken: string; expires: number; scope: string };
    serverCreds: { clientId: string; clientSecret: string };
    createdAt: number;
    updatedAt: number;
}

export interface Grant {
    client: string;
    spotifyId: string;
    scope: string;
    name: string;
    /** Signed in through Tempo's own Spotify app (a shared quota), not the person's. */
    tempoApp: boolean;
    createdAt: number;
    revokedAt?: number;
}

export const IDP_USERS = "idp_users", IDP_GRANTS = "idp_grants";

// ---- playback ----
export interface Playback {
    playing: boolean;
    progressMs: number;
    /** When Tempo read it (ms since the epoch, the middle of the round trip). */
    sampledAt: number;
    item: { uri: string; id: string; name: string; artists: string[]; durationMs: number } | null;
    device: { name: string; type: string } | null;
}

export function toPlayback(json: any, sampledAt: number): Playback {
    const item = json?.item && json.item.type !== "episode" ? json.item : null;

    return {
        playing: !!json?.is_playing,
        progressMs: Number(json?.progress_ms ?? 0),
        sampledAt,
        item: item ? { uri: String(item.uri), id: String(item.id), name: String(item.name), artists: (item.artists ?? []).map((a: { name: string }) => String(a.name)), durationMs: Number(item.duration_ms ?? 0) } : null,
        device: json?.device ? { name: String(json.device.name ?? ""), type: String(json.device.type ?? "") } : null,
    };
}

/** Per grant: at most one read in flight, and none sooner than the grant's interval; callers in between get the last one. */
export class PlaybackGate {
    private last = new Map<string, { at: number; value: Playback; status: number }>();
    private inflight = new Map<string, Promise<{ status: number; value: Playback | { error: string; retryAfter?: number } }>>();

    constructor(private now: () => number = Date.now) { }

    async read(key: string, minMs: number, fetcher: () => Promise<{ status: number; value: Playback | { error: string; retryAfter?: number } }>) {
        const last = this.last.get(key);

        if (last && this.now() - last.at < minMs)
            return { status: last.status, value: { ...last.value, cached: true } };

        const running = this.inflight.get(key);

        if (running)
            return running;

        const p = fetcher().then(r => {
            if (r.status === 200)
                this.last.set(key, { at: this.now(), value: r.value as Playback, status: 200 });

            return r;
        }).finally(() => this.inflight.delete(key));

        this.inflight.set(key, p);

        return p;
    }
}

// ---- the routes ----
export interface IdpDeps {
    db: IdpStore;
    clients: Map<string, IdpClient>;
    webAppUrl: string;
    spotifyRedirectUri: string;
    tempoClientId: string;
    tempoClientSecret: string;
    /** Tempo's sign-in (cookie or header), as the rest of the API checks it. */
    signedIn: (req: Request) => Promise<{ id: string; username: string } | false | undefined>;
    /** The Tempo account for a Spotify id, if there is one. */
    tempoIdForSpotifyUser: (spotifyId: string) => Promise<string | undefined>;
    /** A full account's Spotify id and name. */
    accountOf: (tempoId: string) => Promise<{ spotifyId: string; name: string; ownApp: boolean } | null>;
    /** A full account's current Spotify access token, from its running monitor. */
    monitorToken: (tempoId: string) => Promise<string | null>;
    /** Registers a Spotify sign-in with Tempo's /spotify/callback; returns its state. */
    startSpotifySignIn: (cb: (code: string | undefined) => Promise<string>) => string;
    /** Whether a client id and secret are a working Spotify app. */
    credentialsState: (clientId: string, clientSecret: string) => Promise<"valid" | "rejected" | "unreachable" | string>;
    fetch?: typeof fetch;
    now?: () => number;
}

export function registerIdp(app: Application, deps: IdpDeps) {
    const codes = new Codes(deps.now);
    const gate = new PlaybackGate(deps.now);
    const now = deps.now ?? Date.now;
    const http = deps.fetch ?? fetch;
    const grantCache = new Map<string, { at: number; grant: Grant | null }>();

    const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: true, message });

    async function grantFor(req: Request): Promise<{ key: string; grant: Grant } | null> {
        const h = req.headers.authorization ?? "";
        const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";

        if (!/^[A-Za-z0-9_-]{43}$/.test(token))
            return null;

        const key = sha256(token), hit = grantCache.get(key);
        let grant = hit && now() - hit.at < GRANT_CACHE_MS ? hit.grant : undefined;

        if (grant === undefined) {
            grant = await deps.db.get<Grant>(IDP_GRANTS, key, false, true);
            grantCache.set(key, { at: now(), grant });
        }

        return grant && !grant.revokedAt ? { key, grant } : null;
    }

    async function mintGrant(p: { req: ConnectRequest; spotifyId: string; name: string; tempoApp: boolean }) {
        const token = b64url(randomBytes(32));
        const grant: Grant = { client: p.req.clientId, spotifyId: p.spotifyId, scope: PLAYBACK_SCOPE, name: p.name, tempoApp: p.tempoApp, createdAt: now() };

        await deps.db.set<Grant>(IDP_GRANTS, sha256(token), grant);

        return token;
    }

    /** The app asking, for the connect page to name it. */
    app.get("/idp/client", (req, res) => {
        const checked = checkRequest(deps.clients, req.query);

        if (!checked.ok)
            return fail(res, 400, checked.why);

        res.json({ error: false, name: checked.client.name, redirectUri: deps.spotifyRedirectUri });
    });

    /** Whether the person is signed in to Tempo here, for the connect page. */
    app.get("/idp/session", async (req, res) => {
        const who = await deps.signedIn(req);
        const account = who ? await deps.accountOf(who.id) : null;

        res.json({ error: false, signedIn: !!account, name: account?.name ?? null });
    });

    /** A signed-in Tempo user agrees: back to the app with a code. */
    app.post("/idp/authorize", async (req, res) => {
        const checked = checkRequest(deps.clients, req.body);

        if (!checked.ok)
            return fail(res, 400, checked.why);

        const who = await deps.signedIn(req);
        const account = who ? await deps.accountOf(who.id) : null;

        if (!account)
            return fail(res, 403, "Sign in to Tempo first");

        const code = codes.mint(checked.req, account.spotifyId, account.name, !account.ownApp);

        res.json({ error: false, redirect: backTo(checked.req.redirectUri, { code, state: checked.req.state }) });
    });

    /**
     * Sign in with Spotify for the app.
     *
     * No client id: Tempo's own app (for its first few listeners). A client id
     * alone: an app Tempo already holds the secret for (the person set it up
     * here before, for Tempo or another app). Both: a new app of their own,
     * checked with Spotify before they are sent there.
     */
    app.post("/idp/spotify/start", async (req, res) => {
        const checked = checkRequest(deps.clients, req.body?.request);

        if (!checked.ok)
            return fail(res, 400, checked.why);

        const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
        let clientSecret = typeof req.body?.clientSecret === "string" ? req.body.clientSecret.trim() : "";

        if (clientId && !/^[a-f0-9]{32}$/i.test(clientId))
            return fail(res, 400, "That does not look like a Spotify client ID: it is a 32-character code from your app's page.");

        if (clientSecret && !/^[a-f0-9]{32}$/i.test(clientSecret))
            return fail(res, 400, "That does not look like a Spotify client secret: it is a 32-character code under \"View client secret\".");

        if (clientId && !clientSecret) {
            // Someone who set the app up before: Tempo has its secret.
            const known = await deps.db.idWhere(IDP_USERS, "serverCreds.clientId", clientId)
                .then(id => id ? deps.db.get<IdentityUser>(IDP_USERS, id, false, true) : null).catch(() => null);
            const full = known ? null : await deps.db.idWhere("users", "serverCreds.clientId", clientId)
                .then(id => id ? deps.db.get<{ serverCreds?: { clientSecret?: string } }>("users", id, false, true) : null).catch(() => null);

            clientSecret = known?.serverCreds.clientSecret ?? full?.serverCreds?.clientSecret ?? "";

            if (!clientSecret)
                return fail(res, 400, "Tempo does not know that app yet. Paste its client secret too.");
        } else if (clientId) {
            const state = await deps.credentialsState(clientId, clientSecret);

            if (state === "rejected")
                return fail(res, 400, "Spotify rejected those. Check the client ID and secret are from the same app.");

            if (state === "unreachable")
                return fail(res, 502, "Could not reach Spotify to check those. Try again.");
        }

        const creds = clientId ? { clientId, clientSecret } : { clientId: deps.tempoClientId, clientSecret: deps.tempoClientSecret };
        const tempoApp = !clientId;
        const retry = (error: string) => `${deps.webAppUrl}/connect?${new URLSearchParams({ client_id: checked.req.clientId, redirect_uri: checked.req.redirectUri, state: checked.req.state, code_challenge: checked.req.codeChallenge, error })}`;

        const spotifyState = deps.startSpotifySignIn(async (code) => {
            if (!code)
                return backTo(checked.req.redirectUri, { error: "access_denied", state: checked.req.state });

            try {
                const tok = await http("https://accounts.spotify.com/api/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64") },
                    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: deps.spotifyRedirectUri }),
                });

                if (!tok.ok)
                    return retry("spotify");

                const t = await tok.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
                const meRes = await http("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${t.access_token}` } });

                // Their own app in development mode serves only the accounts
                // listed on it, its owner included: one step from working.
                if (meRes.status === 403)
                    return retry(tempoApp ? "tempo-full" : "user-management");

                if (!meRes.ok)
                    return retry("spotify");

                const me = await meRes.json() as { id: string; display_name?: string };
                const name = (me.display_name || me.id).slice(0, 80);

                // Somebody on Tempo already: their account is untouched, the
                // grant follows their Spotify id to it.
                if (!(await deps.tempoIdForSpotifyUser(me.id))) {
                    if (tempoApp)
                        return retry("tempo-full"); // identity-only accounts always have their own app

                    const prev = await deps.db.get<IdentityUser>(IDP_USERS, me.id, false, true);
                    const doc: IdentityUser = {
                        spotifyId: me.id,
                        displayName: name,
                        data: { accessToken: t.access_token, refreshToken: t.refresh_token, expires: now() + t.expires_in * 1e3, scope: t.scope },
                        serverCreds: creds,
                        createdAt: prev?.createdAt ?? now(),
                        updatedAt: now(),
                    };

                    await deps.db.set<IdentityUser>(IDP_USERS, me.id, doc);
                }

                const out = codes.mint(checked.req, me.id, name, tempoApp);

                return backTo(checked.req.redirectUri, { code: out, state: checked.req.state });
            } catch (ex) {
                console.error("Connect sign-in failed:", (ex as Error).message);

                return retry("spotify");
            }
        });

        const url = new URL("https://accounts.spotify.com/authorize");

        url.search = new URLSearchParams({ client_id: creds.clientId, response_type: "code", redirect_uri: deps.spotifyRedirectUri, scope: IDP_SPOTIFY_SCOPES, state: spotifyState }).toString();
        res.json({ error: false, authUrl: url.toString() });
    });

    /** The app's server trades a code for a grant. */
    app.post("/idp/token", async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const client = deps.clients.get(String(b.client_id ?? ""));

        if (!client || typeof b.client_secret !== "string" || !sameHex(sha256(b.client_secret), client.secretSha256))
            return res.status(401).json({ error: "invalid_client" });

        if (b.grant_type !== "authorization_code" || typeof b.code !== "string" || typeof b.redirect_uri !== "string" || typeof b.code_verifier !== "string")
            return res.status(400).json({ error: "invalid_request" });

        const p = codes.redeem(b.code, client.id, b.redirect_uri, b.code_verifier);

        if (typeof p === "string")
            return res.status(400).json({ error: p });

        const token = await mintGrant(p);

        res.json({ access_token: token, token_type: "Bearer", scope: PLAYBACK_SCOPE, name: p.name, spotify_id: p.spotifyId });
    });

    /** Who the grant is for. */
    app.get("/idp/me", async (req, res) => {
        const g = await grantFor(req);

        if (!g)
            return res.status(401).json({ error: "invalid_token" });

        res.json({ name: g.grant.name, spotifyId: g.grant.spotifyId, scope: g.grant.scope, tempoUser: !!(await deps.tempoIdForSpotifyUser(g.grant.spotifyId)) });
    });

    /** The app disconnects: this grant stops working at once. */
    app.delete("/idp/grant", async (req, res) => {
        const g = await grantFor(req);

        if (!g)
            return res.status(401).json({ error: "invalid_token" });

        await deps.db.update<Grant>(IDP_GRANTS, g.key, { revokedAt: now() });
        grantCache.delete(g.key);
        res.json({ error: false });
    });

    /** An identity-only account's access token, refreshed when due (one refresh at a time per person). */
    const refreshing = new Map<string, Promise<string | null>>();
    async function identityToken(spotifyId: string, force = false): Promise<string | null> {
        const doc = await deps.db.get<IdentityUser>(IDP_USERS, spotifyId, false, true);

        if (!doc)
            return null;

        if (!force && doc.data.expires - now() > 60e3)
            return doc.data.accessToken;

        const running = refreshing.get(spotifyId);

        if (running)
            return running;

        const p = (async () => {
            const r = await http("https://accounts.spotify.com/api/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${doc.serverCreds.clientId}:${doc.serverCreds.clientSecret}`).toString("base64") },
                body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: doc.data.refreshToken }),
            });

            if (!r.ok)
                return null;

            const t = await r.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

            await deps.db.update<IdentityUser>(IDP_USERS, spotifyId, {
                data: { accessToken: t.access_token, refreshToken: t.refresh_token || doc.data.refreshToken, expires: now() + t.expires_in * 1e3, scope: t.scope ?? doc.data.scope },
                updatedAt: now(),
            });

            return t.access_token;
        })().catch(() => null).finally(() => refreshing.delete(spotifyId));

        refreshing.set(spotifyId, p);

        return p;
    }

    /**
     * The person's playback, read from Spotify now (or at most the grant's
     * interval ago). Registered by the caller ahead of the API's per-address
     * rate limits: an app's server reads for many people from one address, and
     * the per-grant interval is the limit here.
     */
    async function playback(req: Request, res: Response) {
        const g = await grantFor(req);

        if (!g)
            return res.status(401).json({ error: "invalid_token" });

        const tempoId = await deps.tempoIdForSpotifyUser(g.grant.spotifyId);
        const full = tempoId ? await deps.accountOf(tempoId) : null;
        const ownApp = full ? full.ownApp : !g.grant.tempoApp;

        const r = await gate.read(g.key, ownApp ? OWN_APP_MIN_MS : TEMPO_APP_MIN_MS, async () => {
            const read = async (token: string) => {
                const t0 = now();
                const sp = await http("https://api.spotify.com/v1/me/player?additional_types=track", { headers: { Authorization: `Bearer ${token}` } });

                return { sp, at: Math.round((t0 + now()) / 2) };
            };

            let token = tempoId ? await deps.monitorToken(tempoId) : await identityToken(g.grant.spotifyId);

            if (!token)
                return { status: 409, value: { error: tempoId ? "tempo-account-inactive" : "not-connected" } };

            let { sp, at } = await read(token);

            if (sp.status === 401 && !tempoId) {
                token = await identityToken(g.grant.spotifyId, true);

                if (!token)
                    return { status: 409, value: { error: "reconnect" } };

                ({ sp, at } = await read(token));
            }

            if (sp.status === 204)
                return { status: 200, value: toPlayback(null, at) };

            if (sp.status === 429)
                return { status: 429, value: { error: "rate-limited", retryAfter: Number(sp.headers.get("retry-after") ?? 5) } };

            if (!sp.ok)
                return { status: 502, value: { error: `spotify ${sp.status}` } };

            return { status: 200, value: toPlayback(await sp.json(), at) };
        }).catch((ex) => ({ status: 502, value: { error: (ex as Error).message } }));

        res.status(r.status).json(r.value);
    }

    return { playback, codes };
}
