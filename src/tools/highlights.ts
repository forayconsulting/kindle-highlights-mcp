import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_MATCHES, semanticSearch } from "../embed";
import { EXPORT_FORMATS, exportHighlights } from "../export";
import { formatDate } from "../render";
import {
	type BookRow,
	type HighlightRow,
	type HighlightWithBook,
	Store,
} from "../store";

const text = (value: string) => ({
	content: [{ type: "text" as const, text: value }],
});

const failure = (what: string, e: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: `Error ${what}: ${e instanceof Error ? e.message : e}`,
		},
	],
	isError: true,
});

export function formatBookList(books: BookRow[], timeZone: string): string {
	if (!books.length) {
		return "No books with highlights yet. Run sync_now, or check sync_status.";
	}
	const lines = books.map((b) => {
		const by = b.authors ? ` by ${b.authors}` : "";
		const synced = formatDate(b.last_synced_at, timeZone);
		return `- ${b.title}${by} — ${b.highlight_count} highlight${b.highlight_count === 1 ? "" : "s"} [asin: ${b.asin}${synced ? `, synced ${synced}` : ""}]`;
	});
	return [
		`${books.length} book${books.length === 1 ? "" : "s"} with highlights:`,
		...lines,
	].join("\n");
}

export function formatHighlight(h: HighlightRow, timeZone: string): string {
	const meta = [
		h.location !== null ? `loc ${h.location}` : "",
		formatDate(h.modified_at, timeZone),
		h.color ?? "",
		h.truncated ? "preview only" : "",
	].filter(Boolean);
	const parts: string[] = [];
	if (h.text) parts.push(`"${h.text}${h.truncated ? "…" : ""}"`);
	if (h.note) parts.push(`Note: ${h.note}`);
	if (meta.length) parts.push(`(${meta.join(", ")})`);
	return parts.join("\n");
}

export function formatBookHighlights(
	book: BookRow,
	highlights: HighlightRow[],
	timeZone: string,
): string {
	const by = book.authors ? ` by ${book.authors}` : "";
	if (!highlights.length) return `No highlights stored for ${book.title}${by}`;
	return [
		`${book.title}${by} — ${highlights.length} highlights`,
		"",
		highlights.map((h) => formatHighlight(h, timeZone)).join("\n\n"),
	].join("\n");
}

export function formatAcrossBooks(
	heading: string,
	rows: HighlightWithBook[],
	timeZone: string,
): string {
	if (!rows.length) return `${heading}: none`;
	return [
		`${heading}: ${rows.length}`,
		"",
		rows
			.map(
				(h) =>
					`${formatHighlight(h, timeZone)}\n— ${h.title}${h.authors ? `, ${h.authors}` : ""}`,
			)
			.join("\n\n"),
	].join("\n");
}

/**
 * Today's date in `timeZone` as "YYYY" and "MM-DD", plus that zone's offset
 * from UTC in minutes.
 */
export function localDay(
	now: number,
	timeZone: string,
): { year: string; monthDay: string; offsetMinutes: number } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(now))
			.map((p) => [p.type, p.value]),
	);
	const wall = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
	);
	return {
		year: parts.year,
		monthDay: `${parts.month}-${parts.day}`,
		offsetMinutes: Math.round((wall - now) / 60_000),
	};
}

/** Pick one book from a title fragment or ASIN, or say why not. */
export async function resolveBook(
	store: Store,
	query: string,
	timeZone: string,
): Promise<{ book: BookRow } | { message: string }> {
	const matches = await store.findBooks(query);
	if (!matches.length) return { message: `No book matching "${query}"` };
	const exact = matches.find(
		(m) => m.asin === query || m.title.toLowerCase() === query.toLowerCase(),
	);
	if (!exact && matches.length > 1) {
		return {
			message: `"${query}" matches several books. Ask again with an ASIN:\n${formatBookList(matches, timeZone)}`,
		};
	}
	return { book: exact ?? matches[0] };
}

