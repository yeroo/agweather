import { describe, expect, it } from "vitest";
import { kmPerPx, radarGeometry, tileSpanKm, zoomForRadius } from "../src/location/geo-math";
import { coverageTileUrl, frameTileUrl } from "../src/providers/rainviewer/tiles";
import { radarTool } from "../src/tools/radar";
import { makeTestDeps } from "./helpers";

const MINSK_LAT = 53.9;

describe("radius -> zoom", () => {
	it("Minsk / 150 km needs z=6 (a z7 tile only spans ~184 km there)", () => {
		expect(tileSpanKm(MINSK_LAT, 7)).toBeCloseTo(184.5, 0);
		expect(zoomForRadius(MINSK_LAT, 150)).toBe(6);
		const g = radarGeometry(MINSK_LAT, 150, 512);
		expect(g.zoom).toBe(6);
		expect(g.span_km).toBeGreaterThanOrEqual(300);
		expect(g.km_per_px).toBeCloseTo(0.721, 3);
	});

	it("Minsk / 90 km fits z=7", () => {
		expect(zoomForRadius(MINSK_LAT, 90)).toBe(7);
	});

	it("small radii clamp to z=7 and report the effective radius actually delivered", () => {
		const g = radarGeometry(MINSK_LAT, 10, 512);
		expect(g.zoom).toBe(7);
		expect(g.requested_radius_km).toBe(10);
		expect(g.effective_radius_km).toBeCloseTo(92.2, 1);
	});

	it("large radius at 30° gives a lower zoom whose tile still covers 2x radius", () => {
		const z = zoomForRadius(30, 1000);
		expect(z).toBe(4);
		expect(tileSpanKm(30, z)).toBeGreaterThanOrEqual(2000);
		expect(tileSpanKm(30, z + 1)).toBeLessThan(2000);
	});

	it("a 512 px tile covers the same area as a 256 px tile (half the km per px)", () => {
		expect(kmPerPx(MINSK_LAT, 6, 256)).toBeCloseTo(2 * kmPerPx(MINSK_LAT, 6, 512), 6);
	});
});

describe("tile URLs never exceed z=7", () => {
	it("clamps an explicit zoom above 7", () => {
		const url = frameTileUrl("https://tilecache.rainviewer.com", "/v2/radar/abc", {
			size: 512,
			zoom: 9,
			lat: 53.9,
			lon: 27.56,
			smooth: 1,
			snow: 1,
		});
		expect(url).toBe("https://tilecache.rainviewer.com/v2/radar/abc/512/7/53.9000/27.5600/2/1_1.png");
		expect(coverageTileUrl("https://h", { size: 256, zoom: 12, lat: 1, lon: 2 })).toBe("https://h/v2/coverage/0/256/7/1.0000/2.0000/0/0_0.png");
	});

	it("radar() at the smallest radius only requests z<=7 tiles", async () => {
		const t = makeTestDeps();
		await radarTool({ radius_km: 10, frames: 12 }, t.deps);
		const tileCalls = t.fetch.calls.filter((c) => c.url.includes("tilecache.rainviewer.com"));
		expect(tileCalls.length).toBeGreaterThan(0);
		for (const c of tileCalls) {
			const z = Number(c.url.match(/\/(?:256|512)\/(\d+)\//)![1]);
			expect(z).toBeLessThanOrEqual(7);
		}
	});
});
