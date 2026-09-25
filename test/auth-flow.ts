import { expect, vi } from "vitest";
import type { Env } from "../src/env";
import type { createWorker } from "../src/index";
import { memoryKv } from "./helpers";

/** Shared driver for the real OAuth flow: DCR, consent dialog, Access callback (signed id_token), token. */

export const BASE = "https://agw.example.workers.dev";
export const CLIENT_ID = "access-client-id";
export const OIDC = `https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
export const OWNER = "Owner@Example.com";
export const CLIENT_REDIRECT = "https://client.example/callback";

/** Test signing key standing in for Cloudflare Access (generated once per test file). */
let keyPair: Promise<{ signingKey: CryptoKey; publicJwk: JsonWebKey & { kid: string; alg: string } }> | undefined;
export function keys() {
	keyPair ??= (async () => {
		const pair = (await crypto.subtle.generateKey(
			{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
		return { signingKey: pair.privateKey, publicJwk: { ...jwk, kid: "key-1", alg: "RS256" } };
	})();
	return keyPair;
}

export const b64url = (data: Uint8Array | string) =>
	Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

export async function signJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1" }) {
	const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const { signingKey } = await keys();
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input)));
	return `${input}.${b64url(sig)}`;
}

export const nowS = () => Math.floor(Date.now() / 1000);
export const goodClaims = (over: Record<string, unknown> = {}) => ({
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

export function makeEnv(over: Partial<Env> = {}): Env {
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

export const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

/** Stubs global fetch (used by the ported auth code) for Access's token + JWKS endpoints. */
export function stubAccess(idToken: () => Promise<string>) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		if (url === `${OIDC}/token`) {
			return new Response(JSON.stringify({ access_token: "upstream-access-token", id_token: await idToken(), token_type: "bearer" }), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url === `${OIDC}/jwks`) return new Response(JSON.stringify({ keys: [(await keys()).publicJwk] }));
		throw new Error(`unexpected global fetch ${url}`);
	});
	return calls;
}

export async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

export const cookiesFrom = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");

/**
 * Drives the real flow up to the Access callback. Returns the callback response.
 * `callbackCookie` decides which Cookie header the callback request carries (default: the browser's own cookies).
 */
export async function loginFlow(
	worker: ReturnType<typeof createWorker>,
	env: Env,
	callbackCookie: (browserCookies: string) => string | undefined = (c) => c,
) {
	const call = (req: Request) => worker.fetch!(req as never, env, ctx());
	const base = env.PUBLIC_BASE_URL!;

	const reg = await call(
		new Request(`${base}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: "Test client", token_endpoint_auth_method: "none" }),
		}),
	);
	expect(reg.status).toBe(201);
	const { client_id } = (await reg.json()) as { client_id: string };

	const { verifier, challenge } = await pkce();
	const authUrl = new URL(`${base}/authorize`);
	for (const [k, v] of Object.entries({
		response_type: "code",
		client_id,
		redirect_uri: CLIENT_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "client-state",
		scope: "mcp",
		resource: `${base}/mcp`,
	}))
		authUrl.searchParams.set(k, v);
	const dialog = await call(new Request(authUrl));
	expect(dialog.status).toBe(200);
	const html = await dialog.text();
	const csrf = html.match(/name="csrf_token" value="([^"]+)"/)![1]!;
	const state = html.match(/name="state" value="([^"]+)"/)![1]!;

	const approve = await call(
		new Request(`${base}/authorize`, {
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
		new Request(`${base}/callback?code=access-code&state=${encodeURIComponent(toAccess.searchParams.get("state")!)}`, {
			headers: cookie ? { cookie } : {},
		}),
	);
	return { callback, client_id, verifier, call, authUrl, approveCookies: cookiesFrom(approve) };
}

export const grantKeys = (env: Env) => [...(env.OAUTH_KV as ReturnType<typeof memoryKv>).store.keys()].filter((k) => k.startsWith("grant:"));

/** Completes the whole flow as the owner and exchanges the code for an access token for `${PUBLIC_BASE_URL}/mcp`. */
export async function obtainToken(worker: ReturnType<typeof createWorker>, env: Env): Promise<string> {
	stubAccess(() => signJwt(goodClaims()));
	const { callback, client_id, verifier, call } = await loginFlow(worker, env);
	expect(callback.status).toBe(302);
	const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
	const tok = await call(
		new Request(`${env.PUBLIC_BASE_URL}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: CLIENT_REDIRECT,
				client_id,
				code_verifier: verifier,
				resource: `${env.PUBLIC_BASE_URL}/mcp`,
			}),
		}),
	);
	expect(tok.status).toBe(200);
	return ((await tok.json()) as { access_token: string }).access_token;
}

/** POST tools/list to `url` with the given bearer token and Host header. */
export function mcpToolsList(worker: ReturnType<typeof createWorker>, env: Env, url: string, token: string, host = new URL(url).host) {
	return worker.fetch!(
		new Request(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				host,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		}) as never,
		env,
		ctx(),
	);
}
