import { z } from "zod";
import { ToolError, unavailable } from "../lib/errors";
import { resolveLocation } from "../location/resolve";
import { METEOBLUE_NOT_CONFIGURED, settle, type ToolDeps, type ToolOutput } from "./deps";
import { locationFields, locationOut } from "./schemas";

export const weatherNowInput = z.object({ ...locationFields });
export type WeatherNowInput = z.input<typeof weatherNowInput>;

export const weatherNowOutput = z.looseObject({
	location: locationOut,
	retrieved_at: z.string(),
	radar_observation: z.looseObject({}),
	model_current: z.looseObject({}),
	meteoblue: z.looseObject({}),
});

export async function weatherNowTool(raw: WeatherNowInput, deps: ToolDeps): Promise<ToolOutput> {
	const input = weatherNowInput.parse(raw);
	const location = await resolveLocation(input, deps);

	const [obs, om, mb] = await Promise.all([
		settle(deps.radar.pointObservation(location.lat, location.lon)),
		settle(deps.openMeteo.forecast(location.lat, location.lon)),
		deps.meteoblue ? settle(deps.meteoblue.forecast(location.lat, location.lon)) : Promise.resolve(null),
	]);

	if (!obs.ok && !om.ok && (!mb || !mb.ok)) {
		throw new ToolError("provider_unavailable", "No weather provider answered; try again shortly", { retryable: true });
	}

	const modelCurrent = om.ok
		? (om.value.current ?? { available: false, reason: "Open-Meteo returned no current conditions" })
		: unavailable(om.error);

	return {
		structured: {
			location,
			retrieved_at: deps.now().toISOString(),
			radar_observation: obs.ok ? { available: true, ...obs.value } : unavailable(obs.error),
			model_current: om.ok ? { available: true, ...modelCurrent } : modelCurrent,
			meteoblue: !mb
				? METEOBLUE_NOT_CONFIGURED
				: mb.ok
					? { available: true, ...(mb.value.current ?? { reason: "no step covers the current hour" }) }
					: unavailable(mb.error),
			notes: [
				"radar_observation is measured (latest radar frame). model_current and meteoblue are weather-model output, not measurements.",
				"Precipitation and wind values come from different sources and times; compare their timestamps before combining them.",
			],
		},
	};
}
