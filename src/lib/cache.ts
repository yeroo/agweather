/**
 * Small in-isolate TTL cache with a size cap (oldest entry evicted first).
 *
 * Workers isolates are reused across requests, so this deduplicates upstream
 * downloads between tool calls that land on the same isolate. It is best-effort:
 * the edge cache (`fetch` with `cf.cacheTtl`) is the second layer.
 */
export class TtlCache<V> {
	private readonly entries = new Map<string, { value: V; expires: number }>();

	constructor(
		private readonly maxEntries: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): V | undefined {
		const hit = this.entries.get(key);
		if (!hit) return undefined;
		if (hit.expires <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return hit.value;
	}

	set(key: string, value: V, ttlSeconds: number): void {
		if (ttlSeconds <= 0) return;
		this.entries.delete(key);
		this.entries.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	get size(): number {
		return this.entries.size;
	}
}

export interface Caches {
	json: TtlCache<unknown>;
	bytes: TtlCache<Uint8Array>;
}

export function createCaches(now?: () => number): Caches {
	return {
		// weather-maps index, geocoder results, forecasts
		json: new TtlCache<unknown>(200, now),
		// radar frame / coverage PNGs (~10-60 KB each)
		bytes: new TtlCache<Uint8Array>(64, now),
	};
}
