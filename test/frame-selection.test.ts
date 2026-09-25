import { describe, expect, it } from "vitest";
import { selectFrames } from "../src/providers/rainviewer/parse";

const frames = Array.from({ length: 13 }, (_, i) => ({ time: 1000 + i * 600, path: `/v2/radar/f${i}` }));
const order = [7, 0, 12, 3, 10, 1, 5, 11, 2, 9, 4, 8, 6];
const shuffled = order.map((i) => frames[i]!);

describe("selectFrames", () => {
	it("returns the last N frames in chronological order even when upstream order is shuffled", () => {
		const sel = selectFrames(shuffled, 6);
		expect(sel.map((f) => f.path)).toEqual([7, 8, 9, 10, 11, 12].map((i) => `/v2/radar/f${i}`));
	});

	it("clamps N to 1..12", () => {
		expect(selectFrames(frames, 0)).toHaveLength(1);
		expect(selectFrames(frames, 0)[0]!.path).toBe("/v2/radar/f12");
		expect(selectFrames(frames, 50)).toHaveLength(12);
		expect(selectFrames(frames, 50)[0]!.path).toBe("/v2/radar/f1");
	});

	it("drops duplicate timestamps", () => {
		const dup = [...frames.slice(-3), frames[12]!];
		expect(selectFrames(dup, 12).map((f) => f.time)).toEqual(frames.slice(-3).map((f) => f.time));
	});
});
