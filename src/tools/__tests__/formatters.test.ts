import { describe, expect, it } from "vitest";
import type { BookRow, HighlightRow, SyncRunRow } from "../../store";
import {
	formatAcrossBooks,
	formatBookHighlights,
	formatBookList,
	formatHighlight,
} from "../highlights";
import { formatSyncResult, formatSyncStatus } from "../sync";

const TZ = "America/Los_Angeles";

const book = (over: Partial<BookRow> = {}): BookRow => ({
	asin: "B0TEST",
	title: "Outlive",
	authors: "Peter Attia",
	cover_url: "",
	slug: "outlive",
	highlight_count: 2,
	dirty: 0,
	last_synced_at: Date.UTC(2026, 5, 6, 19),
	...over,
});

const highlight = (over: Partial<HighlightRow> = {}): HighlightRow => ({
	asin: "B0TEST",
	id: "highlight:1:9",
	kind: "highlight",
	text: "A passage.",
	note: null,
	color: "yellow",
	location: 4321,
	start_pos: 4321,
	end_pos: 4331,
	truncated: 0,
	modified_at: Date.UTC(2026, 5, 6, 19),
	first_seen_at: 0,
	...over,
});

describe("formatBookList", () => {
	it("points to sync when empty", () => {
		expect(formatBookList([], TZ)).toContain("sync_now");
	});

	it("lists title, author, count and ASIN", () => {
		const out = formatBookList(
			[
				book(),
				book({ asin: "B2", title: "Solo", authors: "", highlight_count: 1 }),
			],
			TZ,
		);
		expect(out).toContain("2 books with highlights:");
		expect(out).toContain(
			"- Outlive by Peter Attia — 2 highlights [asin: B0TEST, synced 2026-06-06]",
		);
		expect(out).toContain("- Solo — 1 highlight [asin: B2");
	});
});

describe("formatHighlight", () => {
	it("shows text, then location, date and colour", () => {
		expect(formatHighlight(highlight(), TZ)).toBe(
			'"A passage."\n(loc 4321, 2026-06-06, yellow)',
		);
	});

	it("includes a note and flags previews", () => {
		const out = formatHighlight(highlight({ note: "Why?", truncated: 1 }), TZ);
		expect(out).toContain('"A passage.…"');
		expect(out).toContain("Note: Why?");
		expect(out).toContain("preview only");
	});
});

describe("formatBookHighlights", () => {
	it("heads the list with the book and count", () => {
		const out = formatBookHighlights(book(), [highlight(), highlight()], TZ);
		expect(out.startsWith("Outlive by Peter Attia — 2 highlights")).toBe(true);
	});

	it("says so when the book has none", () => {
		expect(formatBookHighlights(book(), [], TZ)).toBe(
			"No highlights stored for Outlive by Peter Attia",
		);
	});
});

describe("formatAcrossBooks", () => {
	it("attributes each highlight to its book", () => {
		const out = formatAcrossBooks(
			'Highlights matching "passage"',
			[{ ...highlight(), title: "Outlive", authors: "Peter Attia" }],
			TZ,
		);
		expect(out).toContain('Highlights matching "passage": 1');
		expect(out).toContain("— Outlive, Peter Attia");
	});

	it("reports none", () => {
		expect(formatAcrossBooks("Recent", [], TZ)).toBe("Recent: none");
	});
});

describe("formatSyncResult", () => {
	it("summarises counts, changes, commit and errors", () => {
		const out = formatSyncResult({
			status: "partial",
			librarySize: 120,
			booksChecked: 10,
			newHighlights: 3,
			changedBooks: ["Outlive"],
			commit: "abcdef1234567",
			errors: ["Some Book: Amazon answered 500"],
		});
		expect(out).toContain(
			"Sync partial: checked 10 of 120 books, 3 new highlights",
		);
		expect(out).toContain("Changed: Outlive");
		expect(out).toContain("Committed to repo: abcdef1");
		expect(out).toContain("Some Book: Amazon answered 500");
	});
});

describe("formatSyncStatus", () => {
	const run = (over: Partial<SyncRunRow> = {}): SyncRunRow => ({
		id: 1,
		started_at: Date.UTC(2026, 5, 6, 19),
		finished_at: Date.UTC(2026, 5, 6, 19, 1),
		status: "ok",
		books_checked: 25,
		new_highlights: 4,
		detail: JSON.stringify({ errors: [] }),
		...over,
	});

	it("reports totals when nothing has run", () => {
		const out = formatSyncStatus([], { books: 0, highlights: 0 }, TZ);
		expect(out).toContain("Stored: 0 highlights across 0 books");
		expect(out).toContain("No sync has run yet");
	});

	it("lists runs and shows the last run's errors when it failed", () => {
		const out = formatSyncStatus(
			[
				run({
					status: "failed",
					detail: JSON.stringify({ errors: ["Cookie exchange failed: 400"] }),
				}),
				run({ id: 0 }),
			],
			{ books: 12, highlights: 340 },
			TZ,
		);
		expect(out).toContain("Stored: 340 highlights across 12 books");
		expect(out).toContain("failed, 25 books checked, 4 new, 1 error");
		expect(out).toContain("ok, 25 books checked, 4 new");
		expect(out).toContain("Cookie exchange failed: 400");
	});

	it("survives unreadable detail", () => {
		expect(() =>
			formatSyncStatus(
				[run({ status: "failed", detail: "not json" })],
				{ books: 0, highlights: 0 },
				TZ,
			),
		).not.toThrow();
	});
});
