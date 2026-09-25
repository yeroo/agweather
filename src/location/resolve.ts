import { ToolError } from "../lib/errors";
import type { Geocoder, GeoResult, LocationInput, ResolvedLocation } from "../types/location";
import { PRESETS } from "./presets";

export const normalize = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** "Minsk, Belarus" -> { place: "Minsk", qualifier: "Belarus" }. The qualifier may be a country, code or region. */
export function splitQuery(query: string): { place: string; qualifier?: string } {
	const parts = query.split(",").map((p) => p.trim()).filter(Boolean);
	const place = parts[0] ?? "";
	const qualifier = parts.length > 1 ? parts.slice(1).join(", ") : undefined;
	return { place, qualifier };
}

function matchesQualifier(r: GeoResult, qualifier: string): boolean {
	const q = normalize(qualifier);
	return [r.country, r.country_code, r.admin1].some((v) => v !== undefined && normalize(v) === q);
}

function findPreset(place: string, qualifier?: string): GeoResult | undefined {
	return PRESETS.find((p) => normalize(p.name) === normalize(place) && (!qualifier || matchesQualifier(p, qualifier)));
}

export interface ResolveDeps {
	geocoder: Geocoder;
	defaultLocation: string;
}

export async function resolveLocation(input: LocationInput, deps: ResolveDeps): Promise<ResolvedLocation> {
	const hasLat = input.lat !== undefined;
	const hasLon = input.lon !== undefined;
	if (hasLat !== hasLon) throw new ToolError("invalid_input", "Pass both lat and lon, or neither");
	if (hasLat && input.location !== undefined) {
		throw new ToolError("invalid_input", "Pass either location or lat/lon, not both");
	}
	if (hasLat) {
		const lat = input.lat!;
		const lon = input.lon!;
		if (!Number.isFinite(lat) || lat < -85 || lat > 85 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
			throw new ToolError("invalid_input", "lat must be within -85..85 and lon within -180..180");
		}
		return { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon, resolved_by: "coordinates", is_default: false };
	}

	const isDefault = input.location === undefined || input.location.trim() === "";
	const query = isDefault ? deps.defaultLocation : input.location!;
	const { place, qualifier } = splitQuery(query);
	if (!place) throw new ToolError("invalid_input", "location is empty");

	const preset = findPreset(place, qualifier);
	if (preset) return toResolved(preset, "preset", query, isDefault);

	const results = await deps.geocoder.search(place);
	const candidates = qualifier ? results.filter((r) => matchesQualifier(r, qualifier)) : results;
	const best = candidates[0];
	if (!best) {
		throw new ToolError("unknown_location", `No place found for "${query}"; try "City, Country" or pass lat/lon`, {
			provider: deps.geocoder.name,
		});
	}
	return toResolved(best, "geocoder", query, isDefault);
}

function toResolved(r: GeoResult, by: ResolvedLocation["resolved_by"], query: string, isDefault: boolean): ResolvedLocation {
	return {
		name: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : undefined, r.country].filter(Boolean).join(", "),
		lat: r.lat,
		lon: r.lon,
		...(r.country ? { country: r.country } : {}),
		...(r.country_code ? { country_code: r.country_code } : {}),
		...(r.admin1 ? { admin1: r.admin1 } : {}),
		resolved_by: by,
		query,
		is_default: isDefault,
	};
}
