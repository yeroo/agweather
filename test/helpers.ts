import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createCaches } from "../src/lib/cache";
import type { FetchFn } from "../src/lib/http";
import { createLogger } from "../src/lib/log";
import { depsFactory } from "../src/mcp/deps";
import type { ToolDeps } from "../src/tools/deps";

export const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
export const fixtureJson = (name: string) => JSON.parse(new TextDecoder().decode(fixture(name))) as unknown;

/** Fixed clock matching the captured fixtures (RainViewer latest frame 09:10Z, Open-Meteo run ~09:13Z). */
export const NOW = new Date("2026-09-25T09:15:00Z");

// ---------------------------------------------------------------- PNG encoding

function crc32(buf: Uint8Array): number {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/**
 * Encode an RGBA image. `filterFor(y)` picks the PNG filter per row (0-4) so the decoder's
 * unfiltering is exercised; real RainViewer tiles currently only use filter 0.
 */
export function encodePng(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number], filterFor: (y: number) => number = () => 0): Uint8Array {
	const stride = width * 4;
	const raw = new Uint8Array(height * (stride + 1));
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const line = new Uint8Array(stride);
		for (let x = 0; x < width; x++) line.set(rgba(x, y), x * 4);
		const f = filterFor(y);
		raw[y * (stride + 1)] = f;
		for (let i = 0; i < stride; i++) {
			const a = i >= 4 ? line[i - 4]! : 0;
			const b = prev[i]!;
			const c = i >= 4 ? prev[i - 4]! : 0;
			let pred = 0;
			if (f === 1) pred = a;
			else if (f === 2) pred = b;
			else if (f === 3) pred = (a + b) >> 1;
			else if (f === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			raw[y * (stride + 1) + 1 + i] = (line[i]! - pred) & 0xff;
		}
		prev = line;
	}
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

const hex = (h: string): [number, number, number, number] => [0, 2, 4, 6].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as never;

/** A 256 px radar tile, transparent except a disc of `color` (Universal Blue hex) around the centre. */
export function radarTileWithEcho(colorHex: string, radiusPx = 6): Uint8Array {
	const c = hex(colorHex);
	return encodePng(256, 256, (x, y) => ((x - 128) ** 2 + (y - 128) ** 2 <= radiusPx ** 2 ? c : [0, 0, 0, 0]));
}

export const emptyRadarTile = () => encodePng(256, 256, () => [0, 0, 0, 0]);

/** Coverage tile: transparent = covered. */
export const coverageTile = (covered: (x: number, y: number) => boolean) =>
	encodePng(256, 256, (x, y) => (covered(x, y) ? [255, 255, 255, 0] : [0, 0, 0, 255]));

// ---------------------------------------------------------------- fetch mock

export interface MockCall {
	url: string;
	init?: RequestInit;
}

export type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

export interface MockFetch {
	fetch: FetchFn;
	calls: MockCall[];
	count(pattern: RegExp): number;
}

export function mockFetch(...routes: Route[]): MockFetch {
	const calls: MockCall[] = [];
	return {
		calls,
		count: (pattern) => calls.filter((c) => pattern.test(c.url)).length,
		fetch: async (url, init) => {
			calls.push({ url, init });
			for (const r of routes) {
				const res = await r(url, init);
				if (res) return res;
			}
			throw new Error(`unmocked fetch: ${url.replace(/apikey=[^&]*/, "apikey=***")}`);
		},
	};
}

export const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const pngResponse = (bytes: Uint8Array) => new Response(bytes, { headers: { "content-type": "image/png" } });

export const route = (pattern: RegExp, respond: (url: string) => Response | Promise<Response>): Route =>
	(url) => (pattern.test(url) ? respond(url) : undefined);

/** A fetch that never answers but honours the abort signal (for timeout tests). */
export const hangingRoute = (pattern: RegExp): Route => (url, init) =>
	pattern.test(url)
		? new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
			})
		: undefined;

