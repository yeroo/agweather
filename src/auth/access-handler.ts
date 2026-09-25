/**
 * Ported from Cloudflare's "remote-mcp-cf-access" demo
 * (https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access, src/access-handler.ts),
 * Copyright (c) 2025 Cloudflare, Inc., MIT License (see LICENSE-THIRD-PARTY.md).
 *
 * Changes:
 * - the id_token is verified with ./id-token (alg, kid, aud, iss, exp) instead of signature + exp only;
 * - the identity must be in OWNER_EMAIL, otherwise 403 and no grant/token is issued;
 * - props carry only { email, sub, name }; the upstream Access access_token is not stored;
 * - no Buffer / nodejs_compat dependency; errors never echo internal details.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, EnvWithOAuth } from "../env";
import { expectedIssuer, IdTokenError, verifyIdToken } from "./id-token";
import { isOwner } from "./owner";
import {
	addApprovedClient,
	createOAuthState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	type Props,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

export async function handleAccessRequest(request: Request, env: EnvWithOAuth, _ctx: ExecutionContext): Promise<Response> {
	const { pathname, searchParams } = new URL(request.url);

	if (request.method === "GET" && pathname === "/authorize") {
		const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		const { clientId } = oauthReqInfo;
		if (!clientId) {
			return new Response("Invalid request", { status: 400 });
		}

		// Already approved: no approval form, so no CSRF cookie to clear
		if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
			const { stateToken, codeChallenge } = await createOAuthState(oauthReqInfo, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
			return redirectToAccess(request, env, stateToken, codeChallenge);
		}

		const { token: csrfToken, setCookie } = generateCSRFProtection();
		return renderApprovalDialog(request, {
			client: await env.OAUTH_PROVIDER.lookupClient(clientId),
			csrfToken,
			server: {
				description: "Private weather radar MCP server. Sign-in is handled by Cloudflare Access; only the owner can use it.",
				name: "agweather",
			},
			setCookie,
			state: { oauthReqInfo },
		});
	}

	if (request.method === "POST" && pathname === "/authorize") {
		try {
			const formData = await request.formData();
			const csrfResult = validateCSRFToken(formData, request);

			const encodedState = formData.get("state");
			if (!encodedState || typeof encodedState !== "string") {
				return new Response("Missing state in form data", { status: 400 });
			}

			let state: { oauthReqInfo?: AuthRequest };
			try {
				state = JSON.parse(atob(encodedState));
			} catch (_e) {
				return new Response("Invalid state data", { status: 400 });
			}
			if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
				return new Response("Invalid request", { status: 400 });
			}

			const approvedClientCookie = await addApprovedClient(request, state.oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY);
			const { stateToken, codeChallenge } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);

			// Headers (not a plain object) so both Set-Cookie values survive
			const redirectHeaders = new Headers();
			redirectHeaders.append("Set-Cookie", approvedClientCookie);
			redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);
			return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
		} catch (error) {
			if (error instanceof OAuthError) return error.toResponse();
			console.error(JSON.stringify({ type: "auth_error", stage: "authorize", error: String(error) }));
			return new Response("Internal server error", { status: 500 });
		}
	}

	if (request.method === "GET" && pathname === "/callback") {
		let oauthReqInfo: AuthRequest;
		let codeVerifier: string;
		try {
			const result = await validateOAuthState(request, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
			oauthReqInfo = result.oauthReqInfo;
			codeVerifier = result.codeVerifier;
		} catch (error) {
			if (error instanceof OAuthError) return error.toResponse();
			return new Response("Internal server error", { status: 500 });
		}
		if (!oauthReqInfo.clientId) {
			return new Response("Invalid OAuth request data", { status: 400 });
		}

		// Exchange the code for tokens, with the PKCE verifier
		const [, idToken, errResponse] = await fetchUpstreamAuthToken({
			client_id: env.ACCESS_CLIENT_ID,
			client_secret: env.ACCESS_CLIENT_SECRET,
			code: searchParams.get("code") ?? undefined,
			redirect_uri: new URL("/callback", request.url).href,
			upstream_url: env.ACCESS_TOKEN_URL,
			code_verifier: codeVerifier,
		});
		if (errResponse) return errResponse;

		let claims;
		try {
			claims = await verifyIdToken(idToken, {
				jwksUrl: env.ACCESS_JWKS_URL,
				clientId: env.ACCESS_CLIENT_ID,
				issuer: expectedIssuer(env),
			});
		} catch (error) {
			const reason = error instanceof IdTokenError ? error.message : "verification failed";
			console.log(JSON.stringify({ type: "auth", stage: "callback", ok: false, reason }));
			return new Response(`Sign-in rejected: ${reason}`, { status: 401 });
		}

		if (claims.email_verified === false || !isOwner(claims.email, env.OWNER_EMAIL)) {
			console.log(JSON.stringify({ type: "auth", stage: "callback", ok: false, reason: "not_owner" }));
			return new Response("Forbidden: this MCP server is private to its owner.", { status: 403 });
		}

		const props: Props = { email: claims.email!.toLowerCase(), sub: claims.sub, ...(claims.name ? { name: claims.name } : {}) };
		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			metadata: { label: claims.name ?? props.email },
			props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: claims.sub,
		});
		console.log(JSON.stringify({ type: "auth", stage: "callback", ok: true }));
		return Response.redirect(redirectTo, 302);
	}

	return new Response("Not Found", { status: 404 });
}

function redirectToAccess(
	request: Request,
	env: Env,
	stateToken: string,
	codeChallenge: string,
	extraHeaders: Headers = new Headers(),
): Response {
	const headers = new Headers(extraHeaders);
	headers.set(
		"location",
		getUpstreamAuthorizeUrl({
			client_id: env.ACCESS_CLIENT_ID,
			code_challenge: codeChallenge,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "openid email profile",
			state: stateToken,
			upstream_url: env.ACCESS_AUTHORIZATION_URL,
		}),
	);
	return new Response(null, { headers, status: 302 });
}
