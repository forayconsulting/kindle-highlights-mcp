import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { getOAuthApi, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { authorizationCodeFrom, login, register } from "./amazon/device";
import { CLOUD_READER_DEVICE_TYPE } from "./amazon/reader";
import {
	loadCredentials,
	saveCredentials,
	saveLoginSession,
	setDeviceToken,
	takeLoginSession,
} from "./auth";
import { transportFor } from "./container";
import { INDEX_BATCH, indexPending } from "./embed";
import { exportFile, exportHighlights, isExportFormat } from "./export";
import { probe } from "./probe";
import { Store } from "./store";
import { runSync } from "./sync";
import { registerHighlightTools } from "./tools/highlights";
import { registerSyncTools } from "./tools/sync";

export { FetchProxy } from "./container";

export class KindleMCP extends McpAgent<Env, unknown, { email: string }> {
	server = new McpServer({
		name: "Kindle Highlights",
		version: "1.0.0",
	});

	async init() {
		registerHighlightTools(this.server, this.env);
		registerSyncTools(this.server, this.env, () => transportFor(this.env));
	}
}

const mcpHandler = KindleMCP.serve("/mcp");

const html = (body: string, status = 200) =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kindle Highlights MCP</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}textarea{width:100%;height:6rem;font:13px monospace}button,a.button{font:inherit;padding:.5rem 1rem}code{word-break:break-all}</style></head><body>${body}</body></html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
	);

/** Step 1 of the Amazon sign-in: show the link and a box for the landing URL. */
async function handleAuthStart(env: Env): Promise<Response> {
	const { loginUrl, session } = await login();
	await saveLoginSession(env, session);
	return html(`
<h1>Register this server with Amazon</h1>
<ol>
<li><a class="button" href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener">Open Amazon sign-in</a> and sign in.</li>
<li>Amazon then shows an error-looking page at <code>amazon.com/ap/maplanding</code>. Copy that page's full address from the address bar.</li>
<li>Paste it here within 30 minutes:</li>
</ol>
<form method="post" action="/auth/${escapeHtml(env.API_SECRET)}/finish">
<textarea name="landing" required placeholder="https://www.amazon.com/ap/maplanding?...openid.oa2.authorization_code=..."></textarea>
<p><button type="submit">Register device</button></p>
</form>`);
}

/** Step 2: trade the authorization code for device credentials. */
async function handleAuthFinish(request: Request, env: Env): Promise<Response> {
	const form = await request.formData();
	const code = authorizationCodeFrom(String(form.get("landing") ?? ""));
	if (!code) {
		return html(
			"<h1>No authorization code found</h1><p>The pasted address must contain <code>openid.oa2.authorization_code</code>. Go back and try again.</p>",
			400,
		);
	}
	const session = await takeLoginSession(env);
	if (!session) {
		return html(
			"<h1>Sign-in expired</h1><p>Start again from the /start page.</p>",
			400,
		);
	}
	try {
		const credentials = await register(code, session);
		await saveCredentials(env, credentials);
	} catch (error) {
		return html(
			`<h1>Registration failed</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
			502,
		);
	}
	return html(
		`<h1>Registered</h1><p>The device now appears under Devices in your Amazon account. Next: open <code>/debug/{API_SECRET}/probe</code> to check that highlights can be read.</p>`,
	);
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "Content-Type": "application/json" },
	});

async function handleDebug(
	action: string,
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	try {
		if (action === "probe") {
			const credentials = await loadCredentials(env);
			const prefer = url.searchParams.get("transport");
			const transport = transportFor(
				env,
				prefer === "direct" || prefer === "proxy" ? prefer : undefined,
			);
			const stored = await env.KINDLE_KV.get("amazon:device_token");
			const candidates = [
				...(stored ? [stored] : []),
				CLOUD_READER_DEVICE_TYPE,
			];
			return json(await probe(credentials, transport, candidates));
		}
		if (action === "sync" && request.method === "POST") {
			const max = Number(url.searchParams.get("max")) || 5;
			return json(
				await runSync(env, { maxBooks: max, transport: transportFor(env) }),
			);
		}
		if (action === "export" && request.method === "GET") {
			const format = url.searchParams.get("format") ?? "csv";
			if (!isExportFormat(format)) {
				return json({ error: "format must be csv, anki, or obsidian" }, 400);
			}
			const store = new Store(env.DB);
			const asin = url.searchParams.get("book");
			const book = asin ? await store.book(asin) : null;
			if (asin && !book) return json({ error: `No book ${asin}` }, 404);
			if (format === "obsidian" && !book) {
				return json({ error: "obsidian needs ?book=<asin>" }, 400);
			}
			const file = exportFile(format, book?.slug);
			return new Response(
				exportHighlights(
					format,
					await store.highlightsWithBook(book?.asin),
					env.TIMEZONE,
					book ?? undefined,
				),
				{
					headers: {
						"Content-Type": file.type,
						"Content-Disposition": `attachment; filename="${file.name}"`,
					},
				},
			);
		}
		if (action === "embed" && request.method === "POST") {
			const max = Number(url.searchParams.get("max")) || INDEX_BATCH;
			const result = await indexPending(env, Math.min(max, 500));
			return result
				? json(result)
				: json({ error: "AI and VECTORIZE bindings are not set" }, 400);
		}
		if (action === "device-token" && request.method === "POST") {
			const token = (await request.text()).trim();
			if (!token) return json({ error: "empty body" }, 400);
			await setDeviceToken(env, token);
			return json({ ok: true });
		}
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : String(error) },
			500,
		);
	}
	return new Response("Not Found", { status: 404 });
}

const providerOptions: OAuthProviderOptions<Env> = {
	apiRoute: "/mcp",
	apiHandler: mcpHandler,

	defaultHandler: {
		async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
			const url = new URL(request.url);

			// Without the secret, the /auth and /debug paths below would be guessable.
			if (!env.API_SECRET) {
				return new Response("API_SECRET is not set on this Worker", {
					status: 500,
				});
			}

			// Amazon device registration (for acquiring the refresh token)
			if (url.pathname === `/auth/${env.API_SECRET}/start`) {
				return handleAuthStart(env);
			}
			if (
				url.pathname === `/auth/${env.API_SECRET}/finish` &&
				request.method === "POST"
			) {
				return handleAuthFinish(request, env);
			}

			const debugPrefix = `/debug/${env.API_SECRET}/`;
			if (url.pathname.startsWith(debugPrefix)) {
				return handleDebug(
					url.pathname.slice(debugPrefix.length),
					request,
					env,
				);
			}

			// MCP connector OAuth authorize — verified by Cloudflare Access
			if (url.pathname === "/authorize") {
				const email = request.headers.get("CF-Access-Authenticated-User-Email");
				if (!email) {
					return new Response(
						"Unauthorized: Cloudflare Access authentication required",
						{ status: 401 },
					);
				}

				const oauthApi = getOAuthApi(providerOptions, env);
				const authRequest = await oauthApi.parseAuthRequest(request);
				const { redirectTo } = await oauthApi.completeAuthorization({
					request: authRequest,
					userId: email,
					metadata: { email },
					scope: authRequest.scope,
					props: { email },
				});

				return Response.redirect(redirectTo, 302);
			}

			return new Response("Not Found", { status: 404 });
		},
	},

	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
};

const provider = new OAuthProvider<Env>(providerOptions);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return provider.fetch(request, env, ctx);
	},

	/** Daily sync. */
	async scheduled(
		_event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(
			runSync(env, { transport: transportFor(env) }).then((result) => {
				console.log("sync", JSON.stringify(result));
			}),
		);
	},
};
