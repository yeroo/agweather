export type ErrorCode =
	| "invalid_input"
	| "unknown_location"
	| "geocoding_failed"
	| "radar_unavailable"
	| "outside_radar_coverage"
	| "provider_unavailable"
	| "provider_not_configured"
	| "upstream_timeout"
	| "rate_limited"
	| "internal_error";

export interface ErrorPayload {
	error: {
		code: ErrorCode;
		message: string;
		provider?: string;
		retryable: boolean;
	};
}

/** An error that is safe to show to the MCP client: the message never contains URLs or secrets. */
export class ToolError extends Error {
	readonly code: ErrorCode;
	readonly provider?: string;
	readonly retryable: boolean;

	constructor(code: ErrorCode, message: string, opts: { provider?: string; retryable?: boolean } = {}) {
		super(message);
		this.name = "ToolError";
		this.code = code;
		this.provider = opts.provider;
		this.retryable = opts.retryable ?? false;
	}
}

export function toToolError(err: unknown): ToolError {
	if (err instanceof ToolError) return err;
	return new ToolError("internal_error", "unexpected internal error", { retryable: true });
}

export function errorPayload(err: unknown): ErrorPayload {
	const e = toToolError(err);
	return {
		error: {
			code: e.code,
			message: e.message,
			...(e.provider ? { provider: e.provider } : {}),
			retryable: e.retryable,
		},
	};
}

/** `{ available: false, ... }` block used when one provider fails inside a tool that still succeeds. */
export function unavailable(err: unknown): { available: false } & ErrorPayload {
	return { available: false, ...errorPayload(err) };
}
