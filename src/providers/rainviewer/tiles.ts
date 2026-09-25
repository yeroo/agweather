import { clampZoom } from "../../location/geo-math";

/** RainViewer "Universal Blue"; the only colour scheme RainViewer still documents. */
export const DISPLAY_COLOR_SCHEME = 2;

export interface TileParams {
	size: 256 | 512;
	zoom: number;
	lat: number;
	lon: number;
	/** 1 = smoothed (nicer to look at), 0 = raw colours (needed to invert colour to dBZ). */
	smooth: 0 | 1;
	/** 1 = snow shown in a separate palette. */
	snow: 0 | 1;
}

const coord = (n: number) => n.toFixed(4);

/**
 * A single PNG centred on lat/lon: `{host}{path}/{size}/{z}/{lat}/{lon}/{color}/{smooth}_{snow}.png`.
 * The zoom is always clamped to <= 7; RainViewer answers higher zooms with a placeholder image.
 */
export function frameTileUrl(host: string, path: string, p: TileParams): string {
	return `${host}${path}/${p.size}/${clampZoom(p.zoom)}/${coord(p.lat)}/${coord(p.lon)}/${DISPLAY_COLOR_SCHEME}/${p.smooth}_${p.snow}.png`;
}

/** Radar coverage mask centred on lat/lon (transparent = covered). */
export function coverageTileUrl(host: string, p: { size: 256 | 512; zoom: number; lat: number; lon: number }): string {
	return `${host}/v2/coverage/0/${p.size}/${clampZoom(p.zoom)}/${coord(p.lat)}/${coord(p.lon)}/0/0_0.png`;
}
