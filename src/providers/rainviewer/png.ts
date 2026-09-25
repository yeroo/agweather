/**
 * Minimal PNG decoder for RainViewer tiles (8-bit RGBA or RGB, non-interlaced).
 *
 * Inflate runs natively through DecompressionStream; only the per-row unfiltering is JS.
 * `maxRows` stops unfiltering early: each row only depends on the one above it, so a
 * centre-pixel read decodes about half the image. That keeps the Free-plan CPU budget.
 */

export interface DecodedPng {
	width: number;
	height: number;
	/** Bytes per pixel in `rows` (4 = RGBA, 3 = RGB). */
	channels: 3 | 4;
	/** Unfiltered rows 0..rows.length-1 (may be fewer than `height` when maxRows is set). */
	rows: Uint8Array[];
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngDecodeError extends Error {}

export async function decodePng(bytes: Uint8Array, opts: { maxRows?: number } = {}): Promise<DecodedPng> {
	if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngDecodeError("not a PNG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let width = 0;
	let height = 0;
	let channels: 3 | 4 = 4;
	const idat: Uint8Array[] = [];
	let off = 8;
	while (off + 8 <= bytes.length) {
		const len = view.getUint32(off);
		const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
		const data = bytes.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") {
			width = view.getUint32(off + 8);
			height = view.getUint32(off + 12);
			const bitDepth = data[8];
			const colorType = data[9];
			const interlace = data[12];
			if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
				throw new PngDecodeError(`unsupported PNG format (depth ${bitDepth}, color type ${colorType}, interlace ${interlace})`);
			}
			channels = colorType === 6 ? 4 : 3;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		off += 12 + len;
	}
	if (!width || !height || idat.length === 0) throw new PngDecodeError("PNG has no image data");

	const raw = await inflate(idat);
	const stride = width * channels;
	const wantRows = Math.min(height, opts.maxRows ?? height);
	if (raw.length < wantRows * (stride + 1)) throw new PngDecodeError("PNG data is truncated");

	const rows: Uint8Array[] = [];
	let prev = new Uint8Array(stride);
	for (let y = 0; y < wantRows; y++) {
		const start = y * (stride + 1);
		const filter = raw[start]!;
		const line = raw.slice(start + 1, start + 1 + stride);
		unfilter(filter, line, prev, channels);
		rows.push(line);
		prev = line;
	}
	return { width, height, channels, rows };
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
	const n = line.length;
	switch (filter) {
		case 0:
			return;
		case 1:
			for (let i = bpp; i < n; i++) line[i] = (line[i]! + line[i - bpp]!) & 0xff;
			return;
		case 2:
			for (let i = 0; i < n; i++) line[i] = (line[i]! + prev[i]!) & 0xff;
			return;
		case 3:
			for (let i = 0; i < n; i++) {
				const left = i >= bpp ? line[i - bpp]! : 0;
				line[i] = (line[i]! + ((left + prev[i]!) >> 1)) & 0xff;
			}
			return;
		case 4:
			for (let i = 0; i < n; i++) {
				const a = i >= bpp ? line[i - bpp]! : 0;
				const b = prev[i]!;
				const c = i >= bpp ? prev[i - bpp]! : 0;
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				line[i] = (line[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
			}
			return;
		default:
			throw new PngDecodeError(`bad PNG filter ${filter}`);
	}
}

async function inflate(parts: Uint8Array[]): Promise<Uint8Array> {
	// "deflate" in the Compression Streams API is the zlib-wrapped format PNG uses.
	const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA of pixel (x, y); RGB images report alpha 255. Undefined when the row was not decoded. */
export function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] | undefined {
	const row = png.rows[y];
	if (!row || x < 0 || x >= png.width) return undefined;
	const i = x * png.channels;
	return [row[i]!, row[i + 1]!, row[i + 2]!, png.channels === 4 ? row[i + 3]! : 255];
}
