import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { errorPayload, toToolError } from "../lib/errors";
import type { Logger } from "../lib/log";
import type { ToolDeps, ToolOutput } from "../tools/deps";
import { precipitationNowcastInput, precipitationNowcastOutput, precipitationNowcastTool } from "../tools/precipitation-nowcast";
import { radarInput, radarOutput, radarTool } from "../tools/radar";
import { rainEtaInput, rainEtaOutput, rainEtaTool } from "../tools/rain-eta";
import { weatherNowInput, weatherNowOutput, weatherNowTool } from "../tools/weather-now";

export const SERVER_INFO = { name: "agweather", version: "0.1.0" };

/**
 * Builds the tool deps for one tool call. `onProvider` is called with each upstream
 * provider the call touches, for the per-call log line.
 */
export type DepsFactory = (onProvider: (provider: string) => void) => ToolDeps;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

export function buildServer(makeDeps: DepsFactory, logger: Logger): McpServer {
	const server = new McpServer(SERVER_INFO, {
		instructions:
			"Personal weather radar. Use `radar` to look at recent observed radar frames (images, oldest first) and judge where rain is moving; " +
			"`precipitation_nowcast` for short-term precipitation data kept separate by kind (observation / radar nowcast / model forecast); " +
			"`rain_eta` for structured data on when rain may stop or start; `weather_now` for current conditions incl. wind. " +
			"Without a location all tools use the owner's default location.",
	});

	const register = <I extends z.ZodType>(
		name: string,
		description: string,
		inputSchema: I,
		outputSchema: z.ZodType,
		run: (input: z.input<I>, deps: ToolDeps) => Promise<ToolOutput>,
	) => {
		server.registerTool(
			name,
			{ description, inputSchema, outputSchema, annotations: READ_ONLY },
			(async (args: z.input<I>) => {
				const providers = new Set<string>();
				const started = Date.now();
				try {
					const out = await run(args, makeDeps((p) => providers.add(p)));
					logger.event({ type: "tool", tool: name, providers: [...providers], duration_ms: Date.now() - started, ok: true });
					return toResult(out);
				} catch (err) {
					const e = toToolError(err);
					logger.event({
						type: "tool",
						tool: name,
						providers: [...providers],
						duration_ms: Date.now() - started,
						ok: false,
						error_code: e.code,
					});
					if (e.code === "internal_error") logger.event({ type: "internal_error", tool: name, error: String(err) });
					const payload = errorPayload(e);
					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
						structuredContent: payload as unknown as Record<string, unknown>,
						isError: true,
					} satisfies CallToolResult;
				}
			}) as never,
		);
	};

	register(
		"radar",
		"Latest observed radar frames (RainViewer) around a location, oldest first, as PNG images plus timestamps and geometry. Observations only, never a forecast.",
		radarInput,
		radarOutput,
		radarTool,
	);
	register(
		"weather_now",
		"Current conditions: radar observation at the point (is precipitation detected now), plus model estimates of precipitation and wind, each labelled with source and time.",
		weatherNowInput,
		weatherNowOutput,
		weatherNowTool,
	);
	register(
		"precipitation_nowcast",
		"Short-term precipitation for a location, as separate blocks: radar observation now, radar nowcast (if any provider has one), and numerical forecast series with source, issue time and step times.",
		precipitationNowcastInput,
		precipitationNowcastOutput,
		precipitationNowcastTool,
	);
	register(
		"rain_eta",
		"Structured data for 'when will the rain stop / start here?': observed state now plus the first dry / next wet forecast step. Returns insufficient_data rather than guessing.",
		rainEtaInput,
		rainEtaOutput,
		rainEtaTool,
	);

	return server;
}

function toResult(out: ToolOutput): CallToolResult {
	const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(out.structured) }];
	for (const img of out.images ?? []) {
		content.push({ type: "text", text: img.label });
		content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	}
	return { content, structuredContent: out.structured };
}
