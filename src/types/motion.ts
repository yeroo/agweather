/**
 * Shape reserved for a future precipitation-motion estimator (not implemented in v1).
 * An implementation would compare consecutive radar frames (see RadarProvider) and report
 * how the echoes move. v1 tools return `motion: { available: false, reason }` instead.
 */
export interface MotionEstimate {
	source: string;
	kind: "radar_nowcast";
	based_on_frames: { from: string; to: string; count: number };
	/** Displacement per hour, km east / km north. */
	vector_kmh: { east: number; north: number };
	/** Direction the echoes move towards, degrees clockwise from north. */
	direction_deg: number;
	speed_kmh: number;
	/** 0..1 */
	confidence: number;
	approaching_cells?: { distance_km: number; bearing_deg: number; eta_minutes: number | null; max_dbz: number }[];
	end_of_precipitation_at?: string | null;
}

export interface MotionEstimator {
	estimate(frames: { time: number; image: Uint8Array }[], center: { lat: number; lon: number }): Promise<MotionEstimate>;
}

export const MOTION_NOT_IMPLEMENTED = { available: false, reason: "not_implemented_v1" } as const;
