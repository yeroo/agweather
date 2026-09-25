import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAccessRequest } from "./auth/access-handler";
import { isOwner } from "./auth/owner";
import type { Env, EnvWithOAuth } from "./env";
import { type Caches, createCaches } from "./lib/cache";
import type { FetchFn } from "./lib/http";
import { createLogger, type LogSink } from "./lib/log";
import { depsFactory } from "./mcp/deps";
import { buildServer } from "./mcp/server";

export const MCP_ROUTE = "/mcp";

export interface WorkerOptions {
	/** Upstream fetch for weather providers (tests inject a mock). */
	fetch?: FetchFn;
	caches?: Caches;
	now?: () => Date;
	logSink?: LogSink;
	timeoutMs?: number;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Host names /mcp accepts (DNS-rebinding protection): only the PUBLIC_BASE_URL host. Tokens are issued
 * for the resource `${PUBLIC_BASE_URL}/mcp`, and OAuthProvider rejects them on any other origin before
 * this handler runs, so accepting further hosts here would be dead configuration.
 */
export function allowedHostnames(env: Pick<Env, "PUBLIC_BASE_URL">): string[] {
	return env.PUBLIC_BASE_URL ? [new URL(env.PUBLIC_BASE_URL).hostname] : [];
}

function loggerFor(env: Env, sink?: LogSink) {
	return createLogger({ secrets: [env.METEOBLUE_API_KEY, env.ACCESS_CLIENT_SECRET, env.COOKIE_ENCRYPTION_KEY], sink });
}

/** The handler OAuthProvider calls for /mcp once the bearer token is valid (ctx.props = the grant's props). */
export function createApiHandler(opts: WorkerOptions, caches: Caches) {
	return {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			// Defence in depth: OAuthProvider already validated the token; also require the grant to be the owner's,
			// so a misconfigured Access policy or an old grant for another identity cannot use the tools.
			const props = (ctx as ExecutionContext & { props?: { email?: unknown } }).props;
			if (!isOwner(props?.email, env.OWNER_EMAIL)) {
				return json(403, { error: "forbidden", error_description: "this MCP server is private to its owner" });
			}
			const logger = loggerFor(env, opts.logSink);
			const makeDeps = depsFactory(env, {
				fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
				caches,
				logger,
				now: opts.now ?? (() => new Date()),
				timeoutMs: opts.timeoutMs,
			});
			// Stateless: a fresh McpServer per request (SDK v2 factory), no Durable Object.
			const handler = createMcpHandler(() => buildServer(makeDeps, logger), {
				route: MCP_ROUTE,
				allowedHostnames: allowedHostnames(env),
			});
			return handler(request, env, ctx);
		},
	};
}

export function createWorker(opts: WorkerOptions = {}): ExportedHandler<Env> {
	// Shared by every request this isolate serves.
	const caches = opts.caches ?? createCaches();
	const apiHandler = createApiHandler(opts, caches);
	let provider: { key: string; value: OAuthProvider<Env> } | undefined;

	function getProvider(env: Env): OAuthProvider<Env> {
		const base = env.PUBLIC_BASE_URL!.replace(/\/+$/, "");
		const key = base;
		if (provider?.key === key) return provider.value;
		const value = new OAuthProvider<Env>({
			apiRoute: MCP_ROUTE,
			apiHandler,
			defaultHandler: {
				fetch: (request, env, ctx) => handleAccessRequest(request, env as EnvWithOAuth, ctx, loggerFor(env, opts.logSink)),
			},
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			resourceMetadata: {
				resource: `${base}${MCP_ROUTE}`,
				authorization_servers: [base],
			},
		});
		provider = { key, value };
		return value;
	}

	return {
		async fetch(request, env, ctx) {
			if (!env.PUBLIC_BASE_URL) {
				return json(500, { error: "misconfigured", error_description: "PUBLIC_BASE_URL is not set" });
			}
			let p: OAuthProvider<Env>;
			try {
				p = getProvider(env);
			} catch (err) {
				loggerFor(env, opts.logSink).event({ type: "config_error", error: String(err) });
				return json(500, { error: "misconfigured", error_description: "invalid OAuth configuration; check PUBLIC_BASE_URL" });
			}
			return p.fetch(request as never, env, ctx);
		},
	};
}

export default createWorker();
