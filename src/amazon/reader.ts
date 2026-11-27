/**
 * Client for the private read.amazon.com endpoints the Kindle Cloud Reader
 * uses. Read-only: library, annotations, and the reader's copy call for the
 * full text of a highlight.
 *
 * Endpoint shapes are ported from minholi/omakindle (MIT). Unofficial and
 * liable to break when Amazon changes the reader.
 */
import { parseAnnotations } from "./annotations";
import type { HttpRequest, HttpResponse, Transport } from "./transport";
import {
	AmazonError,
	type Annotation,
	type Book,
	type Cookie,
	type StartReading,
} from "./types";

const CLIENT_VERSION = "20000100";
/**
 * Amazon's device type for the Kindle Cloud Reader. getDeviceToken accepts it
 * as both serialNumber and deviceType, and refuses the registered device's
 * serial ("Couldn't figure out deviceType"). Checked against a real account.
 */
export const CLOUD_READER_DEVICE_TYPE = "A2CTZ977SKFQZY";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** "King, Stephen:Straub, Peter" -> ["Stephen King", "Peter Straub"] */
export function normalizeAuthors(raw: string[]): string[] {
	const out: string[] = [];
	for (const group of raw) {
		for (const entry of group.split(":")) {
			const parts = entry
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean);
			if (parts.length === 0) continue;
			const name = parts.length >= 2 ? parts.reverse().join(" ") : parts[0];
			if (!out.includes(name)) out.push(name);
		}
	}
	return out;
}

/** Drop Amazon's `._SY400_.` size marker to get the full-size cover. */
export const largeCover = (url: string) => url.replace(/\._SY\d+_\./g, ".");

interface LibraryPage {
	itemsList?: {
		asin: string;
		title: string;
		authors?: string[];
		productUrl?: string;
		resourceType?: string;
		originType?: string;
	}[];
	paginationToken?: string | null;
}

export class CloudReader {
	private readonly base: string;
	private readonly cookies = new Map<string, string>();
	private adpSessionToken = "";

	constructor(
		private readonly transport: Transport,
		cookies: Cookie[],
		private readonly deviceToken: string,
		domain = "com",
	) {
		this.base = `https://read.amazon.${domain}`;
		for (const { name, value } of cookies) this.cookies.set(name, value);
	}

	private headers(adp: boolean): Record<string, string> {
		const headers: Record<string, string> = {
			Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
			"Accept-Language": "en-US,en;q=0.9",
			Referer: `${this.base}/kindle-library`,
			"User-Agent": USER_AGENT,
		};
		const sessionId = this.cookies.get("session-id");
		if (sessionId) headers["x-amzn-sessionid"] = sessionId;
		if (adp && this.adpSessionToken) {
			headers["x-adp-session-token"] = this.adpSessionToken;
		}
		return headers;
	}

	private async send(
		request: HttpRequest,
		adp: boolean,
	): Promise<HttpResponse> {
		const response = await this.transport.send({
			...request,
			headers: { ...this.headers(adp), ...request.headers },
		});
		for (const { name, value } of response.setCookies) {
			this.cookies.set(name, value);
		}
		if (response.url.includes("signin")) {
			throw new AmazonError(
				"auth-expired",
				"Amazon redirected to sign-in: the session was refused",
				response.status,
			);
		}
		if (response.status >= 400) {
			throw new AmazonError(
				response.status === 403 ? "blocked" : "http",
				`Amazon answered ${response.status} for ${new URL(request.url).pathname}: ${response.body.slice(0, 200)}`,
				response.status,
			);
		}
		return response;
	}

	private async json<T>(request: HttpRequest, adp: boolean): Promise<T> {
		const response = await this.send(request, adp);
		try {
			return JSON.parse(response.body) as T;
		} catch {
			throw new AmazonError(
				"parse",
				`Expected JSON from ${new URL(request.url).pathname}, got: ${response.body.slice(0, 120)}`,
			);
		}
	}

