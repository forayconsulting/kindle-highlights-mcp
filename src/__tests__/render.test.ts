import { describe, expect, it } from "vitest";
import { filePathFor, formatDate, renderBook, slugify } from "../render";
import type { BookRow, HighlightRow } from "../store";

const book: BookRow = {
	asin: "B0TEST",
	title: "Outlive: The Science and Art of Longevity",
	authors: "Peter Attia, Bill Gifford",
	cover_url: "",
	slug: "outlive",
	highlight_count: 2,
	dirty: 1,
	last_synced_at: null,
};

const highlight = (over: Partial<HighlightRow> = {}): HighlightRow => ({
	asin: "B0TEST",
	id: "highlight:1:9",
	kind: "highlight",
	text: "Cancer, like insanity, seems to increase.",
	note: null,
	color: "yellow",
	location: 4321,
	start_pos: 4321,
	end_pos: 4362,
	truncated: 0,
	// 2026-06-06 19:00 UTC = 12:00 in Los Angeles
	modified_at: Date.UTC(2026, 5, 6, 19),
	first_seen_at: 0,
	...over,
});

describe("slugify", () => {
	it("uses the main title, without subtitle or series", () => {
		expect(slugify("Outlive: The Science and Art of Longevity")).toBe(
			"outlive",
		);
		expect(slugify("Los hermanos Karamázov (13_20) (Spanish Edition)")).toBe(
			"los-hermanos-karamazov",
		);
	});

	it("drops apostrophes and collapses punctuation", () => {
		expect(slugify("Surely You're Joking, Mr. Feynman!")).toBe(
			"surely-youre-joking-mr-feynman",
		);
	});

	it("caps length without a trailing dash", () => {
		const slug = slugify(`${"word ".repeat(30)}`);
		expect(slug.length).toBeLessThanOrEqual(60);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("falls back for titles with no usable characters", () => {
		expect(slugify("???")).toBe("untitled");
		expect(slugify(": Subtitle Only")).toBe("subtitle-only");
	});
});

describe("formatDate", () => {
	it("formats in the given time zone", () => {
		// 03:00 UTC on the 7th is still the 6th in Los Angeles
		expect(formatDate(Date.UTC(2026, 5, 7, 3), "America/Los_Angeles")).toBe(
			"2026-06-06",
		);
	});

	it("is empty without a timestamp", () => {
		expect(formatDate(null, "UTC")).toBe("");
	});
});

describe("renderBook", () => {
	it("renders a header and each highlight as a blockquote", () => {
		const md = renderBook(
			book,
			[
				highlight(),
				highlight({ id: "b", note: "Check the source", location: 5000 }),
			],
			"America/Los_Angeles",
		);
		expect(md.startsWith("# Outlive: The Science and Art of Longevity\n")).toBe(
			true,
		);
		expect(md).toContain("*Peter Attia, Bill Gifford*");
		expect(md).toContain("2 highlights · ASIN B0TEST");
		expect(md).toContain("> Cancer, like insanity, seems to increase.");
		expect(md).toContain("<sub>Location 4321 · 2026-06-06</sub>");
		expect(md).toContain("**Note:** Check the source");
		expect(md.endsWith("\n")).toBe(true);
		expect(md.endsWith("\n\n")).toBe(false);
	});

	it("marks previews", () => {
		const md = renderBook(book, [highlight({ truncated: 1 })], "UTC");
		expect(md).toContain("> Cancer, like insanity, seems to increase.…");
		expect(md).toContain("preview only");
	});

	it("renders a standalone note without an empty blockquote", () => {
		const md = renderBook(
			book,
			[highlight({ kind: "note", text: "", note: "Just a note" })],
			"UTC",
		);
		expect(md).toContain("**Note:** Just a note");
		expect(md).not.toContain("\n>");
	});

	it("quotes every line of a multi-line highlight", () => {
		const md = renderBook(book, [highlight({ text: "One\n\nTwo" })], "UTC");
		expect(md).toContain("> One\n>\n> Two");
	});

	it("says '1 highlight' for one", () => {
		expect(renderBook(book, [highlight()], "UTC")).toContain("1 highlight ·");
	});
});

describe("filePathFor", () => {
	it("puts the file in the book's own subdirectory", () => {
		expect(filePathFor("outlive")).toBe("outlive/highlights.md");
	});
});
