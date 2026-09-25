import { z } from "zod";

export const locationFields = {
	location: z
		.string()
		.min(1)
		.max(120)
		.optional()
		.describe('Place name, e.g. "Minsk", "Barcelona", "Houston, Texas". Omit to use the configured default location.'),
	lat: z.number().min(-85).max(85).optional().describe("Latitude in degrees (use together with lon instead of location)."),
	lon: z.number().min(-180).max(180).optional().describe("Longitude in degrees (use together with lat instead of location)."),
};

const loose = z.looseObject;

export const locationOut = loose({ name: z.string(), lat: z.number(), lon: z.number(), resolved_by: z.string() });
