import type { RadarIndex, RawFrame } from "../providers/rainviewer/parse";

export type { RadarIndex, RawFrame };

export interface CoverageInfo {
	center_covered: boolean;
	/** Share of the coverage tile (sampled on a grid) that radar covers, 0..1. */
	covered_fraction: number;
}

/** What the latest radar frame shows at (and around) one point. Always an observation. */
export interface PointObservation {
	source: "rainviewer";
	kind: "observation";
	observed_at: string;
	frame_time: number;
	method: string;
	km_per_px: number;
	nearby_radius_km: number;
	/** null when the coverage check failed. */
	center_covered: boolean | null;
	/** dBZ at the point: null = no echo; a range because the palette saturates above 64 dBZ. */
	dbz_at_point: { min: number; max: number } | null;
	nearby_max_dbz: { min: number; max: number } | null;
	precip_threshold_dbz: number;
	/** null = cannot tell (point outside radar coverage, or the pixel could not be read). */
	precip_at_point: boolean | null;
	precip_nearby: boolean | null;
}

export interface TileRequest {
	size: 256 | 512;
	zoom: number;
	lat: number;
	lon: number;
	smooth: 0 | 1;
	snow: 0 | 1;
}

export interface RadarProvider {
	readonly name: string;
	index(): Promise<RadarIndex>;
	frameUrl(index: RadarIndex, frame: RawFrame, tile: TileRequest): string;
	image(url: string): Promise<Uint8Array>;
	coverage(index: RadarIndex, lat: number, lon: number, zoom: number): Promise<CoverageInfo>;
	pointObservation(lat: number, lon: number, index?: RadarIndex): Promise<PointObservation>;
}
