import { describe, expect, it } from "vitest";
import { ToolError } from "../src/lib/errors";
import { resolveLocation, splitQuery } from "../src/location/resolve";
import { jsonResponse, makeTestDeps, route } from "./helpers";

const GEO = /geocoding-api\.open-meteo\.com/;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		return (e as ToolError).code;
	}
	return "no error";
}

describe("resolveLocation", () => {
	it("no location -> DEFAULT_LOCATION 'Minsk, Belarus' from the presets, without a network call", async () => {
		const t = makeTestDeps();
		const loc = await resolveLocation({}, t.deps);
		expect(loc).toMatchObject({ name: "Minsk, Minsk City, Belarus", lat: 53.9, resolved_by: "preset", is_default: true, query: "Minsk, Belarus" });
		expect(t.fetch.calls).toHaveLength(0);
	});

	it("DEFAULT_LOCATION is configurable", async () => {
		const t = makeTestDeps({ defaultLocation: "Houston" });
		const loc = await resolveLocation({}, t.deps);
		expect(loc).toMatchObject({ country_code: "US", admin1: "Texas", is_default: true });
	});

	it.each([
		["Barcelona", "ES", 41.3888, 2.159],
		["Houston", "US", 29.7633, -95.3633],
		["houston, texas", "US", 29.7633, -95.3633],
		["  MINSK ", "BY", 53.9, 27.5667],
	])("preset %s", async (q, cc, lat, lon) => {
		const t = makeTestDeps();
		const loc = await resolveLocation({ location: q }, t.deps);
		expect(loc).toMatchObject({ country_code: cc, lat, lon, resolved_by: "preset", is_default: false });
		expect(t.fetch.calls).toHaveLength(0);
	});

	it("'City, Country' goes to the geocoder when the preset's country differs, and filters by country", async () => {
		const t = makeTestDeps();
		const loc = await resolveLocation({ location: "Minsk, Russia" }, t.deps);
		expect(loc).toMatchObject({ name: "Minsk, Krasnoyarsk Krai, Russia", country: "Russia", admin1: "Krasnoyarsk Krai", resolved_by: "geocoder" });
		expect(t.fetch.count(GEO)).toBe(1);
		expect(t.fetch.calls[0]!.url).toContain("name=Minsk");
	});

	it("an arbitrary place resolves through the geocoder with admin1 and country", async () => {
		const t = makeTestDeps({
			upstream: { geocode: { results: [{ name: "Grodno", latitude: 53.68, longitude: 23.83, country: "Belarus", country_code: "BY", admin1: "Grodnenskaya" }] } },
		});
		const loc = await resolveLocation({ location: "Grodno" }, t.deps);
		expect(loc).toMatchObject({ name: "Grodno, Grodnenskaya, Belarus", lat: 53.68, lon: 23.83, country_code: "BY" });
	});

	it("explicit lat/lon skips geocoding", async () => {
		const t = makeTestDeps();
		const loc = await resolveLocation({ lat: 41.39, lon: 2.16 }, t.deps);
		expect(loc).toMatchObject({ lat: 41.39, lon: 2.16, resolved_by: "coordinates", is_default: false });
		expect(t.fetch.calls).toHaveLength(0);
	});

	it("location together with lat/lon is invalid_input", async () => {
		const t = makeTestDeps();
		expect(await codeOf(resolveLocation({ location: "Minsk", lat: 1, lon: 2 }, t.deps))).toBe("invalid_input");
	});

	it("only one of lat/lon is invalid_input", async () => {
		const t = makeTestDeps();
		expect(await codeOf(resolveLocation({ lat: 1 }, t.deps))).toBe("invalid_input");
	});

	it("geocoder with 0 results -> unknown_location", async () => {
		const t = makeTestDeps({ upstream: { geocode: { generationtime_ms: 0.8 } } });
		expect(await codeOf(resolveLocation({ location: "Nowhereville Zzz" }, t.deps))).toBe("unknown_location");
	});

	it("country filter with no match -> unknown_location (no silent fallback to another country)", async () => {
		const t = makeTestDeps();
		expect(await codeOf(resolveLocation({ location: "Minsk, Japan" }, t.deps))).toBe("unknown_location");
	});

	it("geocoder 500 -> geocoding_failed", async () => {
		const t = makeTestDeps({ routes: [route(GEO, () => jsonResponse({ error: true }, 500))] });
		const p = resolveLocation({ location: "Grodno" }, t.deps);
		await expect(p).rejects.toMatchObject({ code: "geocoding_failed", provider: "open-meteo-geocoding", retryable: true });
	});

	it("geocoder results are cached", async () => {
		const t = makeTestDeps();
		await resolveLocation({ location: "Minsk, Russia" }, t.deps);
		await resolveLocation({ location: "minsk, russia" }, t.deps);
		expect(t.fetch.count(GEO)).toBe(1);
	});
});

describe("splitQuery", () => {
	it("splits 'City, Country' and keeps multi-part qualifiers", () => {
		expect(splitQuery("Minsk, Belarus")).toEqual({ place: "Minsk", qualifier: "Belarus" });
		expect(splitQuery("Houston")).toEqual({ place: "Houston" });
	});
});
