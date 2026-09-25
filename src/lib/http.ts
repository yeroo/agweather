import type { Caches } from "./cache";
import { ToolError } from "./errors";
import type { Logger } from "./log";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface GetOptions {
	/** Provider name used for logging and structured errors. */
	provider: string;
	/** In-isolate cache TTL; 0 disables caching. */
	ttlSeconds: number;
	/** Cache key when the URL itself must not be used (e.g. it contains an API key). */
	cacheKey?: string;
	/** Also ask Cloudflare's edge cache to keep the response (only for keyless URLs). */
	edgeCache?: boolean;
	/** Map a non-2xx response (status + body text) to a specific error; fall back to the default mapping. */
	mapError?: (status: number, body: string) => ToolError | undefined;
}

export interface HttpClient {
	json(url: string, opts: GetOptions): Promise<unknown>;
	bytes(url: string, opts: GetOptions): Promise<Uint8Array>;
}

export interface HttpDeps {
	fetch: FetchFn;
	caches: Caches;
	logger: Logger;
	timeoutMs?: number;
	/** Called with the provider name for every upstream request (cached or not). */
	onProvider?: (provider: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 8000;

export function createHttp(deps: HttpDeps): HttpClient {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function get(url: string, opts: GetOptions, kind: "json" | "bytes"): Promise<unknown> {
		deps.onProvider?.(opts.provider);
		const key = `${kind}:${opts.cacheKey ?? url}`;
		const cache = kind === "json" ? deps.caches.json : deps.caches.bytes;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;

		const started = Date.now();
		let status: number | undefined;
		try {
			const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
			if (opts.edgeCache && opts.ttlSeconds > 0) {
				init.cf = { cacheTtl: opts.ttlSeconds, cacheEverything: true };
			}
			const res = await deps.fetch(url, init);
			status = res.status;
			if (!res.ok) {
				const mapped = opts.mapError?.(res.status, await res.text().catch(() => ""));
				throw mapped ?? statusError(res.status, opts.provider);
			}
			let value: unknown;
			if (kind === "json") {
				try {
					value = await res.json();
				} catch {
					throw new ToolError("provider_unavailable", `${opts.provider} returned invalid JSON`, {
						provider: opts.provider,
						retryable: true,
					});
				}
			} else {
				value = new Uint8Array(await res.arrayBuffer());
			}
			cache.set(key, value as never, opts.ttlSeconds);
			deps.logger.event({ type: "provider", provider: opts.provider, ok: true, status, duration_ms: Date.now() - started });
			return value;
		} catch (err) {
			const e = asToolError(err, opts.provider);
			deps.logger.event({
				type: "provider",
				provider: opts.provider,
				ok: false,
				status,
				error_code: e.code,
				duration_ms: Date.now() - started,
			});
			throw e;
		}
	}

	return {
		json: (url, opts) => get(url, opts, "json"),
		bytes: (url, opts) => get(url, opts, "bytes") as Promise<Uint8Array>,
	};
}

function statusError(status: number, provider: string): ToolError {
	if (status === 429) {
		return new ToolError("rate_limited", `${provider} rate limit reached`, { provider, retryable: true });
	}
	if (status >= 500) {
		return new ToolError("provider_unavailable", `${provider} is unavailable (HTTP ${status})`, {
			provider,
			retryable: true,
		});
	}
	if (status === 401 || status === 403) {
		return new ToolError("provider_unavailable", `${provider} rejected the request (HTTP ${status}); check its credentials`, {
			provider,
		});
	}
	return new ToolError("provider_unavailable", `${provider} request failed (HTTP ${status})`, { provider });
}

function asToolError(err: unknown, provider: string): ToolError {
	if (err instanceof ToolError) return err;
	const name = (err as { name?: string } | null)?.name;
	if (name === "TimeoutError" || name === "AbortError") {
		return new ToolError("upstream_timeout", `${provider} did not respond in time`, { provider, retryable: true });
	}
	// Deliberately not echoing err.message: fetch errors can carry the request URL.
	return new ToolError("provider_unavailable", `${provider} could not be reached`, { provider, retryable: true });
}
