/**
 * Provenance labels. Observations, radar nowcasts and numerical forecasts are never merged;
 * each block carries exactly one of these.
 */
export type DataKind = "observation" | "radar_nowcast" | "numerical_forecast" | "model_analysis";

export interface PrecipStep {
	/** The step covers [start, end): amounts are the total over that interval. */
	start: string;
	end: string;
	precipitation_mm: number;
	probability_pct?: number;
}

export interface PrecipSeries {
	source: string;
	kind: "radar_nowcast" | "numerical_forecast";
	model: string;
	/** Model run time; null when the upstream does not publish it (see issued_at_reason). */
	issued_at: string | null;
	issued_at_reason?: string;
	retrieved_at: string;
	step_minutes: number;
	/** "possibly_interpolated": finer steps than the underlying model may provide at this location. */
	temporal_resolution: "native" | "possibly_interpolated";
	steps: PrecipStep[];
	caveat?: string;
}

export interface CurrentConditions {
	source: string;
	kind: "model_analysis" | "numerical_forecast" | "radar_nowcast";
	model: string;
	description: string;
	valid_from: string;
	valid_to: string;
	issued_at: string | null;
	issued_at_reason?: string;
	retrieved_at: string;
	precipitation_mm?: number;
	rain_mm?: number;
	showers_mm?: number;
	snowfall_cm?: number;
	precipitation_probability_pct?: number;
	weather_code?: number;
	cloud_cover_pct?: number;
	temperature_c?: number;
	wind_speed_kmh?: number;
	wind_direction_deg?: number;
	wind_gusts_kmh?: number;
}

export interface ForecastResult {
	current?: CurrentConditions;
	/** Hourly (or native-step) precipitation: the series rain_eta may rely on. */
	primary: PrecipSeries;
	/** Extra finer-grained series, if any (e.g. Open-Meteo minutely_15). */
	extra: PrecipSeries[];
}

export interface ForecastProvider {
	readonly name: string;
	forecast(lat: number, lon: number): Promise<ForecastResult>;
}
