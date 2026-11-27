/**
 * Read-only test of other Amazon Kindle endpoints, from your own computer.
 *
 *   npm run explore
 *
 * Needs .spike-credentials.json (run `npm run spike` first). Each candidate
 * prints PASS or FAIL. The shape of each answer (field names and types, no
 * values) is saved under .explore/, which is git-ignored.
 *
 * Every request here only reads. The script never calls an endpoint that
 * changes the account, sends a document, or returns book text.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { websiteCookies } from "../src/amazon/device";
import {
	CLIENT_VERSION,
	CLOUD_READER_DEVICE_TYPE,
	CloudReader,
} from "../src/amazon/reader";
import { DirectTransport } from "../src/amazon/transport";
import type { DeviceCredentials } from "../src/amazon/types";

const CREDENTIALS = new URL("../.spike-credentials.json", import.meta.url);
const OUT = new URL("../.explore/", import.meta.url);
const READ = "https://read.amazon.com";
const WWW = "https://www.amazon.com";

interface Outcome {
	ok: boolean;
	detail: string;
	/** Saved to .explore/<name>.json. Must hold no personal values. */
	shape?: unknown;
}

/** Field names and types only: strings become their length, arrays their size and first item. */
function shapeOf(value: unknown, depth = 0): unknown {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return {
			array: value.length,
			of: value.length ? shapeOf(value[0], depth + 1) : "empty",
		};
	}
	if (typeof value === "object") {
		if (depth > 5) return "object";
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [
				k,
				shapeOf(v, depth + 1),
			]),
		);
	}
	if (typeof value === "string") return `string(${value.length})`;
	return typeof value;
}

