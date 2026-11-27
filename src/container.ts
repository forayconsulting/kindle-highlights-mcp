/**
 * Optional fetch proxy. read.amazon.com fingerprints TLS; if it refuses the
 * Worker's own fetch, enable the `containers` block in wrangler.jsonc and
 * requests to that host go through container/proxy.py instead.
 */
import { Container, getContainer } from "@cloudflare/containers";
import {
	DirectTransport,
	ProxyTransport,
	type Transport,
} from "./amazon/transport";

export class FetchProxy extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "5m";
	enableInternet = true;
}

export function transportFor(env: Env, prefer?: "direct" | "proxy"): Transport {
	if (prefer === "direct" || !env.FETCH_PROXY) {
		if (prefer === "proxy") {
			throw new Error("The fetch-proxy Container is not enabled");
		}
		return new DirectTransport();
	}
	const container = getContainer(
		env.FETCH_PROXY as unknown as DurableObjectNamespace<FetchProxy>,
		"proxy",
	);
	return new ProxyTransport((request) => container.fetch(request));
}
