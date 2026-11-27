/** Highlights in formats other tools import: CSV, Anki, and Obsidian. */
import { formatDate, renderBook, slugify } from "./render";
import type { BookRow, HighlightRow, HighlightWithBook } from "./store";

export const EXPORT_FORMATS = ["csv", "anki", "obsidian"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const isExportFormat = (value: string): value is ExportFormat =>
	(EXPORT_FORMATS as readonly string[]).includes(value);

const csvCell = (value: string) =>
	/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const passage = (h: HighlightRow) => (h.truncated ? `${h.text}…` : h.text);

/** The column layout Readwise and most spreadsheet tools accept. */
export function toCsv(rows: HighlightWithBook[], timeZone: string): string {
	const lines = [["Highlight", "Title", "Author", "Note", "Location", "Date"]];
	for (const h of rows) {
		lines.push([
			passage(h),
			h.title,
			h.authors,
			h.note ?? "",
			h.location === null ? "" : String(h.location),
			formatDate(h.modified_at, timeZone),
		]);
	}
	return `${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const ankiCell = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();

/**
 * An Anki text import: the passage on the front, the book on the back, and
 * the book's slug as a tag. Notes without a passage are left out.
 */
export function toAnki(rows: HighlightWithBook[]): string {
	const lines = [
		"#separator:tab",
		"#html:false",
		"#columns:Front\tBack\tTags",
		"#tags column:3",
	];
	for (const h of rows) {
		if (!h.text) continue;
		const source = h.authors ? `${h.title}, ${h.authors}` : h.title;
		const back = h.note ? `${source} | Note: ${h.note}` : source;
		lines.push([passage(h), back, slugify(h.title)].map(ankiCell).join("\t"));
	}
	return `${lines.join("\n")}\n`;
}

const yaml = (value: string) => JSON.stringify(value);

/** One book as an Obsidian note: YAML properties, then the usual markdown. */
export function toObsidian(
	book: BookRow,
	highlights: HighlightRow[],
	timeZone: string,
): string {
	const front = [
		"---",
		`title: ${yaml(book.title)}`,
		`author: ${yaml(book.authors)}`,
		`asin: ${yaml(book.asin)}`,
		`highlights: ${highlights.filter((h) => h.kind === "highlight").length}`,
		`notes: ${highlights.filter((h) => h.note).length}`,
		"tags: [kindle]",
		"---",
		"",
	];
	return front.join("\n") + renderBook(book, highlights, timeZone);
}

export const exportFile = (format: ExportFormat, slug = "kindle-highlights") =>
	({
		csv: { name: `${slug}.csv`, type: "text/csv; charset=utf-8" },
		anki: { name: `${slug}-anki.txt`, type: "text/plain; charset=utf-8" },
		obsidian: { name: `${slug}.md`, type: "text/markdown; charset=utf-8" },
	})[format];

/** Render `rows` (all from `book` when one is given) in `format`. */
export function exportHighlights(
	format: ExportFormat,
	rows: HighlightWithBook[],
	timeZone: string,
	book?: BookRow,
): string {
	if (format === "csv") return toCsv(rows, timeZone);
	if (format === "anki") return toAnki(rows);
	if (!book) throw new Error("The obsidian format exports one book at a time");
	return toObsidian(book, rows, timeZone);
}
