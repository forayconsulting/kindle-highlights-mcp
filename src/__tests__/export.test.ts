import { describe, expect, it } from "vitest";
import { exportHighlights, toAnki, toCsv, toObsidian } from "../export";
import type { BookRow, HighlightWithBook } from "../store";

const TZ = "America/Los_Angeles";

const book: BookRow = {
	asin: "B0TEST",
	title: "Walden: Or, Life in the Woods",
	authors: "Henry David Thoreau",
	cover_url: "",
	slug: "walden",
	highlight_count: 3,
	dirty: 0,
	last_synced_at: null,
};

const row = (over: Partial<HighlightWithBook> = {}): HighlightWithBook => ({
	asin: book.asin,
	id: "highlight:1:11",
	kind: "highlight",
	text: "Simplify, simplify.",
	note: null,
	color: "yellow",
	location: 120,
	start_pos: 120,
	end_pos: 139,
	truncated: 0,
	modified_at: Date.UTC(2024, 2, 9, 20),
	first_seen_at: 1,
	title: book.title,
	authors: book.authors,
	...over,
});

const rows = [
	row(),
	row({
		id: "highlight:2:12",
		text: 'He said "Our life is\nfrittered away"',
		note: "Detail,\tagain",
		truncated: 1,
	}),
	row({ id: "note:3:3", kind: "note", text: "", note: "Only a note" }),
];

describe("toCsv", () => {
	it("quotes commas, quotes and line breaks", () => {
		expect(toCsv(rows, TZ).split("\r\n")).toEqual([
			"Highlight,Title,Author,Note,Location,Date",
			'"Simplify, simplify.","Walden: Or, Life in the Woods",Henry David Thoreau,,120,2024-03-09',
			'"He said ""Our life is\nfrittered away""…","Walden: Or, Life in the Woods",Henry David Thoreau,"Detail,\tagain",120,2024-03-09',
			',"Walden: Or, Life in the Woods",Henry David Thoreau,Only a note,120,2024-03-09',
			"",
		]);
	});
});

describe("toAnki", () => {
	it("writes one tab-separated card per passage and skips bare notes", () => {
		expect(toAnki(rows).split("\n")).toEqual([
			"#separator:tab",
			"#html:false",
			"#columns:Front\tBack\tTags",
			"#tags column:3",
			"Simplify, simplify.\tWalden: Or, Life in the Woods, Henry David Thoreau\twalden",
			'He said "Our life is frittered away"…\tWalden: Or, Life in the Woods, Henry David Thoreau | Note: Detail, again\twalden',
			"",
		]);
	});
});

describe("toObsidian", () => {
	it("puts YAML properties ahead of the book's markdown", () => {
		const out = toObsidian(book, rows, TZ);
		expect(out.split("\n").slice(0, 9)).toEqual([
			"---",
			'title: "Walden: Or, Life in the Woods"',
			'author: "Henry David Thoreau"',
			'asin: "B0TEST"',
			"highlights: 2",
			"notes: 2",
			"tags: [kindle]",
			"---",
			"# Walden: Or, Life in the Woods",
		]);
		expect(out).toContain("> Simplify, simplify.");
	});
});

describe("exportHighlights", () => {
	it("refuses obsidian without a book", () => {
		expect(() => exportHighlights("obsidian", rows, TZ)).toThrow(/one book/);
	});
});