const tryJson = (body: string): unknown => {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The request signature Kindle devices send to Amazon's device hosts. */
function signedHeaders(
	credentials: DeviceCredentials,
	method: string,
	url: URL,
	body = "",
): Record<string, string> {
	const date = new Date().toISOString();
	const data = [
		method,
		url.pathname + url.search,
		date,
		body,
		credentials.adpToken,
	].join("\n");
	const base64 = credentials.devicePrivateKey.replace(
		/-----[^-]+-----|\s/g,
		"",
	);
	const wrapped = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
	let lastError: unknown;
	for (const label of ["RSA PRIVATE KEY", "PRIVATE KEY"]) {
		try {
			const key = createPrivateKey(
				`-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`,
			);
			const signature = createSign("RSA-SHA256")
				.update(data)
				.sign(key, "base64");
			return {
				"x-adp-token": credentials.adpToken,
				"x-adp-alg": "SHA256withRSA:1.0",
				"x-adp-signature": `${signature}:${date}`,
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Could not read the device key: ${lastError}`);
}

async function main() {
	if (!existsSync(CREDENTIALS)) {
		throw new Error("No .spike-credentials.json. Run `npm run spike` first.");
	}
	const credentials: DeviceCredentials = JSON.parse(
		readFileSync(CREDENTIALS, "utf8"),
	);
	const reader = new CloudReader(
		new DirectTransport(),
		await websiteCookies(credentials),
		CLOUD_READER_DEVICE_TYPE,
	);
	const { books } = await reader.libraryPage();
	if (!books.length) throw new Error("The library came back empty");
	const asin = books[0].asin;
	let metadataUrl = "";

	const www = {
		Referer: `${WWW}/`,
		Accept: "application/json, text/html, */*",
	};

	const candidates: [string, string, () => Promise<Outcome>][] = [
		[
			"reading-insights",
			"Reading Insights (streaks, days read, titles read)",
			async () => {
				const r = await reader.raw({
					url: `${WWW}/kindle/reading/insights/data`,
					headers: { ...www, Referer: `${WWW}/kindle/reading/insights` },
				});
				const data = tryJson(r.body) as Record<string, unknown> | undefined;
				if (!data || !("goal_info" in data || "current_daily_streak" in data)) {
					return {
						ok: false,
						detail: `HTTP ${r.status}, ${r.body.length} bytes, final address ${new URL(r.url).pathname}, ${data ? `fields: ${Object.keys(data).join(", ")}` : "not JSON"}`,
						shape: data ? shapeOf(data) : undefined,
					};
				}
				const goal = data.goal_info as { titles_read?: unknown[] } | undefined;
				return {
					ok: true,
					detail: `streak fields ${"current_daily_streak" in data ? "present" : "missing"}, ${goal?.titles_read?.length ?? 0} titles read listed`,
					shape: shapeOf(data),
				};
			},
		],
		[
			"start-reading",
			"startReading extra fields (last page read, metadata address)",
			async () => {
				const r = await reader.raw(
					{
						url: `${READ}/service/mobile/reader/startReading?asin=${asin}&clientVersion=${CLIENT_VERSION}`,
					},
					true,
				);
				const data = tryJson(r.body) as Record<string, unknown> | undefined;
				if (!data) return { ok: false, detail: `HTTP ${r.status}, not JSON` };
				metadataUrl =
					typeof data.metadataUrl === "string" ? data.metadataUrl : "";
				const wanted = [
					"lastPageReadData",
					"metadataUrl",
					"srl",
					"clippingLimit",
					"karamelToken",
				];
				const present = wanted.filter((k) => k in data);
				return {
					ok:
						present.includes("lastPageReadData") ||
						present.includes("metadataUrl"),
					detail: `present: ${present.join(", ") || "none"}`,
					shape: shapeOf(data),
				};
			},
		],
		[
			"book-metadata",
			"Book metadata file (positions, table of contents)",
			async () => {
				if (!metadataUrl)
					return { ok: false, detail: "startReading gave no metadataUrl" };
				const r = await fetch(metadataUrl);
				const body = await r.text();
				const inner = body.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/)?.[1] ?? body;
				const data = tryJson(inner) as Record<string, unknown> | undefined;
				if (!data)
					return {
						ok: false,
						detail: `HTTP ${r.status}, ${body.length} bytes, not JSONP`,
					};
				const toc = Array.isArray(data.toc) ? data.toc.length : 0;
				return {
					ok: "startPosition" in data && "endPosition" in data,
					detail: `start and end positions ${"startPosition" in data ? "present" : "missing"}, table of contents entries: ${toc}`,
					shape: shapeOf(data),
				};
			},
		],
		[
			"notebook",
			"Notebook page (highlight colors, locations, page numbers)",
			async () => {
				const r = await reader.raw({
					url: `${READ}/notebook?asin=${asin}&contentLimitState=&`,
					headers: {
						"x-requested-with": "XMLHttpRequest",
						Referer: `${READ}/notebook`,
					},
				});
				const colors = new Map<string, number>();
				for (const m of r.body.matchAll(/kp-notebook-highlight-([a-z]+)/g)) {
					colors.set(m[1], (colors.get(m[1]) ?? 0) + 1);
				}
				const signIn =
					r.url.includes("signin") || r.body.includes("ap_password");
				return {
					ok: colors.size > 0,
					detail: signIn
						? `Amazon asked for a password sign-in (HTTP ${r.status})`
						: `HTTP ${r.status}, ${r.body.length} bytes, colors: ${[...colors].map(([c, n]) => `${c} ${n}`).join(", ") || "none"}, location field ${r.body.includes("kp-annotation-location") ? "present" : "missing"}`,
				};
			},
		],
		[
			"content-list",
			"Manage Your Content list (all books and personal documents)",
			async () => {
				const page = await reader.raw({
					url: `${WWW}/hz/mycd/digital-console/contentlist/booksAll/dateDsc/`,
					headers: www,
				});
				const csrf = page.body.match(
					/csrfToken\s*[=:]\s*["']([^"']+)["']/,
				)?.[1];
				if (!csrf) {
					return {
						ok: false,
						detail: `No CSRF token in the page (HTTP ${page.status}, final address ${new URL(page.url).pathname})`,
					};
				}
				const counts: string[] = [];
				let shape: unknown;
				for (const [contentType, reference] of [
					["Ebook", "booksAll"],
					["KindlePDoc", "pdocs"],
				]) {
					await pause(500);
					const input = {
						contentType,
						contentCategoryReference: reference,
						itemStatusList: ["Active"],
						fetchCriteria: {
							sortOrder: "DESCENDING",
							sortIndex: "DATE",
							startIndex: 0,
							batchSize: 5,
							totalContentCount: -1,
						},
						surfaceType: "LargeDesktop",
					};
					const r = await reader.raw({
						url: `${WWW}/hz/mycd/digital-console/ajax`,
						method: "POST",
						headers: {
							...www,
							"Content-Type": "application/x-www-form-urlencoded",
							Origin: WWW,
						},
						// The only activity sent. It lists content and changes nothing.
						body: new URLSearchParams({
							activity: "GetContentOwnershipData",
							activityInput: JSON.stringify(input),
							csrfToken: csrf,
						}).toString(),
					});
					const data = tryJson(r.body) as
						| {
								GetContentOwnershipData?: {
									items?: unknown[];
									numberOfItems?: number;
								};
						  }
						| undefined;
					const list = data?.GetContentOwnershipData;
					counts.push(
						list?.items
							? `${contentType}: ${list.numberOfItems ?? "?"} total, ${list.items.length} returned`
							: `${contentType}: HTTP ${r.status}, no item list`,
					);
					if (list?.items?.length && !shape) shape = shapeOf(data);
				}
				return { ok: shape !== undefined, detail: counts.join(". "), shape };
			},
		],
		[
			"sidecar",
			"Device sync file (last read position, signed device request)",
			async () => {
				const url = new URL(
					`https://cde-ta-g7g.amazon.com/FionaCDEServiceEngine/sidecar?type=EBOK&key=${asin}`,
				);
				const r = await fetch(url, {
					headers: signedHeaders(credentials, "GET", url),
				});
				const bytes = (await r.arrayBuffer()).byteLength;
				return {
					ok: r.status === 200 && bytes > 0,
					detail: `HTTP ${r.status}, ${bytes} bytes, type ${r.headers.get("content-type") ?? "none"}`,
				};
			},
		],
		[
			"sync-metadata",
			"Device library list (signed device request)",
			async () => {
				const url = new URL(
					"https://todo-ta-g7g.amazon.com/FionaTodoListProxy/syncMetaData?item_count=5",
				);
				const r = await fetch(url, {
					headers: signedHeaders(credentials, "GET", url),
				});
				const body = await r.text();
				const items = body.match(/<meta_data>/g)?.length ?? 0;
				return {
					ok: r.status === 200 && items > 0,
					detail: `HTTP ${r.status}, ${body.length} bytes, ${items} items, tags: ${[...new Set([...body.matchAll(/<([a-zA-Z_]+)[ >/]/g)].map((m) => m[1]))].join(", ") || "none"}`,
				};
			},
		],
	];

	mkdirSync(OUT, { recursive: true });
	let passed = 0;
	for (const [name, title, run] of candidates) {
		let outcome: Outcome;
		try {
			outcome = await run();
		} catch (error) {
			outcome = {
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		if (outcome.ok) passed++;
		console.log(
			`${outcome.ok ? "PASS" : "FAIL"}  ${title}\n      ${outcome.detail}`,
		);
		if (outcome.shape !== undefined) {
			writeFileSync(
				new URL(`${name}.json`, OUT),
				`${JSON.stringify(outcome.shape, null, 2)}\n`,
			);
		}
		await pause(750);
	}
	console.log(
		`\n${passed}/${candidates.length} endpoints answered. Shapes are in .explore/`,
	);
}

main().catch((error) => {
	console.error(`\nFAIL  ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
