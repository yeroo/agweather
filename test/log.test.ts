import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, redact } from "../src/lib/log";
import { createCaches } from "../src/lib/cache";
import { depsFactory } from "../src/mcp/deps";
import { buildServer } from "../src/mcp/server";
import { createMcpHandler } from "agents/mcp/server";
import { mockFetch, NOW, TEST_METEOBLUE_KEY, upstreamRoutes } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("redact", () => {
	it("drops secret-looking keys and credential query parameters", () => {
		const out = redact({
			url: "https://my.meteoblue.com/packages/basic-1h?lat=1&apikey=abc123&format=json",
			authorization: "Bearer xyz",
			nested: { access_token: "t", client_secret: "s", ok: "fine" },
		});
		expect(out).toEqual({
			url: "https://my.meteoblue.com/packages/basic-1h?lat=1&apikey=[redacted]&format=json",
			authorization: "[redacted]",
			nested: { access_token: "[redacted]", client_secret: "[redacted]", ok: "fine" },
		});
	});

	it("masks known secret values anywhere in strings", () => {
		expect(redact({ error: `failed with key s3cr3tvalue in it` }, ["s3cr3tvalue"])).toEqual({ error: "failed with key [redacted] in it" });
	});
});

describe("structured logging through console.log", () => {
	it("one JSON line per tool call with tool/providers/duration/ok, and the meteoblue key never appears", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetch = mockFetch(...upstreamRoutes());
		const logger = createLogger({ secrets: [TEST_METEOBLUE_KEY] }); // default sink = console.log
		const makeDeps = depsFactory(
			{ METEOBLUE_API_KEY: TEST_METEOBLUE_KEY },
			{ fetch: fetch.fetch, caches: createCaches(() => NOW.getTime()), logger, now: () => NOW },
		);
		const handler = createMcpHandler(() => buildServer(makeDeps, logger), { route: "/mcp" });
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "precipitation_nowcast", arguments: {} } }),
			}),
			{},
			{ waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(200);
		await res.text();

		const lines = spy.mock.calls.map((c) => String(c[0]));
		expect(lines.length).toBeGreaterThan(0);
		const parsed = lines.map((l) => JSON.parse(l));
		const tool = parsed.filter((l) => l.type === "tool");
		expect(tool).toHaveLength(1);
		expect(tool[0]).toMatchObject({ tool: "precipitation_nowcast", ok: true });
		expect(tool[0].providers.sort()).toEqual(["meteoblue", "open-meteo", "rainviewer"]);
		expect(tool[0].duration_ms).toBeTypeOf("number");
		expect(parsed.filter((l) => l.type === "provider").every((l) => typeof l.duration_ms === "number" && "ok" in l)).toBe(true);
		expect(lines.join("\n")).not.toContain(TEST_METEOBLUE_KEY);
		expect(fetch.calls.some((c) => c.url.includes(TEST_METEOBLUE_KEY))).toBe(true);
	});
});
