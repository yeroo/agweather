import { z } from "zod";
import { ToolError } from "../../lib/errors";

const FrameSchema = z.object({ time: z.number().int().positive(), path: z.string().min(1) });

const WeatherMapsSchema = z.object({
	version: z.string().optional(),
	generated: z.number().optional(),
	host: z.string().url(),
	radar: z.object({
		past: z.array(FrameSchema),
		nowcast: z.array(FrameSchema).optional(),
	}),
});

export interface RawFrame {
	time: number;
	path: string;
}

export interface RadarIndex {
	host: string;
	generated?: number;
	/** Observed frames, ascending by time, duplicates removed. */
	past: RawFrame[];
	/** Number of nowcast frames upstream advertised. They are never mixed into observations. */
	nowcastCount: number;
}

export function parseWeatherMaps(json: unknown): RadarIndex {
	const parsed = WeatherMapsSchema.safeParse(json);
	if (!parsed.success) {
		throw new ToolError("radar_unavailable", "RainViewer returned an unexpected radar index format", {
			provider: "rainviewer",
			retryable: true,
		});
	}
	const { host, generated, radar } = parsed.data;
	const past = sortFrames(radar.past);
	if (past.length === 0) {
		throw new ToolError("radar_unavailable", "RainViewer currently lists no radar frames", {
			provider: "rainviewer",
			retryable: true,
		});
	}
	return { host: host.replace(/\/+$/, ""), generated, past, nowcastCount: radar.nowcast?.length ?? 0 };
}

function sortFrames(frames: RawFrame[]): RawFrame[] {
	const byTime = new Map<number, RawFrame>();
	for (const f of frames) byTime.set(f.time, f);
	return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export const MAX_FRAMES = 12;

/** The last `n` observed frames in chronological order (n clamped to 1..MAX_FRAMES). */
export function selectFrames(frames: readonly RawFrame[], n: number): RawFrame[] {
	const count = Math.min(MAX_FRAMES, Math.max(1, Math.floor(n)));
	return sortFrames([...frames]).slice(-count);
}
