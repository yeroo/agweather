import { describe, expect, it } from "vitest";
import { precipitationNowcastTool } from "../src/tools/precipitation-nowcast";
import { radarTool } from "../src/tools/radar";
import { rainEtaTool } from "../src/tools/rain-eta";
import { weatherNowTool } from "../src/tools/weather-now";
import { jsonResponse, makeTestDeps, route, TEST_METEOBLUE_KEY } from "./helpers";

const METEOBLUE = /my\.meteoblue\.com/;
const FREE_TRIAL_403 = {
	error: true,
	error_message:
		"This user, a Free-trial user, can only access Free-trial packages. Free-trial packages include: 'basic-1h', 'basic-3h', 'basic-day'",
};

describe("meteoblue not configured", () => {
	it("precipitation_nowcast still returns the Open-Meteo forecast and says meteoblue is not configured", async () => {
		const t = makeTestDeps();
		const out = await precipitationNowcastTool({}, t.deps);
		const s = out.structured as Record<string, any>;
		expect(s.providers.meteoblue).toMatchObject({ available: false, error: { code: "provider_not_configured", provider: "meteoblue" } });
		expect(s.numerical_forecast[0]).toMatchObject({ source: "open-meteo", kind: "numerical_forecast", step_minutes: 60 });
		expect(s.radar_nowcast).toMatchObject({ available: false });
		expect(t.fetch.count(METEOBLUE)).toBe(0);
	});

	it("radar and weather_now are unaffected", async () => {
		const t = makeTestDeps();
		const radar = await radarTool({}, t.deps);
		expect(radar.images!.length).toBe(6);
		const now = await weatherNowTool({}, t.deps);
		expect(now.structured.meteoblue).toMatchObject({ available: false, error: { code: "provider_not_configured" } });
		expect(now.structured.model_current).toMatchObject({ available: true, source: "open-meteo" });
	});
});

