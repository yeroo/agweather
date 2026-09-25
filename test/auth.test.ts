import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache, expectedIssuer, verifyIdToken } from "../src/auth/id-token";
import { isOwner } from "../src/auth/owner";
import type { Env } from "../src/env";
import { createWorker } from "../src/index";
import { memoryKv, mockFetch, upstreamRoutes } from "./helpers";

const BASE = "https://agw.example.workers.dev";
const CLIENT_ID = "access-client-id";
const OIDC = `https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
const OWNER = "Owner@Example.com";
const CLIENT_REDIRECT = "https://client.example/callback";

let signingKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string; alg: string };

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	signingKey = pair.privateKey;
	publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "key-1", alg: "RS256" };
});

const b64url = (data: Uint8Array | string) =>
	Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function signJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1" }) {
	const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input)));
	return `${input}.${b64url(sig)}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const goodClaims = (over: Record<string, unknown> = {}) => ({
	iss: OIDC,
	aud: CLIENT_ID,
	sub: "user-123",
	email: OWNER.toLowerCase(),
	email_verified: true,
	name: "The Owner",
	iat: nowS(),
	exp: nowS() + 600,
	...over,
});

function makeEnv(over: Partial<Env> = {}): Env {
	return {
		OAUTH_KV: memoryKv(),
		PUBLIC_BASE_URL: BASE,
		OWNER_EMAIL: OWNER,
		DEFAULT_LOCATION: "Minsk, Belarus",
		ACCESS_CLIENT_ID: CLIENT_ID,
		ACCESS_CLIENT_SECRET: "access-client-secret",
		ACCESS_TOKEN_URL: `${OIDC}/token`,
		ACCESS_AUTHORIZATION_URL: `${OIDC}/authorization`,
		ACCESS_JWKS_URL: `${OIDC}/jwks`,
		COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		...over,
	};
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

/** Stubs global fetch (used by the ported auth code) for Access's token + JWKS endpoints. */
function stubAccess(idToken: () => Promise<string>) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		if (url === `${OIDC}/token`) {
			return new Response(JSON.stringify({ access_token: "upstream-access-token", id_token: await idToken(), token_type: "bearer" }), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url === `${OIDC}/jwks`) return new Response(JSON.stringify({ keys: [publicJwk] }));
		throw new Error(`unexpected global fetch ${url}`);
	});
	return calls;
}

async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

const cookiesFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");

/**
 * Drives the real flow up to the Access callback. Returns the callback response.
 * `callbackCookie` decides which Cookie header the callback request carries (default: the browser's own cookies).
 */
async function loginFlow(
	worker: ReturnType<typeof createWorker>,
	env: Env,
	callbackCookie: (browserCookies: string) => string | undefined = (c) => c,
) {
	const call = (req: Request) => worker.fetch!(req as never, env, ctx());

	const reg = await call(
		new Request(`${BASE}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: "Test client", token_endpoint_auth_method: "none" }),
		}),
	);
	expect(reg.status).toBe(201);
	const { client_id } = (await reg.json()) as { client_id: string };

	const { verifier, challenge } = await pkce();
	const authUrl = new URL(`${BASE}/authorize`);
	for (const [k, v] of Object.entries({
		response_type: "code",
		client_id,
		redirect_uri: CLIENT_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "client-state",
		scope: "mcp",
		resource: `${BASE}/mcp`,
	}))
		authUrl.searchParams.set(k, v);
	const dialog = await call(new Request(authUrl));
	expect(dialog.status).toBe(200);
	const html = await dialog.text();
	const csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1]!;
	const state = html.match(/name="state" value="([^"]+)"/)![1]!;

	const approve = await call(
		new Request(`${BASE}/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(dialog) },
			body: new URLSearchParams({ csrf_token: csrf, state }),
		}),
	);
	expect(approve.status).toBe(302);
	const toAccess = new URL(approve.headers.get("location")!);
	expect(toAccess.origin + toAccess.pathname).toBe(`${OIDC}/authorization`);
	expect(toAccess.searchParams.get("scope")).toBe("openid email profile");

	expect(approve.headers.getSetCookie().some((c) => c.startsWith("__Host-OAUTH_STATE="))).toBe(true);

	const cookie = callbackCookie(cookiesFrom(approve));
	const callback = await call(
		new Request(`${BASE}/callback?code=access-code&state=${encodeURIComponent(toAccess.searchParams.get("state")!)}`, {
			headers: cookie ? { cookie } : {},
		}),
	);
	return { callback, client_id, verifier, call, authUrl, approveCookies: cookiesFrom(approve) };
}

