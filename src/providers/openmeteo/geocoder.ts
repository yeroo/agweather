import { z } from "zod";
import { ToolError } from "../../lib/errors";
import type { HttpClient } from "../../lib/http";
import type { Geocoder, GeoResult } from "../../types/location";

const PROVIDER = "open-meteo-geocoding";
const BASE = "https://geocoding-api.open-meteo.com/v1/search";
export const GEOCODER_TTL_SECONDS = 7 * 24 * 3600;

const ResponseSchema = z.object({
	results: z
		.array(
			z.object({
				name: z.string(),
				latitude: z.number(),
				longitude: z.number(),
				country: z.string().optional(),
				country_code: z.string().optional(),
				admin1: z.string().optional(),
				population: z.number().optional(),
			}),
		)
		.optional(),
});

export class OpenMeteoGeocoder implements Geocoder {
	readonly name = PROVIDER;

	constructor(private readonly http: HttpClient) {}

	async search(name: string): Promise<GeoResult[]> {
		const params = new URLSearchParams({ name, count: "10", language: "en", format: "json" });
		let json: unknown;
		try {
			json = await this.http.json(`${BASE}?${params}`, {
				provider: PROVIDER,
				ttlSeconds: GEOCODER_TTL_SECONDS,
				cacheKey: `geocode:${name.toLowerCase()}`,
				edgeCache: true,
			});
		} catch (err) {
			const e = err as ToolError;
			// Keep timeout / rate-limit codes; everything else is a geocoding failure.
			if (e.code === "upstream_timeout" || e.code === "rate_limited") throw e;
			throw new ToolError("geocoding_failed", "The geocoding service failed; try again or pass lat/lon", {
				provider: PROVIDER,
				retryable: e.retryable ?? true,
			});
		}
		const parsed = ResponseSchema.safeParse(json);
		if (!parsed.success) {
			throw new ToolError("geocoding_failed", "The geocoding service returned an unexpected format", {
				provider: PROVIDER,
				retryable: true,
			});
		}
		return (parsed.data.results ?? []).map((r) => ({
			name: r.name,
			lat: r.latitude,
			lon: r.longitude,
			country: r.country,
			country_code: r.country_code,
			admin1: r.admin1,
			population: r.population,
		}));
	}
}
