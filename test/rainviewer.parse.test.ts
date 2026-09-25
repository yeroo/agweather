import { describe, expect, it } from "vitest";
import { ToolError } from "../src/lib/errors";
import { parseWeatherMaps } from "../src/providers/rainviewer/parse";
import { fixtureJson } from "./helpers";

describe("parseWeatherMaps", () => {
	it("parses the real weather-maps.json: host, 13 observed frames ascending", () => {
		const idx = parseWeatherMaps(fixtureJson("rainviewer-weather-maps.json"));
		expect(idx.host).toBe("https://tilecache.rainviewer.com");
		expect(idx.past).toHaveLength(13);
		const times = idx.past.map((f) => f.time);
		expect(times).toEqual([...times].sort((a, b) => a - b));
		expect(idx.past[0]!.path).toMatch(/^\/v2\/radar\//);
		expect(idx.nowcastCount).toBe(0);
	});

	it("never mixes nowcast frames into observations", () => {
		const json = {
			host: "https://tilecache.rainviewer.com",
			radar: { past: [{ time: 100, path: "/p/a" }], nowcast: [{ time: 200, path: "/n/b" }, { time: 300, path: "/n/c" }] },
		};
		const idx = parseWeatherMaps(json);
		expect(idx.past.map((f) => f.path)).toEqual(["/p/a"]);
		expect(idx.nowcastCount).toBe(2);
	});

	it.each([
		["missing host", { radar: { past: [{ time: 1, path: "/a" }] } }],
		["missing radar", { host: "https://x.example" }],
		["frame without path", { host: "https://x.example", radar: { past: [{ time: 1 }] } }],
		["not an object", "<html>"],
	])("rejects %s with radar_unavailable", (_name, json) => {
		let err: unknown;
		try {
			parseWeatherMaps(json);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ToolError);
		expect((err as ToolError).code).toBe("radar_unavailable");
		expect((err as ToolError).provider).toBe("rainviewer");
	});

	it("rejects an empty past list with radar_unavailable", () => {
		expect(() => parseWeatherMaps({ host: "https://x.example", radar: { past: [] } })).toThrow(/no radar frames/);
	});
});
