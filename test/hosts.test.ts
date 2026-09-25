import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { createApiHandler } from "../src/index";
import { createCaches } from "../src/lib/cache";
import { memoryKv } from "./helpers";

const OWNER = "owner@example.com";

function env(over: Partial<Env> = {}): Env {
	return {
		OAUTH_KV: memoryKv(),
		PUBLIC_BASE_URL: "https://weather.example.com",
		OWNER_EMAIL: OWNER,
		ACCESS_CLIENT_ID: "id",
		ACCESS_CLIENT_SECRET: "secret",
		ACCESS_TOKEN_URL: "https://t.example/token",
		ACCESS_AUTHORIZATION_URL: "https://t.example/authorization",
		ACCESS_JWKS_URL: "https://t.example/jwks",
		COOKIE_ENCRYPTION_KEY: "k".repeat(64),
		...over,
	};
}

/** Calls the /mcp API handler as OAuthProvider would after a valid token (props = the owner's grant). */
async function listTools(url: string, host: string, e: Env = env()): Promise<number> {
	const handler = createApiHandler({ logSink: () => {} }, createCaches());
	const res = await handler.fetch(
		new Request(url, {
			method: "POST",
			headers: {
				host,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		}),
		e,
		{ waitUntil() {}, passThroughOnException() {}, props: { email: OWNER, sub: "u" } } as unknown as ExecutionContext,
	);
	return res.status;
}

describe("/mcp Host allow-list with a custom-domain PUBLIC_BASE_URL", () => {
	it("accepts the PUBLIC_BASE_URL host", async () => {
		expect(await listTools("https://weather.example.com/mcp", "weather.example.com")).toBe(200);
	});

	it("still accepts the Worker's own workers.dev host (and preview hosts)", async () => {
		expect(await listTools("https://agweather.me.workers.dev/mcp", "agweather.me.workers.dev")).toBe(200);
		expect(await listTools("https://abc123-agweather.me.workers.dev/mcp", "abc123-agweather.me.workers.dev")).toBe(200);
	});

	it("still accepts loopback hosts for wrangler dev", async () => {
		expect(await listTools("http://127.0.0.1:8788/mcp", "127.0.0.1:8788")).toBe(200);
		expect(await listTools("http://localhost:8788/mcp", "localhost:8788")).toBe(200);
	});

	it("accepts extra hosts from MCP_ALLOWED_HOSTNAMES", async () => {
		expect(await listTools("https://alt.example.org/mcp", "alt.example.org", env({ MCP_ALLOWED_HOSTNAMES: "alt.example.org" }))).toBe(200);
	});

	it("rejects any other Host (DNS-rebinding protection)", async () => {
		expect(await listTools("https://weather.example.com/mcp", "evil.example")).toBe(403);
		// a workers.dev Host header on a request that did not arrive on that workers.dev URL
		expect(await listTools("https://weather.example.com/mcp", "attacker.workers.dev")).toBe(403);
	});
});
