import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodePng, pixelAt } from "../src/providers/rainviewer/png";
import { coverageStats, readPixel, sampleAround } from "../src/providers/rainviewer/sample";
import { encodePng, fixture } from "./helpers";

const sha = (rows: Uint8Array[]) => {
	const h = createHash("sha256");
	for (const r of rows) h.update(r);
	return h.digest("hex");
};

describe("decodePng", () => {
	// Reference: sha256 of the full RGBA pixel array as decoded by Pillow.
	it.each([
		["rainviewer-sample-256-z4-minsk.png", "7e6559bef4eaae1523f27b92d262a7fb8d1d378400be066aa993ea69ebcab47e"],
		["rainviewer-frame-512.png", "486fc3b7a9aab99bbf81c815dd94cf70e3cacc698529ee70dd366ad8c44b6448"],
		["coverage-partial.png", "7b3b4fba94b7e8d2ac59fdb7d2984735472af5202f1bb4250087731c1e4ec691"],
	])("decodes real tile %s identically to Pillow", async (name, expected) => {
		const png = await decodePng(fixture(name));
		expect(png.channels).toBe(4);
		expect(png.rows).toHaveLength(png.height);
		expect(sha(png.rows)).toBe(expected);
	});

	it("stops after maxRows, and the rows it did decode match Pillow", async () => {
		const png = await decodePng(fixture("rainviewer-frame-512.png"), { maxRows: 141 });
		expect(png.rows).toHaveLength(141);
		expect(png.height).toBe(512);
		expect(sha(png.rows)).toBe("930b53eeebd19f387b0fdf58feae22fbbb29e62d2b9faf32322b39d2b7736269");
	});

	it("handles all five PNG filter types", async () => {
		const color = (x: number, y: number): [number, number, number, number] => [
			(x * 7 + y) & 255,
			(x * y) & 255,
			(255 - x) & 255,
			(x + 3 * y) & 255,
		];
		const png = await decodePng(encodePng(37, 25, color, (y) => y % 5));
		for (let y = 0; y < 25; y++) for (let x = 0; x < 37; x++) expect(pixelAt(png, x, y)).toEqual(color(x, y));
	});

	it("rejects non-PNG input", async () => {
		await expect(decodePng(new TextEncoder().encode("<html>Zoom Level Not Supported</html>"))).rejects.toThrow(/not a PNG/);
	});
});

describe("colour -> dBZ (Universal Blue table)", () => {
	it("reads a real echo pixel of the fixture tile: #0088bf = 23 dBZ", async () => {
		const png = await decodePng(fixture("rainviewer-sample-256-z4-minsk.png"));
		expect(pixelAt(png, 119, 116)).toEqual([0, 136, 191, 255]);
		expect(readPixel(pixelAt(png, 119, 116))).toEqual({ kind: "echo", dbz: { min: 23, max: 23 } });
		// The fixture's centre pixel has no echo.
		expect(readPixel(pixelAt(png, 128, 128))).toEqual({ kind: "no_echo" });
	});

	it("every coloured pixel of the real sample tile is in the table", async () => {
		const png = await decodePng(fixture("rainviewer-sample-256-z4-minsk.png"));
		const s = sampleAround(png, 128, 128, 127);
		expect(s.unknownFraction).toBe(0);
		expect(s.nearbyMax!.min).toBeGreaterThan(20);
	});

	it("the saturated top of the palette inverts to a range", () => {
		expect(readPixel([0, 255, 0, 255])).toEqual({ kind: "echo", dbz: { min: 75, max: 95 } });
		expect(readPixel([255, 255, 255, 255])).toEqual({ kind: "echo", dbz: { min: 65, max: 74 } });
	});

	it("colours outside the table are reported as unknown, not guessed", () => {
		expect(readPixel([1, 2, 3, 255])).toEqual({ kind: "unknown" });
	});
});

describe("coverage tiles", () => {
	it("covered / partial / none fixtures", async () => {
		expect(coverageStats(await decodePng(fixture("coverage-covered.png"))).centerCovered).toBe(true);
		const partial = coverageStats(await decodePng(fixture("coverage-partial.png")));
		expect(partial.centerCovered).toBe(false);
		expect(partial.coveredFraction).toBeGreaterThan(0);
		expect(coverageStats(await decodePng(fixture("coverage-none.png"))).coveredFraction).toBe(0);
	});
});
