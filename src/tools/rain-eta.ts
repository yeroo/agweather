import { z } from "zod";
import { errorPayload, unavailable } from "../lib/errors";
import { resolveLocation } from "../location/resolve";
import type { PrecipSeries } from "../types/forecast";
import { MOTION_NOT_IMPLEMENTED } from "../types/motion";
import { METEOBLUE_NOT_CONFIGURED, settle, type ToolDeps, type ToolOutput } from "./deps";
import { locationFields, locationOut } from "./schemas";

export const rainEtaInput = z.object({
	...locationFields,
	threshold_mm: z
		.number()
		.min(0.01)
		.max(10)
		.default(0.1)
		.describe("A forecast step counts as wet when its precipitation total is at least this many mm."),
});
export type RainEtaInput = z.input<typeof rainEtaInput>;

export const rainEtaOutput = z.looseObject({
	location: locationOut,
	status: z.enum(["ok", "insufficient_data"]),
	observation: z.looseObject({}),
	forecast_based: z.looseObject({}).nullable(),
	motion: z.looseObject({ available: z.boolean() }),
});

export async function rainEtaTool(raw: RainEtaInput, deps: ToolDeps): Promise<ToolOutput> {
	const input = rainEtaInput.parse(raw);
	const location = await resolveLocation(input, deps);

	const [obs, mb, om] = await Promise.all([
		settle(deps.radar.pointObservation(location.lat, location.lon)),
		deps.meteoblue ? settle(deps.meteoblue.forecast(location.lat, location.lon)) : Promise.resolve(null),
		settle(deps.openMeteo.forecast(location.lat, location.lon)),
	]);

	// Prefer meteoblue's own series when configured; only native-resolution series are used.
	const candidates: PrecipSeries[] = [];
	if (mb?.ok) candidates.push(mb.value.primary);
	if (om.ok) candidates.push(om.value.primary);
	const series = candidates.find((s) => s.temporal_resolution === "native" && s.steps.length > 0) ?? null;

	const observedRain = obs.ok ? obs.value.precip_at_point : null;
	const observation = obs.ok
		? {
				source: obs.value.source,
				kind: obs.value.kind,
				observed_at: obs.value.observed_at,
				raining_now_observed: observedRain === null ? "unknown" : observedRain,
				dbz_at_point: obs.value.dbz_at_point,
				nearby_max_dbz: obs.value.nearby_max_dbz,
				precip_nearby: obs.value.precip_nearby,
				center_covered: obs.value.center_covered,
			}
		: { raining_now_observed: "unknown", ...unavailable(obs.error) };

	const caveats: string[] = [
		"No motion-based estimate in this version: timings come only from the forecast series steps, never interpolated.",
		"For timing within the next hour, inspect the radar frames (radar tool) and judge the movement of the rain area.",
	];

	let forecastBased: Record<string, unknown> | null = null;
	let reason: string | undefined;
	if (series) {
		const wet = (mm: number) => mm >= input.threshold_mm;
		// Current state: the radar observation when it is conclusive, otherwise the first forecast step.
		const basis = observedRain === null ? "forecast_first_step" : "radar_observation";
		const wetNow = observedRain ?? wet(series.steps[0]!.precipitation_mm);

		let firstDry: string | null = null;
		let nextWet: string | null = null;
		if (wetNow) {
			const iDry = series.steps.findIndex((s) => !wet(s.precipitation_mm));
			if (iDry >= 0) {
				firstDry = series.steps[iDry]!.start;
				nextWet = series.steps.slice(iDry).find((s) => wet(s.precipitation_mm))?.start ?? null;
			}
		} else {
			nextWet = series.steps.find((s) => wet(s.precipitation_mm))?.start ?? null;
		}

		if (observedRain !== null && observedRain !== wet(series.steps[0]!.precipitation_mm)) {
			caveats.push(
				`The radar observation (${observedRain ? "rain" : "no rain"} now) disagrees with the forecast's current step; trust the radar for the present.`,
			);
		}
		caveats.push(
			`Forecast steps are ${series.step_minutes} minutes long: rain can start or stop anywhere inside a step, so a step start is not a precise time.`,
		);

		forecastBased = {
			source: series.source,
			kind: series.kind,
			model: series.model,
			issued_at: series.issued_at,
			...(series.issued_at_reason ? { issued_at_reason: series.issued_at_reason } : {}),
			retrieved_at: series.retrieved_at,
			step_minutes: series.step_minutes,
			threshold_mm: input.threshold_mm,
			current_state_basis: basis,
			wet_now: wetNow,
			first_dry_step_at: firstDry,
			next_wet_step_at: nextWet,
			series_end: series.steps[series.steps.length - 1]!.end,
			forecast_steps: series.steps,
		};
	} else {
		const why: string[] = [];
		if (mb && !mb.ok) why.push(`meteoblue: ${errorPayload(mb.error).error.message}`);
		if (!om.ok) why.push(`open-meteo: ${errorPayload(om.error).error.message}`);
		reason = why.length ? `No forecast series available (${why.join("; ")})` : "The forecast series had no upcoming steps";
	}

	return {
		structured: {
			location,
			retrieved_at: deps.now().toISOString(),
			status: series ? "ok" : "insufficient_data",
			...(reason ? { reason } : {}),
			observation,
			forecast_based: forecastBased,
			motion: MOTION_NOT_IMPLEMENTED,
			meteoblue: !mb ? METEOBLUE_NOT_CONFIGURED : mb.ok ? { available: true } : unavailable(mb.error),
			caveats,
		},
	};
}