const grantKeys = (env: Env) => [...(env.OAUTH_KV as ReturnType<typeof memoryKv>).store.keys()].filter((k) => k.startsWith("grant:"));

beforeEach(() => clearJwksCache());
afterEach(() => vi.unstubAllGlobals());

describe("/mcp requires OAuth", () => {
	it("no bearer token -> 401 with WWW-Authenticate pointing at protected-resource metadata", async () => {
		const env = makeEnv();
		const res = await createWorker().fetch!(new Request(`${BASE}/mcp`, { method: "POST", body: "{}" }) as never, env, ctx());
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);

		const meta = await createWorker().fetch!(new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`) as never, env, ctx());
		expect(meta.status).toBe(200);
		expect(await meta.json()).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
	});

	it("an invalid bearer token -> 401", async () => {
		const res = await createWorker().fetch!(
			new Request(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer nope:nope:nope" }, body: "{}" }) as never,
			makeEnv(),
			ctx(),
		);
		expect(res.status).toBe(401);
	});

	it("missing PUBLIC_BASE_URL -> 500 configuration error, not a crash", async () => {
		const res = await createWorker().fetch!(new Request(`${BASE}/mcp`) as never, makeEnv({ PUBLIC_BASE_URL: undefined }), ctx());
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("PUBLIC_BASE_URL");
	});
});

describe("Access login -> owner-only grant", () => {
	it("owner: callback issues a code, /token issues a token, and /mcp works with it", async () => {
		const env = makeEnv();
		const accessCalls = stubAccess(() => signJwt(goodClaims()));
		const upstream = mockFetch(...upstreamRoutes());
		const worker = createWorker({ fetch: upstream.fetch });
		const { callback, client_id, verifier, call } = await loginFlow(worker, env);

		expect(callback.status).toBe(302);
		const back = new URL(callback.headers.get("location")!);
		expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("state")).toBe("client-state");
		expect(accessCalls).toEqual([`${OIDC}/token`, `${OIDC}/jwks`]);
		// the one-time state-binding cookie is cleared
		expect(callback.headers.getSetCookie().some((c) => /^__Host-OAUTH_STATE=;.*Max-Age=0/.test(c))).toBe(true);

		const grants = grantKeys(env);
		expect(grants).toHaveLength(1);

		const tok = await call(
			new Request(`${BASE}/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: back.searchParams.get("code")!,
					redirect_uri: CLIENT_REDIRECT,
					client_id,
					code_verifier: verifier,
					resource: `${BASE}/mcp`,
				}),
			}),
		);
		expect(tok.status).toBe(200);
		const { access_token } = (await tok.json()) as { access_token: string };

		const mcp = (e: Env) =>
			worker.fetch!(
				new Request(`${BASE}/mcp`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${access_token}`,
						host: new URL(BASE).host,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						"mcp-protocol-version": "2025-06-18",
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
				}) as never,
				e,
				ctx(),
			);
		const ok = await mcp(env);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain('"name":"radar"');

		// Defence in depth: the same valid token stops working once its identity is no longer the owner.
		const denied = await mcp({ ...env, OWNER_EMAIL: "someone-else@example.com" });
		expect(denied.status).toBe(403);
	});

	it.each([
		["no state cookie (state replayed in another browser)", () => undefined],
		["a different browser's state cookie", () => "__Host-OAUTH_STATE=0000000000000000000000000000000000000000000000000000000000000000"],
	])("callback with a valid state but %s -> 400, no code exchange, no grant", async (_name, cookie) => {
		const env = makeEnv();
		const accessCalls = stubAccess(() => signJwt(goodClaims()));
		const { callback } = await loginFlow(createWorker(), env, cookie);
		expect(callback.status).toBe(400);
		expect(await callback.text()).toMatch(/does not belong to this browser/);
		expect(accessCalls).toEqual([]); // the Access token endpoint was never called
		expect(grantKeys(env)).toHaveLength(0);
	});

	it("already-approved client: /authorize redirects straight to Access and still binds the state to the browser", async () => {
		const env = makeEnv();
		stubAccess(() => signJwt(goodClaims()));
		const worker = createWorker();
		const first = await loginFlow(worker, env);
		expect(first.callback.status).toBe(302);

		const again = await first.call(new Request(first.authUrl, { headers: { cookie: first.approveCookies } }));
		expect(again.status).toBe(302);
		const toAccess = new URL(again.headers.get("location")!);
		expect(toAccess.origin + toAccess.pathname).toBe(`${OIDC}/authorization`);
		const stateCookie = again.headers.getSetCookie().find((c) => c.startsWith("__Host-OAUTH_STATE="));
		expect(stateCookie).toMatch(/HttpOnly; Secure; Path=\/; SameSite=Lax/);

		const cb = (cookie?: string) =>
			first.call(
				new Request(`${BASE}/callback?code=c2&state=${encodeURIComponent(toAccess.searchParams.get("state")!)}`, {
					headers: cookie ? { cookie } : {},
				}),
			);
		expect((await cb()).status).toBe(400);
		expect((await cb(stateCookie!.split(";")[0])).status).toBe(302);
	});

	it("a failed code exchange does not echo the upstream body", async () => {
		const env = makeEnv();
		const logs: string[] = [];
		vi.stubGlobal("fetch", async () => new Response("upstream says: secret internal detail", { status: 400 }));
		const { callback } = await loginFlow(createWorker({ logSink: (l) => logs.push(l) }), env);
		expect(callback.status).toBe(502);
		expect(await callback.text()).not.toContain("secret internal detail");
		expect(logs.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ stage: "token_exchange", upstream_status: 400 }));
	});

	it("non-owner identity -> 403 and no grant or token is created", async () => {
		const env = makeEnv();
		stubAccess(() => signJwt(goodClaims({ email: "intruder@example.com" })));
		const { callback } = await loginFlow(createWorker(), env);
		expect(callback.status).toBe(403);
		expect(callback.headers.get("location")).toBeNull();
		expect(grantKeys(env)).toHaveLength(0);
	});

	it.each([
		["wrong audience", () => signJwt(goodClaims({ aud: "another-client" })), /audience/],
		["wrong issuer", () => signJwt(goodClaims({ iss: "https://evil.cloudflareaccess.com/cdn-cgi/access/sso/oidc/x" })), /issuer/],
		["expired", () => signJwt(goodClaims({ exp: nowS() - 3600 })), /expired/],
		["unknown kid", () => signJwt(goodClaims(), { alg: "RS256", kid: "rotated-away" }), /unknown key/],
		["alg none", async () => `${b64url(JSON.stringify({ alg: "none", kid: "key-1" }))}.${b64url(JSON.stringify(goodClaims()))}.`, /algorithm/],
	])("%s id_token -> 401, no grant", async (_name, token, reason) => {
		const env = makeEnv();
		stubAccess(token);
		const { callback } = await loginFlow(createWorker(), env);
		expect(callback.status).toBe(401);
		expect(await callback.text()).toMatch(reason);
		expect(grantKeys(env)).toHaveLength(0);
	});

	it("unverified email -> 403", async () => {
		const env = makeEnv();
		stubAccess(() => signJwt(goodClaims({ email_verified: false })));
		expect((await loginFlow(createWorker(), env)).callback.status).toBe(403);
	});
});

describe("id_token verification details", () => {
	it("tampered payload fails the signature check", async () => {
		const token = await signJwt(goodClaims());
		const [h, , s] = token.split(".");
		const forged = `${h}.${b64url(JSON.stringify(goodClaims({ email: "intruder@example.com" })))}.${s}`;
		const opts = {
			jwksUrl: `${OIDC}/jwks`,
			clientId: CLIENT_ID,
			issuer: OIDC,
			fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] })),
		};
		await expect(verifyIdToken(forged, opts)).rejects.toThrow(/signature/);
		await expect(verifyIdToken(token, opts)).resolves.toMatchObject({ email: OWNER.toLowerCase() });
	});

	it("issuer defaults to the token URL minus /token", () => {
		expect(expectedIssuer({ ACCESS_TOKEN_URL: `${OIDC}/token` })).toBe(OIDC);
		expect(expectedIssuer({ ACCESS_TOKEN_URL: `${OIDC}/token`, ACCESS_ISSUER: "https://x/" })).toBe("https://x");
	});
});

describe("isOwner", () => {
	it("case-insensitive allow-list; empty allow-list admits nobody", () => {
		expect(isOwner("owner@example.com", "a@b.c, OWNER@example.com")).toBe(true);
		expect(isOwner("other@example.com", "owner@example.com")).toBe(false);
		expect(isOwner("owner@example.com", "")).toBe(false);
		expect(isOwner("owner@example.com", undefined)).toBe(false);
		expect(isOwner(undefined, "owner@example.com")).toBe(false);
	});
});
