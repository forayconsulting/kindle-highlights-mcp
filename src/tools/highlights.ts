import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
				const matches = await store.findBooks(book);
				if (!matches.length) return text(`No book matching "${book}"`);
				const exact = matches.find(
					(m) =>
						m.asin === book || m.title.toLowerCase() === book.toLowerCase(),
				);
				if (!exact && matches.length > 1) {
					return text(
						`"${book}" matches several books. Ask again with an ASIN:\n${formatBookList(matches, env.TIMEZONE)}`,
					);
				}
				const chosen = exact ?? matches[0];
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
}