describe("meteoblue configured (basic-1h, real fixture)", () => {
	it("adds a labelled numerical forecast with issued_at from modelrun_utc", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY });
		const out = await precipitationNowcastTool({}, t.deps);
		const mb = (out.structured.numerical_forecast as Record<string, any>[]).find((s) => s.source === "meteoblue")!;
		expect(mb).toMatchObject({
			kind: "numerical_forecast",
			model: "meteoblue basic-1h",
			issued_at: "2026-09-25T09:12:00.000Z",
			step_minutes: 60,
			temporal_resolution: "native",
		});
		expect(mb.steps[0]).toMatchObject({ start: "2026-09-25T09:00:00.000Z", end: "2026-09-25T10:00:00.000Z" });
		expect(out.structured.radar_nowcast).toMatchObject({ available: false });
		const url = t.fetch.calls.find((c) => METEOBLUE.test(c.url))!.url;
		expect(url).toContain("/packages/basic-1h?");
		expect(url).toContain("format=json&tz=UTC");
	});

	it("weather_now shows meteoblue's current hour with wind converted to km/h", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.meteoblue).toMatchObject({
			available: true,
			source: "meteoblue",
			kind: "numerical_forecast",
			valid_from: "2026-09-25T09:00:00.000Z",
			valid_to: "2026-09-25T10:00:00.000Z",
		});
		expect(typeof (out.structured.meteoblue as { wind_speed_kmh?: number }).wind_speed_kmh).toBe("number");
	});

	it("weather_now: meteoblue answered but has no step for the current hour -> available false with a reason", async () => {
		const old = { metadata: { modelrun_utc: "2026-09-24 00:00" }, data_1h: { time: ["2026-09-24 01:00"], precipitation: [0] } };
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY, upstream: { meteoblue: old } });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.meteoblue).toEqual({ available: false, reason: expect.stringMatching(/current hour/) });
	});

	it("weather_now: Open-Meteo answered without current conditions -> available false with a reason", async () => {
		const noCurrent = { hourly: { time: ["2026-09-25T10:00"], precipitation: [0] } };
		const t = makeTestDeps({ upstream: { openMeteo: noCurrent } });
		const out = await weatherNowTool({}, t.deps);
		expect(out.structured.model_current).toEqual({ available: false, reason: expect.stringMatching(/no current conditions/) });
	});

	it("rain_eta prefers the meteoblue series when it is available", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY });
		const out = await rainEtaTool({}, t.deps);
		expect(out.structured.forecast_based).toMatchObject({ source: "meteoblue", issued_at: "2026-09-25T09:12:00.000Z" });
	});

	it("a free-trial 403 for another package -> provider_not_configured (not retryable), other providers unaffected", async () => {
		const t = makeTestDeps({
			meteoblueKey: TEST_METEOBLUE_KEY,
			meteobluePackage: "basic-15min",
			routes: [route(METEOBLUE, () => jsonResponse(FREE_TRIAL_403, 403))],
		});
		const out = await precipitationNowcastTool({}, t.deps);
		const s = out.structured as Record<string, any>;
		expect(s.providers.meteoblue).toMatchObject({
			available: false,
			error: { code: "provider_not_configured", provider: "meteoblue", retryable: false },
		});
		expect(s.providers.meteoblue.error.message).toContain('"basic-15min"');
		expect(s.numerical_forecast.map((f: { source: string }) => f.source)).toEqual(["open-meteo", "open-meteo"]);
		expect(s.observation).toMatchObject({ available: true });

		const eta = await rainEtaTool({}, t.deps);
		expect(eta.structured.forecast_based).toMatchObject({ source: "open-meteo" });
	});

	it("a nowcast package is labelled radar_nowcast, never numerical_forecast", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY, meteobluePackage: "nowcast-1h" });
		const out = await precipitationNowcastTool({}, t.deps);
		expect(out.structured.radar_nowcast).toMatchObject({ available: true, source: "meteoblue", kind: "radar_nowcast" });
		expect((out.structured.numerical_forecast as { source: string }[]).every((s) => s.source !== "meteoblue")).toBe(true);
	});

	it("nowcast package that fails -> radar_nowcast says the nowcast request failed, not 'model forecast'", async () => {
		const t = makeTestDeps({
			meteoblueKey: TEST_METEOBLUE_KEY,
			meteobluePackage: "nowcast-15min",
			routes: [route(METEOBLUE, () => jsonResponse(FREE_TRIAL_403, 403))],
		});
		const out = await precipitationNowcastTool({}, t.deps);
		const reason = (out.structured.radar_nowcast as { reason: string }).reason;
		expect(out.structured.radar_nowcast).toMatchObject({ available: false });
		expect(reason).toMatch(/meteoblue nowcast request failed \(provider_not_configured\)/);
		expect(reason).not.toMatch(/model forecast/);
	});

	it("nowcast-15min package that succeeds fills radar_nowcast", async () => {
		const xmin = {
			metadata: { modelrun_utc: "2026-09-25 09:00" },
			data_xmin: { time: ["2026-09-25 09:30", "2026-09-25 09:45", "2026-09-25 10:00"], precipitation: [0.1, 0.3, 0] },
		};
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY, meteobluePackage: "nowcast-15min", upstream: { meteoblue: xmin } });
		const out = await precipitationNowcastTool({}, t.deps);
		expect(out.structured.radar_nowcast).toMatchObject({ available: true, kind: "radar_nowcast", step_minutes: 15, issued_at: "2026-09-25T09:00:00.000Z" });
	});

	it("basic package -> reason says it is a model forecast", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY });
		const out = await precipitationNowcastTool({}, t.deps);
		expect((out.structured.radar_nowcast as { reason: string }).reason).toMatch(/"basic-1h" is a model forecast/);
	});

	it("the API key never reaches logs, cache keys or tool output", async () => {
		const t = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY });
		const outputs = [await precipitationNowcastTool({}, t.deps), await weatherNowTool({}, t.deps), await rainEtaTool({}, t.deps)];
		// and on the error path
		const bad = makeTestDeps({ meteoblueKey: TEST_METEOBLUE_KEY, routes: [route(METEOBLUE, () => jsonResponse(FREE_TRIAL_403, 403))] });
		outputs.push(await precipitationNowcastTool({}, bad.deps));
		const failing = makeTestDeps({
			meteoblueKey: TEST_METEOBLUE_KEY,
			routes: [
				route(METEOBLUE, () => {
					throw new TypeError(`connect failed https://my.meteoblue.com/packages/basic-1h?apikey=${TEST_METEOBLUE_KEY}`);
				}),
			],
		});
		outputs.push(await precipitationNowcastTool({}, failing.deps));

		expect(t.fetch.calls.some((c) => c.url.includes(TEST_METEOBLUE_KEY))).toBe(true); // it is sent upstream...
		for (const x of [t, bad, failing]) {
			expect(x.logs.join("\n")).not.toContain(TEST_METEOBLUE_KEY); // ...but never logged
			expect([...x.caches.json.keys(), ...x.caches.bytes.keys()].join("\n")).not.toContain(TEST_METEOBLUE_KEY);
		}
		expect(JSON.stringify(outputs)).not.toContain(TEST_METEOBLUE_KEY);
	});
});
