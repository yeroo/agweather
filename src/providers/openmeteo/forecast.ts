import { z } from "zod";
import { ToolError } from "../../lib/errors";
import type { HttpClient } from "../../lib/http";
import type { CurrentConditions, ForecastProvider, ForecastResult, PrecipSeries, PrecipStep } from "../../types/forecast";

const PROVIDER = "open-meteo";
const BASE = "https://api.open-meteo.com/v1/forecast";
export const OPEN_METEO_TTL_SECONDS = 300;

const CURRENT_VARS = [
	"precipitation",
	"rain",
	"showers",
	"snowfall",
	"weather_code",
	"cloud_cover",
	"temperature_2m",
	"wind_speed_10m",
	"wind_direction_10m",
	"wind_gusts_10m",
] as const;

const num = z.number().nullable().optional();
const ResponseSchema = z.object({
	current: z
		.object({
			time: z.string(),
			interval: z.number(),
			precipitation: num,
			rain: num,
			showers: num,
			snowfall: num,
			weather_code: num,
			cloud_cover: num,
			temperature_2m: num,
			wind_speed_10m: num,
			wind_direction_10m: num,
			wind_gusts_10m: num,
		})
		.optional(),
	hourly: z.object({
		time: z.array(z.string()),
		precipitation: z.array(z.number().nullable()),
		precipitation_probability: z.array(z.number().nullable()).optional(),
	}),
	minutely_15: z.object({ time: z.array(z.string()), precipitation: z.array(z.number().nullable()) }).optional(),
});

/** Open-Meteo returns naive timestamps; we always request timezone=UTC. */
export function utcIso(naive: string): string {
	const s = /[zZ]|[+-]\d\d:?\d\d$/.test(naive) ? naive : `${naive.replace(" ", "T")}Z`;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) throw new ToolError("provider_unavailable", "upstream returned an unreadable timestamp");
	return d.toISOString();
}

const addMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/**
 * Open-Meteo and meteoblue both label an accumulated amount with the END of its interval
 * ("sum of the preceding hour / 15 minutes"). Convert to explicit [start, end) steps and keep
 * only the steps that have not ended yet.
 */
export function stepsFromPreceding(
	times: readonly string[],
	amounts: readonly (number | null)[],
	stepMinutes: number,
	now: Date,
	probabilities?: readonly (number | null)[],
	limit = Infinity,
): PrecipStep[] {
	const out: PrecipStep[] = [];
	times.forEach((t, i) => {
		const amount = amounts[i];
		if (amount === null || amount === undefined) return;
		const end = utcIso(t);
		if (Date.parse(end) <= now.getTime()) return;
		const step: PrecipStep = { start: addMinutes(end, -stepMinutes), end, precipitation_mm: amount };
		const p = probabilities?.[i];
		if (typeof p === "number") step.probability_pct = p;
		out.push(step);
	});
	return out.slice(0, limit);
}

export class OpenMeteoForecast implements ForecastProvider {
	readonly name = PROVIDER;

	constructor(
		private readonly http: HttpClient,
		private readonly now: () => Date,
	) {}

	async forecast(lat: number, lon: number): Promise<ForecastResult> {
		const params = new URLSearchParams({
			latitude: lat.toFixed(4),
			longitude: lon.toFixed(4),
			current: CURRENT_VARS.join(","),
			minutely_15: "precipitation",
			forecast_minutely_15: "9",
			hourly: "precipitation,precipitation_probability",
			forecast_hours: "8",
			timezone: "UTC",
			wind_speed_unit: "kmh",
		});
		const json = await this.http.json(`${BASE}?${params}`, {
			provider: PROVIDER,
			ttlSeconds: OPEN_METEO_TTL_SECONDS,
			edgeCache: true,
		});
		const parsed = ResponseSchema.safeParse(json);
		if (!parsed.success) {
			throw new ToolError("provider_unavailable", "Open-Meteo returned an unexpected response format", {
				provider: PROVIDER,
				retryable: true,
			});
		}
		const data = parsed.data;
		const now = this.now();
		const retrievedAt = now.toISOString();
		const common = {
			source: PROVIDER,
			model: "best_match",
			issued_at: null,
			issued_at_reason: "Open-Meteo does not publish the model run time in forecast responses",
			retrieved_at: retrievedAt,
		};

		const primary: PrecipSeries = {
			...common,
			kind: "numerical_forecast",
			step_minutes: 60,
			temporal_resolution: "native",
			steps: stepsFromPreceding(
				data.hourly.time,
				data.hourly.precipitation,
				60,
				now,
				data.hourly.precipitation_probability,
				6,
			),
		};

		const extra: PrecipSeries[] = [];
		if (data.minutely_15) {
			extra.push({
				...common,
				kind: "numerical_forecast",
				step_minutes: 15,
				temporal_resolution: "possibly_interpolated",
				caveat:
					"Open-Meteo has native 15-minute models only for Central Europe and North America; elsewhere these values are interpolated from hourly model output and do not add real timing precision.",
				steps: stepsFromPreceding(data.minutely_15.time, data.minutely_15.precipitation, 15, now, undefined, 8),
			});
		}

		let current: CurrentConditions | undefined;
		if (data.current) {
			const c = data.current;
			const from = utcIso(c.time);
			current = {
				...common,
				kind: "model_analysis",
				description: "Weather-model estimate for the current interval. Not a measurement.",
				valid_from: from,
				valid_to: addMinutes(from, c.interval / 60),
				...defined({
					precipitation_mm: c.precipitation,
					rain_mm: c.rain,
					showers_mm: c.showers,
					snowfall_cm: c.snowfall,
					weather_code: c.weather_code,
					cloud_cover_pct: c.cloud_cover,
					temperature_c: c.temperature_2m,
					wind_speed_kmh: c.wind_speed_10m,
					wind_direction_deg: c.wind_direction_10m,
					wind_gusts_kmh: c.wind_gusts_10m,
				}),
			};
		}
		return { current, primary, extra };
	}
}

export function defined<T extends Record<string, number | null | undefined>>(o: T): { [K in keyof T]?: number } {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(o)) if (typeof v === "number") out[k] = v;
	return out as { [K in keyof T]?: number };
}