export function registerHighlightTools(server: McpServer, env: Env) {
	const limitParam = z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Maximum results, default 25");

	server.tool(
		"list_books",
		"List Kindle books that have highlights or notes",
		{},
		async () => {
			try {
				const books = await new Store(env.DB).booksWithHighlights();
				return text(formatBookList(books, env.TIMEZONE));
			} catch (e) {
				return failure("listing books", e);
			}
		},
	);

	server.tool(
		"get_highlights",
		"Get every highlight and note for one Kindle book",
		{
			book: z
				.string()
				.describe("Part of the book's title, or its ASIN from list_books"),
		},
		async ({ book }) => {
			try {
				const store = new Store(env.DB);
				const found = await resolveBook(store, book, env.TIMEZONE);
				if ("message" in found) return text(found.message);
				const chosen = found.book;
				return text(
					formatBookHighlights(
						chosen,
						await store.highlights(chosen.asin),
						env.TIMEZONE,
					),
				);
			} catch (e) {
				return failure("getting highlights", e);
			}
		},
	);

	server.tool(
		"search_highlights",
		"Search the text of Kindle highlights and notes across all books",
		{
			query: z.string().min(2).describe("Word or phrase to look for"),
			limit: limitParam,
		},
		async ({ query, limit }) => {
			try {
				const rows = await new Store(env.DB).search(query, limit ?? 25);
				return text(
					formatAcrossBooks(
						`Highlights matching "${query}"`,
						rows,
						env.TIMEZONE,
					),
				);
			} catch (e) {
				return failure("searching highlights", e);
			}
		},
	);

	server.tool(
		"recent_highlights",
		"Get Kindle highlights made in the last N days, newest first",
		{
			days: z
				.number()
				.int()
				.min(1)
				.max(3650)
				.optional()
				.describe("How many days back, default 7"),
			limit: limitParam,
		},
		async ({ days, limit }) => {
			try {
				const window = days ?? 7;
				const rows = await new Store(env.DB).recent(
					Date.now() - window * 86_400_000,
					limit ?? 25,
				);
				return text(
					formatAcrossBooks(
						`Highlights from the last ${window} day${window === 1 ? "" : "s"}`,
						rows,
						env.TIMEZONE,
					),
				);
			} catch (e) {
				return failure("getting recent highlights", e);
			}
		},
	);

	server.tool(
		"semantic_search",
		"Find Kindle highlights and notes by meaning, not exact words. Use for a topic, idea, or question",
		{
			query: z
				.string()
				.min(2)
				.describe("A topic, idea, or question in plain words"),
			book: z
				.string()
				.optional()
				.describe("Limit to one book: part of its title, or its ASIN"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_MATCHES)
				.optional()
				.describe("Maximum results, default 10"),
		},
		async ({ query, book, limit }) => {
			try {
				let asin: string | undefined;
				let within = "";
				if (book) {
					const found = await resolveBook(
						new Store(env.DB),
						book,
						env.TIMEZONE,
					);
					if ("message" in found) return text(found.message);
					const chosen = found.book;
					asin = chosen.asin;
					within = ` in ${chosen.title}`;
				}
				const rows = await semanticSearch(env, query, limit ?? 10, asin);
				return text(
					formatAcrossBooks(
						`Highlights closest in meaning to "${query}"${within}`,
						rows,
						env.TIMEZONE,
					),
				);
			} catch (e) {
				return failure("searching by meaning", e);
			}
		},
	);

	server.tool(
		"resurface_highlights",
		"Bring back older Kindle highlights: a random handful, or ones made on this day in earlier years",
		{
			mode: z
				.enum(["random", "on_this_day"])
				.optional()
				.describe("Default random"),
			count: z
				.number()
				.int()
				.min(1)
				.max(25)
				.optional()
				.describe("How many, default 5"),
		},
		async ({ mode, count }) => {
			try {
				const store = new Store(env.DB);
				const n = count ?? 5;
				if (mode === "on_this_day") {
					const today = localDay(Date.now(), env.TIMEZONE);
					const rows = await store.onThisDay(
						today.monthDay,
						today.year,
						today.offsetMinutes,
						n,
					);
					return text(
						formatAcrossBooks(
							"Highlights made on this day in earlier years",
							rows,
							env.TIMEZONE,
						),
					);
				}
				return text(
					formatAcrossBooks(
						"Highlights picked at random",
						await store.randomHighlights(n),
						env.TIMEZONE,
					),
				);
			} catch (e) {
				return failure("resurfacing highlights", e);
			}
		},
	);

	server.tool(
		"export_book",
		"Export one book's Kindle highlights as CSV, an Anki import file, or an Obsidian note",
		{
			book: z
				.string()
				.describe("Part of the book's title, or its ASIN from list_books"),
			format: z.enum(EXPORT_FORMATS).describe("csv, anki, or obsidian"),
		},
		async ({ book, format }) => {
			try {
				const store = new Store(env.DB);
				const found = await resolveBook(store, book, env.TIMEZONE);
				if ("message" in found) return text(found.message);
				return text(
					exportHighlights(
						format,
						await store.highlightsWithBook(found.book.asin),
						env.TIMEZONE,
						found.book,
					),
				);
			} catch (e) {
				return failure("exporting highlights", e);
			}
		},
	);
}
