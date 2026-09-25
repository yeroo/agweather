import type { GeoResult } from "../types/location";

/**
 * Built-in locations: the default path (Minsk) and the issue's named examples resolve
 * without a network call. Coordinates are the city centres used by GeoNames.
 */
export const PRESETS: readonly GeoResult[] = [
	{ name: "Minsk", lat: 53.9, lon: 27.5667, country: "Belarus", country_code: "BY", admin1: "Minsk City" },
	{ name: "Barcelona", lat: 41.3888, lon: 2.159, country: "Spain", country_code: "ES", admin1: "Catalonia" },
	{ name: "Houston", lat: 29.7633, lon: -95.3633, country: "United States", country_code: "US", admin1: "Texas" },
];