export interface UpstreamOptions {
	/** 256 px raw-colour sample tile (point observation). Default: real fixture (no echo at the centre). */
	sampleTile?: Uint8Array;
	/** Coverage tile. Default: real fixture where the centre is covered. */
	coverage?: Uint8Array;
	weatherMaps?: unknown;
	openMeteo?: unknown;
	meteoblue?: unknown;
	geocode?: unknown;
}

/** Routes for every upstream, answering with the captured fixtures. Put overriding routes first. */
export function upstreamRoutes(o: UpstreamOptions = {}): Route[] {
	return [
		route(/api\.rainviewer\.com\/public\/weather-maps\.json/, () => jsonResponse(o.weatherMaps ?? fixtureJson("rainviewer-weather-maps.json"))),
		route(/tilecache\.rainviewer\.com\/v2\/coverage\//, () => pngResponse(o.coverage ?? fixture("coverage-covered.png"))),
		route(/tilecache\.rainviewer\.com\/v2\/radar\/[^/]+\/256\//, () => pngResponse(o.sampleTile ?? fixture("rainviewer-sample-256-z4-minsk.png"))),
		route(/tilecache\.rainviewer\.com\/v2\/radar\/[^/]+\/512\//, () => pngResponse(fixture("rainviewer-frame-512.png"))),
		route(/api\.open-meteo\.com\/v1\/forecast/, () => jsonResponse(o.openMeteo ?? fixtureJson("openmeteo-forecast-minsk.json"))),
		route(/geocoding-api\.open-meteo\.com/, () => jsonResponse(o.geocode ?? fixtureJson("openmeteo-geocode-minsk.json"))),
		route(/my\.meteoblue\.com\/packages\//, () => jsonResponse(o.meteoblue ?? fixtureJson("meteoblue-basic-1h-minsk.json"))),
	];
}

export const TEST_METEOBLUE_KEY = "mbTESTKEY1234567890secret";

export interface TestDeps {
	deps: ToolDeps;
	fetch: MockFetch;
	logs: string[];
	caches: ReturnType<typeof createCaches>;
	providers: Set<string>;
}

export function makeTestDeps(
	opts: { routes?: Route[]; upstream?: UpstreamOptions; meteoblueKey?: string; meteobluePackage?: string; timeoutMs?: number; defaultLocation?: string; caches?: ReturnType<typeof createCaches> } = {},
): TestDeps {
	const fetch = mockFetch(...(opts.routes ?? []), ...upstreamRoutes(opts.upstream));
	const logs: string[] = [];
	const caches = opts.caches ?? createCaches(() => NOW.getTime());
	const providers = new Set<string>();
	const logger = createLogger({ secrets: [opts.meteoblueKey], sink: (l) => logs.push(l) });
	const deps = depsFactory(
		{ DEFAULT_LOCATION: opts.defaultLocation ?? "Minsk, Belarus", METEOBLUE_API_KEY: opts.meteoblueKey, METEOBLUE_PACKAGE: opts.meteobluePackage },
		{ fetch: fetch.fetch, caches, logger, now: () => NOW, timeoutMs: opts.timeoutMs },
	)((p) => providers.add(p));
	return { deps, fetch, logs, caches, providers };
}

/** Minimal in-memory KVNamespace for workers-oauth-provider. */
export function memoryKv(): KVNamespace & { store: Map<string, string> } {
	const store = new Map<string, string>();
	const kv = {
		store,
		async get(key: string, type?: unknown) {
			const v = store.get(key);
			if (v === undefined) return null;
			const t = typeof type === "string" ? type : (type as { type?: string } | undefined)?.type;
			return t === "json" ? JSON.parse(v) : v;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list(opts?: { prefix?: string }) {
			const keys = [...store.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).map((name) => ({ name }));
			return { keys, list_complete: true, cacheStatus: null };
		},
		async getWithMetadata(key: string, type?: unknown) {
			return { value: await kv.get(key, type), metadata: null, cacheStatus: null };
		},
	};
	return kv as never;
}
