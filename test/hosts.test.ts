import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache } from "../src/auth/id-token";
import { createApiHandler, createWorker } from "../src/index";
import { createCaches } from "../src/lib/cache";
import { makeEnv, mcpToolsList, OWNER, obtainToken } from "./auth-flow";
import { mockFetch, upstreamRoutes } from "./helpers";

const CUSTOM = "https://weather.example.com";

beforeEach(() => clearJwksCache());
afterEach(() => vi.unstubAllGlobals());

describe("/mcp is served on the PUBLIC_BASE_URL origin only (through createWorker, real token)", () => {
	it("custom-domain PUBLIC_BASE_URL: 200 there; the workers.dev and loopback origins are rejected", async () => {
		const env = makeEnv({ PUBLIC_BASE_URL: CUSTOM });
		const worker = createWorker({ fetch: mockFetch(...upstreamRoutes()).fetch, logSink: () => {} });
		const token = await obtainToken(worker, env);

		const ok = await mcpToolsList(worker, env, `${CUSTOM}/mcp`, token);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain('"name":"radar"');

		// The token's audience is `${CUSTOM}/mcp`; OAuthProvider rejects it on other origins before our handler runs.
		for (const url of ["https://agweather.me.workers.dev/mcp", "http://127.0.0.1:8788/mcp"]) {
			const res = await mcpToolsList(worker, env, url, token);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toMatch(/invalid_token/);
		}
	});

	it("local dev: PUBLIC_BASE_URL http://localhost:8788 works on exactly that URL", async () => {
		const env = makeEnv({ PUBLIC_BASE_URL: "http://localhost:8788" });
		const worker = createWorker({ fetch: mockFetch(...upstreamRoutes()).fetch, logSink: () => {} });
		const token = await obtainToken(worker, env);
		expect((await mcpToolsList(worker, env, "http://localhost:8788/mcp", token)).status).toBe(200);
		expect((await mcpToolsList(worker, env, "http://127.0.0.1:8788/mcp", token)).status).toBe(401);
	});
});

describe("/mcp Host header check (DNS-rebinding protection)", () => {
	/** Calls the API handler directly, as OAuthProvider does after a valid token, with a chosen Host header. */
	async function status(host: string) {
		const res = await createApiHandler({ logSink: () => {} }, createCaches()).fetch(
			new Request(`${CUSTOM}/mcp`, {
				method: "POST",
				headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}),
			makeEnv({ PUBLIC_BASE_URL: CUSTOM }),
			{ waitUntil() {}, passThroughOnException() {}, props: { email: OWNER.toLowerCase(), sub: "u" } } as unknown as ExecutionContext,
		);
		return res.status;
	}

	it("accepts the PUBLIC_BASE_URL host", async () => {
		expect(await status("weather.example.com")).toBe(200);
	});

	it("rejects a foreign Host", async () => {
		expect(await status("evil.example")).toBe(403);
		expect(await status("attacker.workers.dev")).toBe(403);
		expect(await status("127.0.0.1")).toBe(403);
	});
});
