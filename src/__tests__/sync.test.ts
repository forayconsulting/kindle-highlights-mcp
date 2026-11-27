import { describe, expect, it } from "vitest";
import type { Annotation } from "../amazon/types";
import type { HighlightRow } from "../store";
import { hasChanged, mergeAnnotations, selectBooks } from "../sync";

const annotation = (over: Partial<Annotation> = {}): Annotation => ({
	id: "highlight:1:9",
	kind: "highlight",
	text: "Preview",
	note: null,
	color: "yellow",
	location: 1,
	start: 1,
	end: 9,
	truncated: false,
	modifiedAt: 1000,
	...over,
});

const row = (over: Partial<HighlightRow> = {}): HighlightRow => ({
	asin: "B1",
	id: "highlight:1:9",
	kind: "highlight",
	text: "Preview",
	note: null,
	color: "yellow",
	location: 1,
	start_pos: 1,
	end_pos: 9,
	truncated: 0,
	modified_at: 1000,
	first_seen_at: 500,
	...over,
});

describe("selectBooks", () => {
	it("takes everything when the library fits in one batch", () => {
		expect(selectBooks(3, 0, 25)).toEqual({
			indices: [0, 1, 2],
			nextCursor: 3,
		});
	});

	it("checks the recent books plus the next sweep slice", () => {
		expect(selectBooks(100, 0, 10, 5)).toEqual({
			indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
			nextCursor: 10,
		});
		expect(selectBooks(100, 10, 10, 5)).toEqual({
			indices: [0, 1, 2, 3, 4, 10, 11, 12, 13, 14],
			nextCursor: 15,
		});
	});

	it("wraps the sweep back to just after the recent books", () => {
		expect(selectBooks(12, 10, 10, 5)).toEqual({
			indices: [0, 1, 2, 3, 4, 10, 11],
			nextCursor: 5,
		});
	});

	it("recovers from a cursor past the end", () => {
		expect(selectBooks(8, 50, 7, 5).indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("never exceeds a batch smaller than the recent count", () => {
		expect(selectBooks(100, 0, 3, 5).indices).toEqual([0, 1, 2]);
	});

	it("handles an empty library", () => {
		expect(selectBooks(0, 0, 25)).toEqual({ indices: [], nextCursor: 0 });
	});
});

describe("mergeAnnotations", () => {
	it("marks unseen annotations as added with the current time", () => {
		const { rows, added, needText } = mergeAnnotations(
			"B1",
			[],
			[annotation()],
			2000,
		);
		expect(added).toEqual(["highlight:1:9"]);
		expect(rows[0].first_seen_at).toBe(2000);
		expect(needText).toEqual([]);
	});

	it("keeps when a known highlight was first seen", () => {
		const { rows, added } = mergeAnnotations(
			"B1",
			[row()],
			[annotation()],
			2000,
		);
		expect(added).toEqual([]);
		expect(rows[0].first_seen_at).toBe(500);
	});

	it("queues a truncated highlight for its full text", () => {
		const { needText } = mergeAnnotations(
			"B1",
			[],
			[annotation({ truncated: true })],
			2000,
		);
		expect(needText).toHaveLength(1);
	});

	it("keeps stored full text when Amazon resends the preview", () => {
		const { rows, needText } = mergeAnnotations(
			"B1",
			[row({ text: "The full passage, fetched earlier." })],
			[annotation({ truncated: true })],
			2000,
		);
		expect(rows[0].text).toBe("The full passage, fetched earlier.");
		expect(rows[0].truncated).toBe(0);
		expect(needText).toEqual([]);
	});

	it("refetches when the highlight was modified since", () => {
		const { rows, needText } = mergeAnnotations(
			"B1",
			[row({ text: "Old full text" })],
			[annotation({ truncated: true, modifiedAt: 3000 })],
			4000,
		);
		expect(rows[0].text).toBe("Preview");
		expect(needText).toHaveLength(1);
	});

	it("does not queue a truncated highlight that has no range", () => {
		const { needText } = mergeAnnotations(
			"B1",
			[],
			[annotation({ truncated: true, start: null, end: null })],
			2000,
		);
		expect(needText).toEqual([]);
	});

	it("drops highlights Amazon no longer returns", () => {
		const { rows } = mergeAnnotations("B1", [row()], [], 2000);
		expect(rows).toEqual([]);
	});
});

describe("hasChanged", () => {
	it("is false for the same rows", () => {
		expect(hasChanged([row()], [row()])).toBe(false);
	});

	it("is true when a highlight is added or removed", () => {
		expect(hasChanged([], [row()])).toBe(true);
		expect(hasChanged([row()], [])).toBe(true);
	});

	it("is true when text, note or truncation changes", () => {
		expect(hasChanged([row()], [row({ text: "Longer" })])).toBe(true);
		expect(hasChanged([row()], [row({ note: "new note" })])).toBe(true);
		expect(hasChanged([row({ truncated: 1 })], [row()])).toBe(true);
	});

	it("ignores first_seen_at", () => {
		expect(hasChanged([row()], [row({ first_seen_at: 9999 })])).toBe(false);
	});
});
