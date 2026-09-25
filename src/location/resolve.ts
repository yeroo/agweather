import { ToolError } from "../lib/errors";
import type { Geocoder, GeoResult, LocationInput, ResolvedLocation } from "../types/location";
import { COUNTRY_ALIASES, US_STATES } from "./aliases";
import { PRESETS } from "./presets";

export const normalize = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * "Houston, Texas, USA" -> { place: "Houston", qualifiers: ["Texas", "USA"] }.
 * Each qualifier may be a country, country code, region (admin1) or US state code.
 */
export function splitQuery(query: string): { place: string; qualifiers: string[] } {
	const parts = query.split(",").map((p) => p.trim()).filter(Boolean);
	return { place: parts[0] ?? "", qualifiers: parts.slice(1) };
}

function qualifierMatches(r: GeoResult, qualifier: string): boolean {
	const q = normalize(qualifier);
	const values = [r.country, r.country_code, r.admin1].filter((v): v is string => v !== undefined).map(normalize);
	if (values.includes(q)) return true;
	const aliasCountry = COUNTRY_ALIASES[q];
	if (aliasCountry && r.country_code?.toUpperCase() === aliasCountry) return true;
	const state = US_STATES[qualifier.trim().toUpperCase()];
	return state !== undefined && r.country_code?.toUpperCase() === "US" && normalize(r.admin1 ?? "") === normalize(state);
}

const matchCount = (r: GeoResult, qualifiers: readonly string[]) => qualifiers.filter((q) => qualifierMatches(r, q)).length;

function findPreset(place: string, qualifiers: readonly string[]): GeoResult | undefined {
	return PRESETS.find((p) => normalize(p.name) === normalize(place) && matchCount(p, qualifiers) === qualifiers.length);
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
	const { place, qualifiers } = splitQuery(query);
	if (!place) throw new ToolError("invalid_input", "location is empty");

	const preset = findPreset(place, qualifiers);
	if (preset) return toResolved(preset, "preset", query, isDefault);

	const results = await deps.geocoder.search(place);
	if (results.length === 0) {
		throw new ToolError("unknown_location", `No place found for "${query}"; try "City, Country" or pass lat/lon`, {
			provider: deps.geocoder.name,
		});
	}
	// Qualifiers rank results (most matches first, geocoder order otherwise); they never filter to nothing.
	const ranked = results.map((r, i) => ({ r, i, n: matchCount(r, qualifiers) })).sort((a, b) => b.n - a.n || a.i - b.i);
	const best = ranked[0]!;
	const resolved = toResolved(best.r, "geocoder", query, isDefault);
	if (best.n < qualifiers.length) {
		const unmatched = qualifiers.filter((q) => !qualifierMatches(best.r, q));
		resolved.match_note = `Could not confirm ${unmatched.map((q) => `"${q}"`).join(", ")} for any match; using the geocoder's best result (${resolved.name}). Pass lat/lon if this is the wrong place.`;
	}
	return resolved;
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
