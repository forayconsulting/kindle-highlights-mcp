/**
 * End-to-end check of the Amazon route, one step at a time. Used by the
 * local spike script and by the Worker's debug route. Nothing secret is put
 * in the output: cookie names, counts and error text only.
 */
import { websiteCookies } from "./amazon/device";
import { CloudReader } from "./amazon/reader";
import type { Transport } from "./amazon/transport";
import type { Cookie, DeviceCredentials } from "./amazon/types";

export interface ProbeStep {
	step: string;
	ok: boolean;
	detail: string;
}

const describe = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export async function probe(
	credentials: DeviceCredentials,
	transport: Transport,
	deviceTokens: string[],
	booksToTry = 10,
): Promise<ProbeStep[]> {
	const steps: ProbeStep[] = [];
	const add = (step: string, ok: boolean, detail: string) =>
		steps.push({ step: `[${transport.name}] ${step}`, ok, detail });

	let cookies: Cookie[];
	try {
		cookies = await websiteCookies(credentials);
		add(
			"mint cookies from refresh token",
			true,
			cookies.map((c) => c.name).join(", "),
		);
	} catch (error) {
		add("mint cookies from refresh token", false, describe(error));
		return steps;
	}

	let reader = new CloudReader(transport, cookies, deviceTokens[0] ?? "");
	let books: Awaited<ReturnType<CloudReader["libraryPage"]>>["books"];
	try {
		books = (await reader.libraryPage()).books;
		add(
			"library (read.amazon.com)",
			true,
			`${books.length} books on first page`,
		);
	} catch (error) {
		add("library (read.amazon.com)", false, describe(error));
		return steps;
	}

	let working: string | null = null;
	for (const [i, token] of deviceTokens.entries()) {
		const candidate = new CloudReader(transport, cookies, token);
		const label = `getDeviceToken, candidate ${i + 1} (${token.length} chars)`;
		try {
			await candidate.registerDevice();
			add(label, true, "session token issued");
			if (working === null) {
				working = token;
				reader = candidate;
			}
		} catch (error) {
			add(label, false, describe(error));
		}
	}
	if (working === null) return steps;

	for (const book of books.slice(0, booksToTry)) {
		try {
			const { items, guid, revision } = await reader.annotations(book.asin);
			if (items.length === 0) continue;
			const truncated = items.filter((i) => i.truncated);
			add(
				"getAnnotations",
				true,
				`"${book.title}": ${items.length} annotations, ${truncated.length} previews`,
			);
			const target = truncated.find((t) => t.start !== null && t.end !== null);
			if (!target) {
				add("copyText", true, "skipped: no truncated highlight in this book");
				return steps;
			}
			try {
				const full = await reader.copyText(
					book.asin,
					guid,
					revision,
					target.start as number,
					target.end as number,
				);
				add(
					"copyText",
					full.length > target.text.length,
					`preview ${target.text.length} chars -> full ${full.length} chars`,
				);
			} catch (error) {
				add("copyText", false, describe(error));
			}
			return steps;
		} catch (error) {
			add("getAnnotations", false, `"${book.title}": ${describe(error)}`);
			return steps;
		}
	}
	add(
		"getAnnotations",
		true,
		`no annotations in the first ${booksToTry} books; nothing to check`,
	);
	return steps;
}
