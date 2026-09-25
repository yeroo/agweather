/**
 * Verification of the OIDC id_token issued by Cloudflare Access for SaaS.
 *
 * Replaces the demo's verifyToken, which checked only the signature and `exp`. Here the
 * token must be RS256, signed by a key from ACCESS_JWKS_URL (looked up by `kid`), issued
 * by our Access application (`iss`), for our client (`aud`), and currently valid.
 */

export class IdTokenError extends Error {}

export interface IdTokenClaims {
	iss: string;
	aud: string | string[];
	sub: string;
	exp: number;
	email?: string;
	email_verified?: boolean;
	name?: string;
	[k: string]: unknown;
}

export interface VerifyOptions {
	jwksUrl: string;
	clientId: string;
	issuer: string;
	/** Seconds since epoch. */
	now?: () => number;
	fetch?: (url: string) => Promise<Response>;
}

const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 3600_000;
type Jwk = JsonWebKey & { kid?: string };
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

/** For tests. */
export function clearJwksCache(): void {
	jwksCache.clear();
}

/** Access for SaaS: issuer = `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>`, the token URL minus "/token". */
export function expectedIssuer(env: { ACCESS_ISSUER?: string; ACCESS_TOKEN_URL: string }): string {
	return (env.ACCESS_ISSUER?.trim() || env.ACCESS_TOKEN_URL.replace(/\/token\/?$/, "")).replace(/\/+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new IdTokenError("malformed token encoding");
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const decodeJson = (s: string): Record<string, unknown> => {
	try {
		return JSON.parse(new TextDecoder().decode(base64UrlDecode(s)));
	} catch {
		throw new IdTokenError("malformed token");
	}
};

async function findKey(kid: string, opts: VerifyOptions): Promise<Jwk | undefined> {
	const doFetch = opts.fetch ?? ((u: string) => fetch(u));
	const load = async () => {
		const res = await doFetch(opts.jwksUrl);
		if (!res.ok) throw new IdTokenError(`could not load signing keys (HTTP ${res.status})`);
		const body = (await res.json()) as { keys?: Jwk[] };
		const entry = { keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: Date.now() };
		jwksCache.set(opts.jwksUrl, entry);
		return entry;
	};
	let entry = jwksCache.get(opts.jwksUrl);
	if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) entry = await load();
	let key = entry.keys.find((k) => k.kid === kid);
	// Unknown kid: the keys may have rotated, refresh once (but not more than once a minute).
	if (!key && Date.now() - entry.fetchedAt > 60_000) key = (await load()).keys.find((k) => k.kid === kid);
	return key;
}

export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<IdTokenClaims> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new IdTokenError("token must have 3 parts");
	const [h, p, sig] = parts as [string, string, string];
	const header = decodeJson(h);
	if (header.alg !== "RS256") throw new IdTokenError("unexpected token algorithm");
	if (typeof header.kid !== "string" || header.kid === "") throw new IdTokenError("token has no key id");

	const jwk = await findKey(header.kid, opts);
	if (!jwk || jwk.kty !== "RSA") throw new IdTokenError("token signed with an unknown key");
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	const ok = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		base64UrlDecode(sig),
		new TextEncoder().encode(`${h}.${p}`),
	);
	if (!ok) throw new IdTokenError("bad token signature");

	const claims = decodeJson(p) as Partial<IdTokenClaims>;
	const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
	if (claims.iss !== opts.issuer) throw new IdTokenError("unexpected token issuer");
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(opts.clientId)) throw new IdTokenError("token is for a different audience");
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) throw new IdTokenError("token expired");
	if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) throw new IdTokenError("token not yet valid");
	if (typeof claims.sub !== "string") throw new IdTokenError("token has no subject");
	return claims as IdTokenClaims;
}
