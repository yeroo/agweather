import type { ForecastProvider, PrecipSeries } from "../types/forecast";
import type { Geocoder } from "../types/location";
import type { RadarProvider } from "../types/radar";

export interface ToolDeps {
	radar: RadarProvider;
	geocoder: Geocoder;
	openMeteo: ForecastProvider;
	/** null when METEOBLUE_API_KEY is not set. */
	meteoblue: (ForecastProvider & { kind: PrecipSeries["kind"] }) | null;
	meteobluePackage: string;
	defaultLocation: string;
	now: () => Date;
}

export interface ImageOut {
	/** Short caption placed before the image so the model can tie it to a timestamp. */
	label: string;
	data: string;
	mimeType: "image/png";
}

export interface ToolOutput {
	structured: Record<string, unknown>;
	images?: ImageOut[];
}

export const METEOBLUE_NOT_CONFIGURED = {
	available: false,
	error: {
		code: "provider_not_configured",
		message: "meteoblue is not configured (set the METEOBLUE_API_KEY secret to enable it)",
		provider: "meteoblue",
		retryable: false,
	},
} as const;

/** Run a provider call; resolve to { ok, value } or { ok: false, error } so one failure never sinks a tool. */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, value: await p };
	} catch (error) {
		return { ok: false, error };
	}
}
