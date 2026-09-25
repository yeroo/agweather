import { z } from "zod";
import { ToolError } from "../../lib/errors";
import type { HttpClient } from "../../lib/http";
import type { CurrentConditions, ForecastProvider, ForecastResult, PrecipSeries } from "../../types/forecast";
import { defined, stepsFromPreceding, utcIso } from "../openmeteo/forecast";

/**
 * meteoblue Packages API, optional. Enabled only when the METEOBLUE_API_KEY secret is set.
 * The key travels in the query string (meteoblue's scheme), so the URL is never logged
 * (the logger also masks the key value) and never used as a cache key.
 */

const PROVIDER = "meteoblue";
const BASE = "https://my.meteoblue.com/packages";
export const METEOBLUE_TTL_SECONDS = 600;
export const DEFAULT_METEOBLUE_PACKAGE = "basic-1h";

const series = z.array(z.number().nullable());
const ResponseSchema = z.object({
	metadata: z.object({
		modelrun_utc: z.string().optional(),
		modelrun_updatetime_utc: z.string().optional(),
	}),
	data_1h: z
		.object({
			time: z.array(z.string()),
			precipitation: series,
			precipitation_probability: series.optional(),
			windspeed: series.optional(),
			winddirection: series.optional(),
			temperature: series.optional(),
		})
		.optional(),
	data_xmin: z.object({ time: z.array(z.string()), precipitation: series }).optional(),
});

export class MeteoblueForecast implements ForecastProvider {
	readonly name = PROVIDER;

	constructor(
		private readonly http: HttpClient,
		private readonly apiKey: string,
		private readonly pkg: string,
		private readonly now: () => Date,
	) {}

	/** Radar nowcast only for a meteoblue nowcast package; the basic packages are model forecasts. */
	get kind(): PrecipSeries["kind"] {
		return this.pkg.startsWith("nowcast") ? "radar_nowcast" : "numerical_forecast";
	}

	async forecast(lat: number, lon: number): Promise<ForecastResult> {
		const coords = `lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
		const url = `${BASE}/${encodeURIComponent(this.pkg)}?${coords}&format=json&tz=UTC&apikey=${encodeURIComponent(this.apiKey)}`;
		const json = await this.http.json(url, {
			provider: PROVIDER,
			ttlSeconds: METEOBLUE_TTL_SECONDS,
			cacheKey: `meteoblue:${this.pkg}:${coords}`,
			edgeCache: false,
			mapError: (status, body) => mapMeteoblueError(status, body, this.pkg),
		});
		const parsed = ResponseSchema.safeParse(json);
		const data = parsed.success ? parsed.data : undefined;
		if (!data?.data_1h && !data?.data_xmin) {
			throw new ToolError("provider_unavailable", `meteoblue package "${this.pkg}" returned an unsupported response format`, {
				provider: PROVIDER,
			});
		}

		const now = this.now();
		const retrievedAt = now.toISOString();
		const issuedAt = data.metadata.modelrun_utc ? utcIso(data.metadata.modelrun_utc) : null;
		const common = {
			source: PROVIDER,
			kind: this.kind,
			model: `meteoblue ${this.pkg}`,
			issued_at: issuedAt,
			...(issuedAt ? {} : { issued_at_reason: "meteoblue response had no modelrun_utc" }),
			retrieved_at: retrievedAt,
			temporal_resolution: "native" as const,
		};

		const extra: PrecipSeries[] = [];
		let primary: PrecipSeries;
		let current: CurrentConditions | undefined;
		if (data.data_1h) {
			const h = data.data_1h;
			const steps = stepsFromPreceding(h.time, h.precipitation, 60, now, h.precipitation_probability, 12);
			primary = { ...common, step_minutes: 60, steps };
			const i = h.time.findIndex((t) => Date.parse(utcIso(t)) > now.getTime());
			if (i >= 0) {
				const end = utcIso(h.time[i]!);
				const ms = h.windspeed?.[i];
				current = {
					...common,
					kind: this.kind,
					description: "meteoblue forecast for the current hour. Not a measurement.",
					valid_from: new Date(Date.parse(end) - 3_600_000).toISOString(),
					valid_to: end,
					...defined({
						precipitation_mm: h.precipitation[i],
						precipitation_probability_pct: h.precipitation_probability?.[i],
						temperature_c: h.temperature?.[i],
						wind_speed_kmh: typeof ms === "number" ? Math.round(ms * 36) / 10 : undefined,
						wind_direction_deg: h.winddirection?.[i],
					}),
				};
			}
			if (data.data_xmin) extra.push(xmin(data.data_xmin, common, now));
		} else {
			primary = xmin(data.data_xmin!, common, now);
		}
		return { current, primary, extra };
	}
}

function xmin(d: { time: string[]; precipitation: (number | null)[] }, common: Omit<PrecipSeries, "steps" | "step_minutes">, now: Date): PrecipSeries {
	const t0 = d.time[0] ? Date.parse(utcIso(d.time[0])) : Number.NaN;
	const t1 = d.time[1] ? Date.parse(utcIso(d.time[1])) : Number.NaN;
	const step = Number.isFinite(t1 - t0) && t1 > t0 ? Math.round((t1 - t0) / 60_000) : 15;
	return { ...common, step_minutes: step, steps: stepsFromPreceding(d.time, d.precipitation, step, now, undefined, 12) };
}

export function mapMeteoblueError(status: number, body: string, pkg: string): ToolError | undefined {
	if (status === 401 || status === 403) {
		const text = body.toLowerCase();
		if (text.includes("can only access") || text.includes("package") || text.includes("not allowed")) {
			return new ToolError(
				"provider_not_configured",
				`The meteoblue API key's plan does not include the "${pkg}" package; set METEOBLUE_PACKAGE to a package the key can use (e.g. basic-1h)`,
				{ provider: PROVIDER, retryable: false },
			);
		}
		return new ToolError("provider_not_configured", "meteoblue rejected the API key", { provider: PROVIDER, retryable: false });
	}
	return undefined;
}
