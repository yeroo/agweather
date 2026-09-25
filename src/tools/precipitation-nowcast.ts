import { z } from "zod";
import { errorPayload, ToolError, unavailable } from "../lib/errors";
import { resolveLocation } from "../location/resolve";
import type { ForecastResult, PrecipSeries } from "../types/forecast";
import { METEOBLUE_NOT_CONFIGURED, type Settled, settle, type ToolDeps, type ToolOutput } from "./deps";
import { locationFields, locationOut } from "./schemas";

export const precipitationNowcastInput = z.object({ ...locationFields });
export type PrecipitationNowcastInput = z.input<typeof precipitationNowcastInput>;

export const precipitationNowcastOutput = z.looseObject({
	location: locationOut,
	retrieved_at: z.string(),
	observation: z.looseObject({}),
	radar_nowcast: z.looseObject({}),
	numerical_forecast: z.array(z.looseObject({})),
});

/** Why meteoblue did not supply the radar nowcast, depending on its configuration and on this call. */
function meteoblueNowcastReason(deps: ToolDeps, mb: Settled<ForecastResult> | null): string {
	if (!deps.meteoblue || !mb) return "and meteoblue is not configured";
	if (deps.meteoblue.kind !== "radar_nowcast") return `and the meteoblue package "${deps.meteobluePackage}" is a model forecast, not a nowcast`;
	if (!mb.ok) return `and the meteoblue nowcast request failed (${errorPayload(mb.error).error.code})`;
	return `and the meteoblue nowcast package "${deps.meteobluePackage}" returned no series`;
}

export async function precipitationNowcastTool(raw: PrecipitationNowcastInput, deps: ToolDeps): Promise<ToolOutput> {
	const input = precipitationNowcastInput.parse(raw);
	const location = await resolveLocation(input, deps);

	const [obs, om, mb] = await Promise.all([
		settle(deps.radar.pointObservation(location.lat, location.lon)),
		settle(deps.openMeteo.forecast(location.lat, location.lon)),
		deps.meteoblue ? settle(deps.meteoblue.forecast(location.lat, location.lon)) : Promise.resolve(null),
	]);
	if (!obs.ok && !om.ok && (!mb || !mb.ok)) {
		throw new ToolError("provider_unavailable", "No precipitation provider answered; try again shortly", { retryable: true });
	}

	const forecasts: PrecipSeries[] = [];
	if (om.ok) forecasts.push(om.value.primary, ...om.value.extra);
	let nowcast: PrecipSeries | undefined;
	if (mb?.ok) {
		for (const s of [mb.value.primary, ...mb.value.extra]) {
			if (s.kind === "radar_nowcast") nowcast ??= s;
			else forecasts.push(s);
		}
	}
	const radarNowcast: Record<string, unknown> = nowcast
		? { available: true, ...nowcast }
		: { available: false, reason: `No radar-extrapolation nowcast is available: RainViewer stopped publishing nowcast frames, ${meteoblueNowcastReason(deps, mb)}` };

	return {
		structured: {
			location,
			retrieved_at: deps.now().toISOString(),
			observation: obs.ok ? { available: true, ...obs.value } : unavailable(obs.error),
			radar_nowcast: radarNowcast,
			numerical_forecast: forecasts,
			providers: {
				rainviewer: obs.ok ? { available: true } : unavailable(obs.error),
				"open-meteo": om.ok ? { available: true } : unavailable(om.error),
				meteoblue: !mb ? METEOBLUE_NOT_CONFIGURED : mb.ok ? { available: true, package: deps.meteobluePackage } : unavailable(mb.error),
			},
			notes: [
				"Three separate kinds of data, never merged: observation (radar now), radar_nowcast (extrapolated radar), numerical_forecast (weather models).",
				"Forecast steps cover [start, end); precipitation_mm is the total over that step.",
				"For the next hour or so, trust the radar frames (radar tool) over hourly model output.",
			],
		},
	};
}
