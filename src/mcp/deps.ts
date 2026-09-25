import type { Env } from "../env";
import { DEFAULT_LOCATION } from "../env";
import type { Caches } from "../lib/cache";
import { createHttp, type FetchFn } from "../lib/http";
import type { Logger } from "../lib/log";
import { DEFAULT_METEOBLUE_PACKAGE, MeteoblueForecast } from "../providers/meteoblue/client";
import { OpenMeteoForecast } from "../providers/openmeteo/forecast";
import { OpenMeteoGeocoder } from "../providers/openmeteo/geocoder";
import { RainViewerProvider } from "../providers/rainviewer/client";
import type { DepsFactory } from "./server";

export interface Runtime {
	fetch: FetchFn;
	caches: Caches;
	logger: Logger;
	now: () => Date;
	timeoutMs?: number;
}

export function depsFactory(env: Pick<Env, "DEFAULT_LOCATION" | "METEOBLUE_API_KEY" | "METEOBLUE_PACKAGE">, rt: Runtime): DepsFactory {
	return (onProvider) => {
		const http = createHttp({ fetch: rt.fetch, caches: rt.caches, logger: rt.logger, timeoutMs: rt.timeoutMs, onProvider });
		const pkg = env.METEOBLUE_PACKAGE?.trim() || DEFAULT_METEOBLUE_PACKAGE;
		const key = env.METEOBLUE_API_KEY?.trim();
		return {
			radar: new RainViewerProvider(http),
			geocoder: new OpenMeteoGeocoder(http),
			openMeteo: new OpenMeteoForecast(http, rt.now),
			meteoblue: key ? new MeteoblueForecast(http, key, pkg, rt.now) : null,
			meteobluePackage: pkg,
			defaultLocation: env.DEFAULT_LOCATION?.trim() || DEFAULT_LOCATION,
			now: rt.now,
		};
	};
}
