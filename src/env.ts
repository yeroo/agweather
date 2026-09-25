import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker bindings. Vars live in wrangler.jsonc; secrets are set with `wrangler secret put`. */
export interface Env {
	OAUTH_KV: KVNamespace;

	// vars
	/** Public origin of this Worker, e.g. https://agweather.example.workers.dev (required). */
	PUBLIC_BASE_URL?: string;
	/** Comma-separated email(s) allowed to use the server (required). */
	OWNER_EMAIL?: string;
	/** Location used when a tool is called without one. Default "Minsk, Belarus". */
	DEFAULT_LOCATION?: string;
	/** meteoblue package, default "basic-1h". */
	METEOBLUE_PACKAGE?: string;
	/** Override for the expected id_token issuer (defaults to ACCESS_TOKEN_URL without "/token"). */
	ACCESS_ISSUER?: string;

	// secrets
	ACCESS_CLIENT_ID: string;
	ACCESS_CLIENT_SECRET: string;
	ACCESS_TOKEN_URL: string;
	ACCESS_AUTHORIZATION_URL: string;
	ACCESS_JWKS_URL: string;
	COOKIE_ENCRYPTION_KEY: string;
	/** Optional: enables the meteoblue provider. */
	METEOBLUE_API_KEY?: string;
}

export type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const DEFAULT_LOCATION = "Minsk, Belarus";
