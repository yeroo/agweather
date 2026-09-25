import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { createCaches } from "../src/lib/cache";
import { createLogger } from "../src/lib/log";
import { depsFactory } from "../src/mcp/deps";
import { buildServer } from "../src/mcp/server";
import { mockFetch, NOW, route, upstreamRoutes } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function mcpClient(opts: { routes?: ReturnType<typeof route>[] } = {}) {
	const fetch = mockFetch(...(opts.routes ?? []), ...upstreamRoutes());
	const logs: string[] = [];
	const logger = createLogger({ sink: (l) => logs.push(l) });
	const makeDeps = depsFactory({}, { fetch: fetch.fetch, caches: createCaches(() => NOW.getTime()), logger, now: () => NOW });
	const handler = createMcpHandler(() => buildServer(makeDeps, logger), { route: "/mcp" });
	let id = 0;
	async function rpc(method: string, params: unknown = {}) {
		const res = await handler(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					host: "localhost",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": "2025-06-18",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
			}),
			{},
			ctx,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
		return JSON.parse(data) as { result?: any; error?: any };
	}
	const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result;
	return { rpc, call, logs, fetch };
}

describe("MCP server (SDK v2, stateless handler)", () => {
	it("lists exactly the four tools with input and output schemas", async () => {
		const c = mcpClient();
		const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		expect(init.result.serverInfo.name).toBe("agweather");
		const list = await c.rpc("tools/list");
		const tools = list.result.tools as { name: string; inputSchema: any; outputSchema: any; annotations: any }[];
		expect(tools.map((t) => t.name).sort()).toEqual(["precipitation_nowcast", "radar", "rain_eta", "weather_now"]);
		for (const t of tools) {
			expect(t.inputSchema.properties).toHaveProperty("location");
			expect(t.inputSchema.properties).toHaveProperty("lat");
			expect(t.outputSchema.type).toBe("object");
			expect(t.annotations.readOnlyHint).toBe(true);
		}
		const radar = tools.find((t) => t.name === "radar")!;
		expect(radar.inputSchema.properties.radius_km.default).toBe(150);
		expect(radar.inputSchema.properties.frames.default).toBe(6);
	});

	it("radar({}) defaults to Minsk: 6 chronological observed frames, one PNG image block each, plus structured JSON", async () => {
		const c = mcpClient();
		const result = await c.call("radar");
		expect(result.isError).toBeFalsy();
		const s = result.structuredContent;
		expect(s.location).toMatchObject({ name: "Minsk, Minsk City, Belarus", lat: 53.9, lon: 27.5667, is_default: true });
		expect(s.radar).toMatchObject({ source: "rainviewer", kind: "observation", zoom: 6, size_px: 512, north_up: true });
		const frames = s.radar.frames as Record<string, any>[];
		expect(frames).toHaveLength(6);
		expect(frames.map((f) => f.time)).toEqual([...frames.map((f) => f.time)].sort((a, b) => a - b));
		for (const [i, f] of frames.entries()) {
			expect(f).toMatchObject({ source: "rainviewer", kind: "observation", zoom: 6, size_px: 512, image_index: i });
			expect(f.time_iso).toBe(new Date(f.time * 1000).toISOString());
			expect(f.url).toMatch(/^https:\/\/tilecache\.rainviewer\.com\/v2\/radar\/[^/]+\/512\/6\/53\.9000\/27\.5667\/2\/1_1\.png$/);
			expect(f.km_per_px).toBeCloseTo(0.721, 3);
		}
		expect(s.observed_at).toBe(frames[5]!.time_iso);

		const images = result.content.filter((b: any) => b.type === "image");
		expect(images).toHaveLength(6);
		for (const img of images) {
			expect(img.mimeType).toBe("image/png");
			expect(Buffer.from(img.data, "base64").subarray(1, 4).toString()).toBe("PNG");
		}
		// first block is the JSON copy for clients that ignore structuredContent
		expect(JSON.parse(result.content[0].text)).toEqual(s);
	});

	it("radar with another supported location and with coordinates", async () => {
		const c = mcpClient();
		const bcn = await c.call("radar", { location: "Barcelona", frames: 2, include_images: false });
		expect(bcn.structuredContent.location).toMatchObject({ country_code: "ES", lat: 41.3888, lon: 2.159 });
		expect(bcn.structuredContent.radar.frames).toHaveLength(2);
		expect(bcn.content.filter((b: any) => b.type === "image")).toHaveLength(0);

		const hou = await c.call("radar", { location: "Houston", frames: 2 });
		expect(hou.structuredContent.location).toMatchObject({ country_code: "US", lat: 29.7633, lon: -95.3633 });

		const xy = await c.call("radar", { lat: 52.23, lon: 21.01, frames: 2 });
		expect(xy.structuredContent.location).toMatchObject({ lat: 52.23, lon: 21.01, resolved_by: "coordinates" });
		expect(xy.structuredContent.radar.frames[0].url).toContain("/52.2300/21.0100/");
	});

	it("the other three tools answer with labelled, timestamped blocks", async () => {
		const c = mcpClient();
		const now = (await c.call("weather_now")).structuredContent;
		expect(now.radar_observation).toMatchObject({ kind: "observation", source: "rainviewer", observed_at: expect.any(String) });
		expect(now.model_current).toMatchObject({ kind: "model_analysis", source: "open-meteo", valid_from: expect.any(String) });
		expect(now.model_current.wind_speed_kmh).toBeTypeOf("number");

		const pn = (await c.call("precipitation_nowcast")).structuredContent;
		expect(pn.observation.kind).toBe("observation");
		expect(pn.radar_nowcast.available).toBe(false);
		for (const f of pn.numerical_forecast) {
			expect(f).toMatchObject({ kind: "numerical_forecast", source: "open-meteo", retrieved_at: NOW.toISOString(), issued_at: null });
			expect(f.issued_at_reason).toBeTruthy();
		}
		expect(pn.numerical_forecast[1]).toMatchObject({ step_minutes: 15, temporal_resolution: "possibly_interpolated" });

		const eta = (await c.call("rain_eta")).structuredContent;
		expect(eta.status).toBe("ok");
	});

	it("errors come back as isError with a structured error object", async () => {
		const c = mcpClient();
		const r = await c.call("radar", { location: "Minsk", lat: 1, lon: 2 });
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toEqual({ error: { code: "invalid_input", message: expect.any(String), retryable: false } });
		expect(JSON.parse(r.content[0].text).error.code).toBe("invalid_input");
	});

	it("schema validation rejects out-of-range input", async () => {
		const c = mcpClient();
		const r = await c.rpc("tools/call", { name: "radar", arguments: { frames: 50 } });
		expect(r.error ?? r.result?.isError).toBeTruthy();
	});

	it("each tool call writes one structured log line with tool, providers, duration and outcome", async () => {
		const c = mcpClient({ routes: [route(/api\.open-meteo\.com/, () => new Response("", { status: 503 }))] });
		await c.call("radar", { frames: 1 });
		await c.call("radar", { location: "Minsk", lat: 1, lon: 2 });
		const toolLines = c.logs.map((l) => JSON.parse(l)).filter((l) => l.type === "tool");
		expect(toolLines).toHaveLength(2);
		expect(toolLines[0]).toMatchObject({ tool: "radar", ok: true, providers: ["rainviewer"] });
		expect(toolLines[0].duration_ms).toBeTypeOf("number");
		expect(toolLines[1]).toMatchObject({ tool: "radar", ok: false, error_code: "invalid_input" });
	});
});
