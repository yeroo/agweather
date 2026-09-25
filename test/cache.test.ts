import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/lib/cache";
import { radarTool } from "../src/tools/radar";
import { makeTestDeps } from "./helpers";

describe("TtlCache", () => {
	it("expires entries after their TTL", () => {
		let t = 0;
		const c = new TtlCache<string>(10, () => t);
		c.set("a", "x", 60);
		expect(c.get("a")).toBe("x");
		t = 59_999;
		expect(c.get("a")).toBe("x");
		t = 60_000;
		expect(c.get("a")).toBeUndefined();
	});

	it("evicts the oldest entry beyond the cap", () => {
		const c = new TtlCache<number>(2, () => 0);
		c.set("a", 1, 60);
		c.set("b", 2, 60);
		c.set("c", 3, 60);
		expect(c.get("a")).toBeUndefined();
		expect(c.keys()).toEqual(["b", "c"]);
	});
});

describe("upstream downloads are deduplicated in the isolate", () => {
	// Only the in-isolate layer is testable here; the edge layer (fetch cf.cacheTtl) needs a deployed Worker.
	it("two radar() calls fetch the index and each frame URL once", async () => {
		const first = makeTestDeps();
		await radarTool({}, first.deps);
		const second = makeTestDeps({ caches: first.caches });
		await radarTool({}, second.deps);

		const all = [...first.fetch.calls, ...second.fetch.calls].map((c) => c.url);
		const frameUrls = all.filter((u) => u.includes("/512/"));
		expect(frameUrls).toHaveLength(6);
		expect(new Set(frameUrls).size).toBe(6);
		expect(all.filter((u) => u.includes("weather-maps.json"))).toHaveLength(1);
		expect(second.fetch.calls).toHaveLength(0);
	});

	it("keyless upstream GETs ask the edge cache to keep them", async () => {
		const t = makeTestDeps();
		await radarTool({ frames: 1 }, t.deps);
		const frame = t.fetch.calls.find((c) => c.url.includes("/512/"))!;
		expect(frame.init?.cf).toMatchObject({ cacheTtl: 7200, cacheEverything: true });
	});

	it("meteoblue (key in URL) is never edge-cached", async () => {
		const t = makeTestDeps({ meteoblueKey: "k-123456789" });
		const { precipitationNowcastTool } = await import("../src/tools/precipitation-nowcast");
		await precipitationNowcastTool({}, t.deps);
		const mb = t.fetch.calls.find((c) => c.url.includes("meteoblue"))!;
		expect(mb.init?.cf).toBeUndefined();
	});
});
