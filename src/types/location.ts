export interface GeoResult {
	name: string;
	lat: number;
	lon: number;
	country?: string;
	country_code?: string;
	admin1?: string;
	population?: number;
}

/** Name -> coordinates lookup. Implementations must not throw for "no match"; return []. */
export interface Geocoder {
	readonly name: string;
	search(name: string): Promise<GeoResult[]>;
}

export interface ResolvedLocation {
	name: string;
	lat: number;
	lon: number;
	country?: string;
	country_code?: string;
	admin1?: string;
	/** How the coordinates were obtained. */
	resolved_by: "preset" | "geocoder" | "coordinates";
	/** The text that was resolved (the input, or DEFAULT_LOCATION when none was given). */
	query?: string;
	is_default: boolean;
	/** Present when part of "City, Region, Country" could not be confirmed against the result. */
	match_note?: string;
}

export interface LocationInput {
	location?: string;
	lat?: number;
	lon?: number;
}
