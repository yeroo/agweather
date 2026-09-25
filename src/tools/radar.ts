import { z } from "zod";
import { toBase64 } from "../lib/base64";
import { errorPayload, ToolError } from "../lib/errors";
import { radarGeometry } from "../location/geo-math";
import { resolveLocation } from "../location/resolve";
import { MAX_FRAMES, selectFrames } from "../providers/rainviewer/parse";
import { toIso } from "../providers/rainviewer/client";
import { type ImageOut, settle, type ToolDeps, type ToolOutput } from "./deps";
import { locationFields, locationOut } from "./schemas";

export const RADAR_SIZE_PX = 512;

export const radarInput = z.object({
	...locationFields,
	radius_km: z.number().min(10).max(1000).default(150).describe("Radius around the point the images should cover, km."),
	frames: z.number().int().min(1).max(MAX_FRAMES).default(6).describe("How many of the latest observed frames (10 minutes apart)."),
	include_images: z.boolean().default(true).describe("Attach the PNG frames as images. false returns URLs and metadata only."),
});

export type RadarInput = z.input<typeof radarInput>;

export const radarOutput = z.looseObject({
	location: locationOut,
	observed_at: z.string(),
	radar: z.looseObject({
		source: z.literal("rainviewer"),
		kind: z.literal("observation"),
		zoom: z.number(),
		frames: z.array(z.looseObject({ time: z.number(), time_iso: z.string(), url: z.string() })),
	}),
});

export async function radarTool(raw: RadarInput, deps: ToolDeps): Promise<ToolOutput> {
	const input = radarInput.parse(raw);
	const location = await resolveLocation(input, deps);
	const index = await deps.radar.index();
	const geometry = radarGeometry(location.lat, input.radius_km, RADAR_SIZE_PX);
	const frames = selectFrames(index.past, input.frames);

	const tile = { size: RADAR_SIZE_PX, zoom: geometry.zoom, lat: location.lat, lon: location.lon, smooth: 1, snow: 1 } as const;
	const urls = frames.map((f) => deps.radar.frameUrl(index, f, tile));

	const [coverage, ...images] = await Promise.all([
		settle(deps.radar.coverage(index, location.lat, location.lon, geometry.zoom)),
		...urls.map((u) => (input.include_images ? settle(deps.radar.image(u)) : Promise.resolve(undefined))),
	]);

	const warnings: string[] = [];
	let coverageOut: Record<string, unknown>;
	if (coverage.ok) {
		if (coverage.value.covered_fraction === 0) {
			throw new ToolError("outside_radar_coverage", `No radar coverage around ${location.name}; RainViewer has no radar data for this area`, {
				provider: "rainviewer",
			});
		}
		coverageOut = { checked: true, ...coverage.value };
		if (!coverage.value.center_covered) {
			warnings.push("The requested point itself is outside radar coverage; an empty image there means no data, not no rain.");
		}
	} else {
		coverageOut = { checked: false, ...errorPayload(coverage.error) };
		warnings.push("Radar coverage could not be checked; empty areas may be missing data rather than dry weather.");
	}

	const out: ImageOut[] = [];
	const frameMeta = frames.map((f, i) => {
		const img = images[i];
		const meta: Record<string, unknown> = {
			time: f.time,
			time_iso: toIso(f.time),
			source: "rainviewer",
			kind: "observation",
			url: urls[i],
			zoom: geometry.zoom,
			size_px: geometry.size_px,
			km_per_px: geometry.km_per_px,
		};
		if (img?.ok) {
			meta.image_index = out.length;
			out.push({
				label: `Radar frame ${i + 1}/${frames.length}, observed ${toIso(f.time)} (RainViewer)`,
				data: toBase64(img.value),
				mimeType: "image/png",
			});
		} else if (img && !img.ok) {
			meta.image_index = null;
			meta.image_error = errorPayload(img.error).error;
		}
		return meta;
	});
	if (input.include_images && out.length === 0) {
		throw new ToolError("radar_unavailable", "None of the radar frame images could be downloaded", {
			provider: "rainviewer",
			retryable: true,
		});
	}
	if (input.include_images && out.length < frames.length) warnings.push("Some frame images failed to download; see image_error.");

	const latest = frames[frames.length - 1]!;
	return {
		structured: {
			location,
			requested: { radius_km: input.radius_km, frames: input.frames },
			observed_at: toIso(latest.time),
			retrieved_at: deps.now().toISOString(),
			coverage: coverageOut,
			radar: {
				source: "rainviewer",
				kind: "observation",
				...geometry,
				center_px: [RADAR_SIZE_PX / 2, RADAR_SIZE_PX / 2],
				north_up: true,
				projection: "web_mercator",
				color_scheme: "RainViewer Universal Blue (light blue = light rain, dark blue = heavy, white/green = very heavy); snow in a separate palette",
				frames: frameMeta,
				nowcast: {
					available: false,
					reason:
						index.nowcastCount > 0
							? "RainViewer nowcast frames are not included; they are extrapolations, not observations"
							: "RainViewer no longer publishes nowcast frames",
				},
			},
			notes: [
				"Frames are observed radar reflectivity (past data), oldest first, about 10 minutes apart. They are not a forecast.",
				"Each image is a radar-only overlay without a basemap: the requested point is the centre pixel, north is up.",
				`One pixel is about ${geometry.km_per_px} km; the image spans about ${geometry.span_km} km across.`,
				"Compare consecutive frames to judge the direction and speed of precipitation movement.",
			],
			warnings,
		},
		images: out,
	};
}
