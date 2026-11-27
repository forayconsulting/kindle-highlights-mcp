import { describe, expect, it } from "vitest";
import { isTruncated, parseAnnotations } from "../annotations";

const body = (annotations: unknown[]) => JSON.stringify({ annotations });

describe("isTruncated", () => {
	it("keeps a short highlight whose range matches its text", () => {
		expect(isTruncated("A short passage.", 100, 116)).toBe(false);
	});

	it("flags text at the preview cap", () => {
		expect(isTruncated("x".repeat(95), 100, 195)).toBe(true);
	});

	it("flags a range much longer than the text", () => {
		expect(isTruncated("Only the start", 100, 600)).toBe(true);
	});

	it("does not flag when there is no range", () => {
		expect(isTruncated("No positions", null, null)).toBe(false);
	});
});

describe("parseAnnotations", () => {
	it("skips bookmarks and empty entries", () => {
		const items = parseAnnotations(
			body([
				{ type: "kindle.bookmark", position: 10 },
				{ type: "kindle.highlight", context: "  ", start: 1, end: 2 },
				{ type: "kindle.highlight", context: "Kept", start: 5, end: 9 },
			]),
		);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("Kept");
	});

	it("maps highlight fields and builds a position-based id", () => {
		const [item] = parseAnnotations(
			body([
				{
					type: "kindle.highlight",
					context: " Cancer, like insanity. ",
					highlightColor: "yellow",
					position: 4321,
					start: 4321,
					end: 4343,
					modifiedTimestamp: 1760000000000,
				},
			]),
		);
		expect(item).toEqual({
			id: "highlight:4321:4343",
			kind: "highlight",
			text: "Cancer, like insanity.",
			note: null,
			color: "yellow",
			location: 4321,
			start: 4321,
			end: 4343,
			truncated: false,
			modifiedAt: 1760000000000,
		});
	});

	it("keeps notes and never marks them truncated", () => {
		const [item] = parseAnnotations(
			body([
				{
					type: "kindle.note",
					context: "",
					note: " my thought ",
					start: 50,
					end: 900,
				},
			]),
		);
		expect(item.kind).toBe("note");
		expect(item.note).toBe("my thought");
		expect(item.truncated).toBe(false);
		expect(item.id).toBe("note:50:900");
	});

	it("drops duplicates of the same range", () => {
		const one = { type: "kindle.highlight", context: "Same", start: 1, end: 5 };
		expect(parseAnnotations(body([one, one]))).toHaveLength(1);
	});

	it("returns nothing for a response without annotations", () => {
		expect(parseAnnotations("{}")).toEqual([]);
	});

	it("throws on a non-JSON body", () => {
		expect(() => parseAnnotations("<html>")).toThrow();
	});
});
