/** Web-Mercator tile geometry for RainViewer's coordinate-centred tiles. */

export const EQUATOR_KM = 40075.016686;

/** RainViewer serves no real radar data above this zoom (z=8 returns a "not supported" placeholder). */
export const MAX_RADAR_ZOOM = 7;
export const MIN_RADAR_ZOOM = 0;

/**
 * Ground width of one tile at this zoom and latitude. A 512 px RainViewer tile covers the
 * same area as the 256 px tile at the same zoom, only at twice the resolution.
 */
export function tileSpanKm(lat: number, zoom: number): number {
	return (EQUATOR_KM * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

export function kmPerPx(lat: number, zoom: number, sizePx: number): number {
	return tileSpanKm(lat, zoom) / sizePx;
}

export function clampZoom(zoom: number): number {
	return Math.min(MAX_RADAR_ZOOM, Math.max(MIN_RADAR_ZOOM, Math.floor(zoom)));
}

/** Largest zoom (<= 7) at which one tile still spans at least 2 x radius. */
export function zoomForRadius(lat: number, radiusKm: number): number {
	for (let z = MAX_RADAR_ZOOM; z > MIN_RADAR_ZOOM; z--) {
		if (tileSpanKm(lat, z) >= 2 * radiusKm) return z;
	}
	return MIN_RADAR_ZOOM;
}

export interface RadarGeometry {
	zoom: number;
	size_px: number;
	span_km: number;
	km_per_px: number;
	requested_radius_km: number;
	/** Half the tile span actually delivered (>= requested unless the radius exceeds the z=0 tile). */
	effective_radius_km: number;
}

export function radarGeometry(lat: number, radiusKm: number, sizePx: number): RadarGeometry {
	const zoom = zoomForRadius(lat, radiusKm);
	const span = tileSpanKm(lat, zoom);
	return {
		zoom,
		size_px: sizePx,
		span_km: round(span, 1),
		km_per_px: round(span / sizePx, 3),
		requested_radius_km: radiusKm,
		effective_radius_km: round(span / 2, 1),
	};
}

export function round(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
