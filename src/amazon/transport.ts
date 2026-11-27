/**
 * How requests reach read.amazon.com.
 *
 * Amazon fingerprints TLS on that host. `DirectTransport` uses the runtime's
 * own fetch; `ProxyTransport` hands the request to a small service that sends
 * it with a browser's TLS fingerprint (see container/proxy.py). The Cloud
 * Reader client is written against this interface so it runs unchanged on
 * either.
 */
export interface HttpRequest {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	/** URL after redirects. A sign-in URL here means the session was refused. */
	url: string;
	/** Cookies the response set, as name/value pairs. */
	setCookies: { name: string; value: string }[];
	body: string;
}

export interface Transport {
	readonly name: string;
	send(request: HttpRequest): Promise<HttpResponse>;
}

export function parseSetCookie(
	line: string,
): { name: string; value: string } | null {
	const first = line.split(";", 1)[0];
	const eq = first.indexOf("=");
	if (eq <= 0) return null;
	return {
		name: first.slice(0, eq).trim(),
		value: first
			.slice(eq + 1)
			.trim()
			.replace(/^"|"$/g, ""),
	};
}

export class DirectTransport implements Transport {
	readonly name = "direct";

	async send(request: HttpRequest): Promise<HttpResponse> {
		const response = await fetch(request.url, {
			method: request.method ?? "GET",
			headers: request.headers,
			body: request.body,
			redirect: "follow",
		});
		const lines =
			(
				response.headers as unknown as { getSetCookie?: () => string[] }
			).getSetCookie?.() ?? [];
		const setCookies = lines
			.map(parseSetCookie)
			.filter((c): c is { name: string; value: string } => c !== null);
		return {
			status: response.status,
			url: response.url || request.url,
			setCookies,
			body: await response.text(),
		};
	}
}

/** Anything that can answer a Request: global fetch, or a Container stub's fetch. */
export type Fetcher = (request: Request) => Promise<Response>;

export class ProxyTransport implements Transport {
	readonly name = "proxy";

	constructor(
		private readonly fetcher: Fetcher,
		private readonly baseUrl = "http://proxy",
	) {}

	async send(request: HttpRequest): Promise<HttpResponse> {
		const response = await this.fetcher(
			new Request(`${this.baseUrl}/fetch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: request.url,
					method: request.method ?? "GET",
					headers: request.headers ?? {},
					body: request.body ?? null,
				}),
			}),
		);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`Fetch proxy failed (${response.status}): ${text.slice(0, 200)}`,
			);
		}
		const answer = JSON.parse(text) as {
			status: number;
			url: string;
			set_cookies: { name: string; value: string }[];
			body: string;
		};
		return {
			status: answer.status,
			url: answer.url,
			setCookies: answer.set_cookies ?? [],
			body: answer.body,
		};
	}
}
