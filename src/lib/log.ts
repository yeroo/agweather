/**
 * One-line JSON logging. Everything goes through `redact`, which drops secret-looking
 * keys, strips credential query parameters from URLs and masks known secret values,
 * so a careless log call cannot leak the meteoblue key or an OAuth token.
 */

export type LogSink = (line: string) => void;

export interface Logger {
	event(fields: Record<string, unknown>): void;
}

const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|apikey|cookie)/i;
const SECRET_PARAM = /([?&](?:apikey|api_key|key|token|access_token|client_secret|code)=)[^&#\s"]*/gi;

export function redact(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
	if (depth > 6) return "[truncated]";
	if (typeof value === "string") {
		let s = value.replace(SECRET_PARAM, "$1[redacted]");
		for (const secret of secrets) {
			if (secret.length >= 4) s = s.split(secret).join("[redacted]");
		}
		return s;
	}
	if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, secrets, depth + 1);
		}
		return out;
	}
	return value;
}

export function createLogger(opts: { secrets?: readonly (string | undefined)[]; sink?: LogSink } = {}): Logger {
	const secrets = (opts.secrets ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
	const sink = opts.sink ?? ((line: string) => console.log(line));
	return {
		event(fields) {
			sink(JSON.stringify(redact({ ts: new Date().toISOString(), ...fields }, secrets)));
		},
	};
}
