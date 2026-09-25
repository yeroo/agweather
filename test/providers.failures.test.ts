import { describe, expect, it } from "vitest";
import { ToolError } from "../src/lib/errors";
import { precipitationNowcastTool } from "../src/tools/precipitation-nowcast";
import { radarTool } from "../src/tools/radar";
import { weatherNowTool } from "../src/tools/weather-now";
import { coverageTile, encodePng, fixture, hangingRoute, jsonResponse, makeTestDeps, route } from "./helpers";

const INDEX = /api\.rainviewer\.com/;
const OPEN_METEO = /api\.open-meteo\.com/;
const FRAME_512 = /\/512\//;

async function errorOf(p: Promise<unknown>): Promise<ToolError> {
	try {
		await p;
	} catch (e) {
		return e as ToolError;
	}
	throw new Error("expected an error");
}

describe("RainViewer failures -> structured errors", () => {
	it("5xx -> radar_unavailable (retryable)", async () => {
		const t = makeTestDeps({ routes: [route(INDEX, () => new Response("oops", { status: 503 }))] });
		const e = await errorOf(radarTool({}, t.deps));
		expect(e).toMatchObject({ code: "radar_unavailable", provider: "rainviewer", retryable: true });
	});

	it("429 -> rate_limited", async () => {
		const t = makeTestDeps({ routes: [route(INDEX, () => new Response("slow down", { status: 429 }))] });
		const e = await errorOf(radarTool({}, t.deps));
		expect(e).toMatchObject({ code: "rate_limited", provider: "rainviewer", retryable: true });
	});

	it("timeout (AbortSignal) -> upstream_timeout", async () => {
		const t = makeTestDeps({ routes: [hangingRoute(INDEX)], timeoutMs: 20 });
		const e = await errorOf(radarTool({}, t.deps));
		expect(e).toMatchObject({ code: "upstream_timeout", provider: "rainviewer", retryable: true });
	});

	it("malformed JSON -> radar_unavailable", async () => {
		const t = makeTestDeps({ routes: [route(INDEX, () => new Response("<html>", { status: 200 }))] });
		const e = await errorOf(radarTool({}, t.deps));
		expect(e.code).toBe("radar_unavailable");
	});

	it("network error message never leaks the URL", async () => {
		const t = makeTestDeps({
			routes: [
				route(INDEX, () => {
					throw new TypeError("fetch failed: https://api.rainviewer.com/secret-path");
				}),
			],
		});
		const e = await errorOf(radarTool({}, t.deps));
		expect(e.code).toBe("radar_unavailable");
		expect(e.message).not.toContain("http");
	});

	it("a frame image failing is reported per frame; the other frames still come back", async () => {
		let n = 0;
		const t = makeTestDeps({
			routes: [route(FRAME_512, () => (++n === 2 ? new Response("", { status: 502 }) : new Response(fixture("rainviewer-frame-512.png"))))],
		});
		const out = await radarTool({ frames: 3 }, t.deps);
		const frames = (out.structured.radar as { frames: Record<string, unknown>[] }).frames;
		expect(frames.filter((f) => f.image_error)).toHaveLength(1);
		expect(out.images).toHaveLength(2);
		expect(out.structured.warnings).toContain("Some frame images failed to download; see image_error.");
	});

	it("all frame images failing -> radar_unavailable", async () => {
		const t = makeTestDeps({ routes: [route(FRAME_512, () => new Response("", { status: 500 }))] });
		expect((await errorOf(radarTool({ frames: 2 }, t.deps))).code).toBe("radar_unavailable");
	});
});

describe("radar coverage", () => {
	it("no covered pixel at all -> outside_radar_coverage", async () => {
		const t = makeTestDeps({ upstream: { coverage: fixture("coverage-none.png") } });
		const e = await errorOf(radarTool({ lat: 56, lon: 32 }, t.deps));
		expect(e).toMatchObject({ code: "outside_radar_coverage", retryable: false });
	});

	it("partly covered with the centre uncovered -> frames plus a warning, not an error", async () => {
		const t = makeTestDeps({ upstream: { coverage: fixture("coverage-partial.png") } });
		const out = await radarTool({ lat: 0, lon: -30 }, t.deps);
		expect(out.structured.coverage).toMatchObject({ checked: true, center_covered: false });
		expect((out.structured.coverage as { covered_fraction: number }).covered_fraction).toBeGreaterThan(0);
		expect((out.structured.warnings as string[]).join(" ")).toMatch(/outside radar coverage/);
	});

	it("coverage check failing does not sink radar()", async () => {
		const t = makeTestDeps({ routes: [route(/\/v2\/coverage\//, () => new Response("", { status: 500 }))] });
		const out = await radarTool({}, t.deps);
		expect(out.structured.coverage).toMatchObject({ checked: false });
		expect(out.images!.length).toBeGreaterThan(0);
	});

	it("point observation outside coverage reports 'unknown', never 'dry'", async () => {
		const t = makeTestDeps({ upstream: { coverage: coverageTile(() => false) } });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.radar_observation).toMatchObject({ center_covered: false, precip_at_point: null, precip_nearby: null });
	});
});

describe("point observation readability", () => {
	it("an unreadable ring (colours not in the table) -> precip_nearby null, not false", async () => {
		const offTable = encodePng(256, 256, () => [1, 2, 3, 255]);
		const t = makeTestDeps({ upstream: { sampleTile: offTable } });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.radar_observation).toMatchObject({ precip_at_point: null, precip_nearby: null, nearby_max_dbz: null });
	});

	it("a readable dry ring -> precip_nearby false", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: encodePng(256, 256, () => [0, 0, 0, 0]) } });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.radar_observation).toMatchObject({ precip_at_point: false, precip_nearby: false });
	});
});

describe("one provider failing inside a tool -> partial result", () => {
	it("weather_now: Open-Meteo down, radar observation still returned", async () => {
		const t = makeTestDeps({ routes: [route(OPEN_METEO, () => new Response("", { status: 503 }))] });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.radar_observation).toMatchObject({ available: true, kind: "observation", source: "rainviewer" });
		expect(out.structured.model_current).toMatchObject({ available: false, error: { code: "provider_unavailable", provider: "open-meteo" } });
	});

	it("precipitation_nowcast: RainViewer down, forecasts still returned", async () => {
		const t = makeTestDeps({ routes: [route(INDEX, () => new Response("", { status: 500 }))] });
		const out = await precipitationNowcastTool({}, t.deps);
		expect(out.structured.observation).toMatchObject({ available: false, error: { code: "radar_unavailable" } });
		expect((out.structured.numerical_forecast as unknown[]).length).toBeGreaterThan(0);
	});

	it("every provider down -> provider_unavailable", async () => {
		const t = makeTestDeps({
			routes: [route(INDEX, () => new Response("", { status: 500 })), route(OPEN_METEO, () => jsonResponse({}, 500))],
		});
		expect((await errorOf(weatherNowTool({}, t.deps))).code).toBe("provider_unavailable");
	});
});
