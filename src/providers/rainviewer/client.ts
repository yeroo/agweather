import { ToolError } from "../../lib/errors";
import type { HttpClient } from "../../lib/http";
import { kmPerPx, MAX_RADAR_ZOOM, round } from "../../location/geo-math";
import type { CoverageInfo, PointObservation, RadarProvider, TileRequest } from "../../types/radar";
import { parseWeatherMaps, type RadarIndex, type RawFrame } from "./parse";
import { decodePng } from "./png";
import { coverageStats, PRECIP_THRESHOLD_DBZ, sampleAround } from "./sample";
import { coverageTileUrl, frameTileUrl } from "./tiles";

export const RAINVIEWER_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
const PROVIDER = "rainviewer";

/** Cache lifetimes, seconds. Frame paths are content hashes, so a frame URL never changes content. */
export const RAINVIEWER_TTL = { index: 60, frame: 2 * 3600, coverage: 24 * 3600 } as const;

/** Point samples use a 256 px raw-colour tile at the max zoom (~0.7 km/px at 54°N). */
const SAMPLE_SIZE = 256;
const SAMPLE_ZOOM = MAX_RADAR_ZOOM;
const NEARBY_RADIUS_KM = 10;
/** Share of unreadable (off-table colour) ring pixels above which precip_nearby is reported as unknown. */
const MAX_UNKNOWN_FRACTION = 0.5;

export const toIso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export class RainViewerProvider implements RadarProvider {
	readonly name = PROVIDER;

	constructor(private readonly http: HttpClient) {}

	async index(): Promise<RadarIndex> {
		let json: unknown;
		try {
			json = await this.http.json(RAINVIEWER_INDEX_URL, { provider: PROVIDER, ttlSeconds: RAINVIEWER_TTL.index });
		} catch (err) {
			// Timeouts and rate limits keep their own codes; any other failure means "no radar right now".
			if (err instanceof ToolError && err.code === "provider_unavailable") {
				throw new ToolError("radar_unavailable", `Radar data is unavailable: ${err.message}`, {
					provider: PROVIDER,
					retryable: err.retryable,
				});
			}
			throw err;
		}
		return parseWeatherMaps(json);
	}

	frameUrl(index: RadarIndex, frame: RawFrame, tile: TileRequest): string {
		return frameTileUrl(index.host, frame.path, tile);
	}

	image(url: string): Promise<Uint8Array> {
		return this.http.bytes(url, { provider: PROVIDER, ttlSeconds: RAINVIEWER_TTL.frame, edgeCache: true });
	}

	async coverage(index: RadarIndex, lat: number, lon: number, zoom: number): Promise<CoverageInfo> {
		const url = coverageTileUrl(index.host, { size: 256, zoom, lat, lon });
		const bytes = await this.http.bytes(url, { provider: PROVIDER, ttlSeconds: RAINVIEWER_TTL.coverage, edgeCache: true });
		const stats = coverageStats(await decodeOrFail(bytes));
		return { center_covered: stats.centerCovered, covered_fraction: round(stats.coveredFraction, 3) };
	}

	async pointObservation(lat: number, lon: number, knownIndex?: RadarIndex): Promise<PointObservation> {
		const index = knownIndex ?? (await this.index());
		const latest = index.past[index.past.length - 1]!;
		const url = this.frameUrl(index, latest, { size: SAMPLE_SIZE, zoom: SAMPLE_ZOOM, lat, lon, smooth: 0, snow: 0 });
		const kmpp = kmPerPx(lat, SAMPLE_ZOOM, SAMPLE_SIZE);
		const ringPx = Math.min(20, Math.max(1, Math.round(NEARBY_RADIUS_KM / kmpp)));
		const c = SAMPLE_SIZE / 2;

		const [bytes, coverage] = await Promise.all([
			this.image(url),
			this.coverage(index, lat, lon, SAMPLE_ZOOM).catch(() => null),
		]);
		const sample = sampleAround(await decodeOrFail(bytes, c + ringPx + 1), c, c, ringPx);

		const covered = coverage ? coverage.center_covered : null;
		const atPoint = sample.center.kind === "echo" ? sample.center.dbz : null;
		// Without radar coverage "no echo" means "no data", not "dry".
		const knowable = covered !== false;
		const precipAtPoint =
			!knowable || sample.center.kind === "unknown" ? null : (atPoint?.min ?? -Infinity) >= PRECIP_THRESHOLD_DBZ;
		// A readable echo proves precipitation even if other pixels are unreadable (they can only hide echoes).
		// "No precipitation nearby" is only claimed when most of the ring could be read.
		const echoNearby = (sample.nearbyMax?.min ?? -Infinity) >= PRECIP_THRESHOLD_DBZ;
		const nearbyReadable = sample.unknownFraction < MAX_UNKNOWN_FRACTION;
		const precipNearby = !knowable ? null : echoNearby ? true : nearbyReadable ? false : null;

		return {
			source: PROVIDER,
			kind: "observation",
			observed_at: toIso(latest.time),
			frame_time: latest.time,
			method:
				"Pixel colour of the latest observed radar frame, inverted to reflectivity (dBZ) with RainViewer's published Universal Blue colour table.",
			km_per_px: round(kmpp, 3),
			nearby_radius_km: round(ringPx * kmpp, 1),
			center_covered: covered,
			dbz_at_point: atPoint,
			nearby_max_dbz: sample.nearbyMax,
			precip_threshold_dbz: PRECIP_THRESHOLD_DBZ,
			precip_at_point: precipAtPoint,
			precip_nearby: precipNearby,
		};
	}
}

async function decodeOrFail(bytes: Uint8Array, maxRows?: number) {
	try {
		return await decodePng(bytes, { maxRows });
	} catch {
		throw new ToolError("radar_unavailable", "RainViewer returned an image that could not be read", {
			provider: PROVIDER,
			retryable: true,
		});
	}
}
