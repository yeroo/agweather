import { UNIVERSAL_BLUE_MIN_DBZ, UNIVERSAL_BLUE_RGBA } from "./colors";
import { type DecodedPng, pixelAt } from "./png";

export interface DbzRange {
	min: number;
	max: number;
}

let inverse: Map<number, DbzRange> | undefined;

function key(r: number, g: number, b: number, a: number): number {
	return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function inverseTable(): Map<number, DbzRange> {
	if (inverse) return inverse;
	inverse = new Map();
	UNIVERSAL_BLUE_RGBA.forEach((hex, i) => {
		const dbz = UNIVERSAL_BLUE_MIN_DBZ + i;
		const k = Number.parseInt(hex, 16) >>> 0;
		const hit = inverse!.get(k);
		if (hit) hit.max = dbz;
		else inverse!.set(k, { min: dbz, max: dbz });
	});
	return inverse;
}

export type PixelReading =
	| { kind: "no_echo" }
	| { kind: "echo"; dbz: DbzRange }
	/** Colour not in the table (e.g. smoothing or a palette change upstream). */
	| { kind: "unknown" };

export function readPixel(rgba: readonly [number, number, number, number] | undefined): PixelReading {
	if (!rgba) return { kind: "unknown" };
	const [r, g, b, a] = rgba;
	if (a === 0) return { kind: "no_echo" };
	const hit = inverseTable().get(key(r, g, b, a));
	return hit ? { kind: "echo", dbz: { ...hit } } : { kind: "unknown" };
}

/**
 * Reflectivity threshold used for "precipitation detected". Around 10 dBZ is the usual
 * floor for light rain/drizzle; weaker echoes are often clutter. Heuristic, reported in the output.
 */
export const PRECIP_THRESHOLD_DBZ = 10;

export interface PixelSample {
	center: PixelReading;
	/** Strongest echo within `ringPx` pixels of the centre (null when none, or nothing readable). */
	nearbyMax: DbzRange | null;
	/** Share of readable pixels in the ring whose colour was not in the table. */
	unknownFraction: number;
}

export function sampleAround(png: DecodedPng, cx: number, cy: number, ringPx: number): PixelSample {
	const center = readPixel(pixelAt(png, cx, cy));
	let nearbyMax: DbzRange | null = null;
	let total = 0;
	let unknown = 0;
	for (let y = cy - ringPx; y <= cy + ringPx; y++) {
		for (let x = cx - ringPx; x <= cx + ringPx; x++) {
			if ((x - cx) ** 2 + (y - cy) ** 2 > ringPx ** 2) continue;
			const p = pixelAt(png, x, y);
			if (!p) continue;
			total++;
			const r = readPixel(p);
			if (r.kind === "unknown") unknown++;
			else if (r.kind === "echo" && (!nearbyMax || r.dbz.min > nearbyMax.min)) nearbyMax = r.dbz;
		}
	}
	return { center, nearbyMax, unknownFraction: total ? unknown / total : 1 };
}

/** Coverage tiles: transparent pixel = covered by radar, opaque black = no coverage. */
export function coverageStats(png: DecodedPng, step = 4): { centerCovered: boolean; coveredFraction: number } {
	const cx = Math.floor(png.width / 2);
	const cy = Math.floor(png.height / 2);
	const isCovered = (x: number, y: number) => (pixelAt(png, x, y)?.[3] ?? 255) < 128;
	let total = 0;
	let covered = 0;
	for (let y = 0; y < png.rows.length; y += step) {
		for (let x = 0; x < png.width; x += step) {
			total++;
			if (isCovered(x, y)) covered++;
		}
	}
	return { centerCovered: isCovered(cx, cy), coveredFraction: total ? covered / total : 0 };
}
