import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache, expectedIssuer, verifyIdToken } from "../src/auth/id-token";
import { isOwner } from "../src/auth/owner";
import type { Env } from "../src/env";
import { createWorker } from "../src/index";
import {
	b64url,
	BASE,
	CLIENT_ID,
	CLIENT_REDIRECT,
	ctx,
	goodClaims,
	grantKeys,
	keys,
	loginFlow,
	makeEnv,
	nowS,
	OIDC,
	OWNER,
	signJwt,
	stubAccess,
} from "./auth-flow";
import { mockFetch, upstreamRoutes } from "./helpers";


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
			fetch: async () => new Response(JSON.stringify({ keys: [(await keys()).publicJwk] })),
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