	/** One page of the library, most recent first. */
	async libraryPage(
		paginationToken?: string,
	): Promise<{ books: Book[]; next: string | null }> {
		let url = `${this.base}/kindle-library/search?query=&libraryType=BOOKS&sortType=recency&querySize=50`;
		if (paginationToken) {
			url += `&paginationToken=${encodeURIComponent(paginationToken)}`;
		}
		const page = await this.json<LibraryPage>({ url }, false);
		const books = (page.itemsList ?? []).map((item) => ({
			asin: item.asin,
			title: item.title,
			authors: normalizeAuthors(item.authors ?? []),
			coverUrl: largeCover(item.productUrl ?? ""),
			resourceType: item.resourceType ?? "",
			originType: item.originType ?? "",
		}));
		return {
			books,
			next:
				books.length > 0 && page.paginationToken ? page.paginationToken : null,
		};
	}

	/** Every book in the library, most recent first. */
	async library(maxPages = 40): Promise<Book[]> {
		const all: Book[] = [];
		let token: string | undefined;
		for (let i = 0; i < maxPages; i++) {
			const { books, next } = await this.libraryPage(token);
			all.push(...books);
			if (!next) break;
			token = next;
		}
		return all;
	}

	/** Open a reader session. Every `/service/mobile/reader` call needs its token. */
	async registerDevice(): Promise<void> {
		const token = encodeURIComponent(this.deviceToken);
		const info = await this.json<{ deviceSessionToken?: string }>(
			{
				url: `${this.base}/service/web/register/getDeviceToken?serialNumber=${token}&deviceType=${token}`,
			},
			false,
		);
		if (!info.deviceSessionToken) {
			throw new AmazonError(
				"parse",
				"getDeviceToken answered without a session token",
			);
		}
		this.adpSessionToken = info.deviceSessionToken;
	}

	private async ensureDevice(): Promise<void> {
		if (!this.adpSessionToken) await this.registerDevice();
	}

	async startReading(asin: string): Promise<StartReading> {
		await this.ensureDevice();
		const start = await this.json<{
			isOwned?: boolean;
			isSample?: boolean;
			formatVersion?: string;
			YJFormatVersion?: string;
			contentVersion?: string;
		}>(
			{
				url: `${this.base}/service/mobile/reader/startReading?asin=${encodeURIComponent(asin)}&clientVersion=${CLIENT_VERSION}`,
			},
			true,
		);
		return {
			guid:
				(start.YJFormatVersion?.trim() || start.formatVersion?.trim()) ?? "",
			revision: start.contentVersion?.trim() ?? "",
			isOwned: start.isOwned ?? false,
			isSample: start.isSample ?? false,
		};
	}

	private async fetchAnnotations(
		asin: string,
		guid: string,
	): Promise<Annotation[]> {
		const response = await this.send(
			{
				url: `${this.base}/service/mobile/reader/getAnnotations?asin=${encodeURIComponent(asin)}&guid=${encodeURIComponent(guid)}&clientVersion=${CLIENT_VERSION}`,
			},
			true,
		);
		try {
			return parseAnnotations(response.body);
		} catch {
			throw new AmazonError(
				"parse",
				`getAnnotations was not JSON: ${response.body.slice(0, 120)}`,
			);
		}
	}

	/** Highlights and notes for a book, plus what `copyText` needs to expand them. */
	async annotations(
		asin: string,
	): Promise<{ items: Annotation[]; guid: string; revision: string }> {
		const { guid, revision } = await this.startReading(asin);
		if (!guid) return { items: [], guid, revision };
		let items: Annotation[];
		try {
			items = await this.fetchAnnotations(asin, guid);
		} catch (error) {
			// Some titles answer 500 until the guid is sent twice.
			if (error instanceof AmazonError && error.status === 500) {
				items = await this.fetchAnnotations(asin, `${guid},${guid}`);
			} else {
				throw error;
			}
		}
		return { items, guid, revision };
	}

	/** Full text of a position range, through the reader's copy call. */
	async copyText(
		asin: string,
		guid: string,
		revision: string,
		start: number,
		end: number,
	): Promise<string> {
		await this.ensureDevice();
		const answer = await this.json<{ status?: string; text?: string }>(
			{
				url: `${this.base}/service/mobile/reader/copyText`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					asin,
					startPosition: start,
					endPosition: end,
					guid,
					revision,
					clientVersion: CLIENT_VERSION,
				}),
			},
			true,
		);
		const text = answer.text?.trim() ?? "";
		if (answer.status !== "Ok" || !text) {
			throw new AmazonError(
				"http",
				`copyText status: ${answer.status ?? "missing"}`,
			);
		}
		return text;
	}
}
