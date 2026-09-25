import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/lib/base64";
import { fixture } from "./helpers";

describe("toBase64", () => {
	it("matches Node's encoder for every tail length and for inputs larger than one chunk", () => {
		const frame = fixture("rainviewer-frame-512.png");
		expect(frame.length).toBeGreaterThan(0x2000 * 2);
		for (const len of [0, 1, 2, 3, 4, 5, 0x2000, 0x2001, frame.length]) {
			const b = frame.subarray(0, len);
			expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
		}
	});
});
