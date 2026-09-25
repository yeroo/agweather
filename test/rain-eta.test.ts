import { describe, expect, it } from "vitest";
import { rainEtaTool } from "../src/tools/rain-eta";
import { coverageTile, emptyRadarTile, jsonResponse, makeTestDeps, radarTileWithEcho, route } from "./helpers";

const OPEN_METEO = /api\.open-meteo\.com/;

/** Open-Meteo response whose hourly precipitation values end at 10:00, 11:00, ... (hour-ending sums). */
function openMeteo(hourly: number[]) {
	return {
		hourly: {
			time: hourly.map((_, i) => `2026-09-25T${String(10 + i).padStart(2, "0")}:00`),
			precipitation: hourly,
			precipitation_probability: hourly.map((mm) => (mm > 0 ? 80 : 5)),
		},
		minutely_15: { time: ["2026-09-25T09:30"], precipitation: [0.4] },
	};
}

// 23 dBZ (moderate rain) at the centre of the sample tile.
const RAINING = radarTileWithEcho("0088bfff");

describe("rain_eta", () => {
	it("raining now (radar): first dry step and the next wet step come straight from the hourly series", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: RAINING, openMeteo: openMeteo([1.2, 0.4, 0, 0, 0.3, 0]) } });
		const out = await rainEtaTool({}, t.deps);
		const s = out.structured as Record<string, any>;
		expect(s.status).toBe("ok");
		expect(s.observation).toMatchObject({ raining_now_observed: true, kind: "observation", dbz_at_point: { min: 23, max: 23 } });
		expect(s.forecast_based).toMatchObject({
			source: "open-meteo",
			kind: "numerical_forecast",
			issued_at: null,
			step_minutes: 60,
			current_state_basis: "radar_observation",
			wet_now: true,
			first_dry_step_at: "2026-09-25T11:00:00.000Z",
			next_wet_step_at: "2026-09-25T13:00:00.000Z",
		});
		expect(s.motion).toEqual({ available: false, reason: "not_implemented_v1" });
	});

	it("never reports a step start before now: radar dry, but the step already under way is wet", async () => {
		// NOW is 09:15; the first step [09:00, 10:00) is wet, the rest dry then wet again
		const t = makeTestDeps({ upstream: { sampleTile: emptyRadarTile(), openMeteo: openMeteo([0.8, 0, 0.5]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.observation.raining_now_observed).toBe(false);
		expect(s.forecast_based.next_wet_step_at).toBe("2026-09-25T11:00:00.000Z");
		expect(Date.parse(s.forecast_based.next_wet_step_at)).toBeGreaterThanOrEqual(Date.parse(s.retrieved_at));
	});

	it("never reports a step start before now: radar wet, but the step already under way is dry", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: RAINING, openMeteo: openMeteo([0, 1, 0]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.forecast_based.first_dry_step_at).toBe("2026-09-25T11:00:00.000Z");
		expect(Date.parse(s.forecast_based.first_dry_step_at)).toBeGreaterThanOrEqual(Date.parse(s.retrieved_at));
	});

	it("uses the native hourly series, never the possibly-interpolated 15-minute one", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: RAINING, openMeteo: openMeteo([1, 1, 0]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.forecast_based.step_minutes).toBe(60);
		// every reported time is a step boundary of the series
		const starts = s.forecast_based.forecast_steps.map((x: { start: string }) => x.start);
		expect(starts).toContain(s.forecast_based.first_dry_step_at);
		expect(s.caveats.join(" ")).toMatch(/60 minutes long/);
	});

	it("dry now (radar): first_dry_step_at is null, next_wet_step_at is the first wet step", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: emptyRadarTile(), openMeteo: openMeteo([0, 0, 0.6, 0]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.observation.raining_now_observed).toBe(false);
		expect(s.forecast_based).toMatchObject({ wet_now: false, first_dry_step_at: null, next_wet_step_at: "2026-09-25T11:00:00.000Z" });
	});

	it("rain continuing through the whole series -> no invented end time", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: RAINING, openMeteo: openMeteo([2, 2, 2]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.forecast_based).toMatchObject({ first_dry_step_at: null, next_wet_step_at: null, series_end: "2026-09-25T12:00:00.000Z" });
	});

	it("observation unknown (outside coverage) -> current state from the first forecast step, labelled as such", async () => {
		const t = makeTestDeps({ upstream: { coverage: coverageTile(() => false), openMeteo: openMeteo([0.5, 0]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.observation.raining_now_observed).toBe("unknown");
		expect(s.forecast_based).toMatchObject({ current_state_basis: "forecast_first_step", wet_now: true, first_dry_step_at: "2026-09-25T10:00:00.000Z" });
	});

	it("radar and forecast disagree -> caveat says to trust the radar for the present", async () => {
		const t = makeTestDeps({ upstream: { sampleTile: RAINING, openMeteo: openMeteo([0, 0]) } });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.caveats.join(" ")).toMatch(/disagrees/);
	});

	it("no forecast series -> insufficient_data with a reason, and no times at all", async () => {
		const t = makeTestDeps({ routes: [route(OPEN_METEO, () => jsonResponse({}, 503))] });
		const s = (await rainEtaTool({}, t.deps)).structured as Record<string, any>;
		expect(s.status).toBe("insufficient_data");
		expect(s.reason).toMatch(/open-meteo/);
		expect(s.forecast_based).toBeNull();
		expect(JSON.stringify(s)).not.toMatch(/first_dry_step_at|next_wet_step_at/);
	});

	it("an empty forecast series -> insufficient_data", async () => {
		const t = makeTestDeps({ upstream: { openMeteo: { hourly: { time: [], precipitation: [] } } } });
		expect((await rainEtaTool({}, t.deps)).structured.status).toBe("insufficient_data");
	});
});
