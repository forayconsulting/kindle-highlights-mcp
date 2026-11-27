import { describe, expect, it } from "vitest";
import { indexPending, semanticSearch, vectorIdFor } from "../embed";
import { type HighlightRow, Store } from "../store";
import { localDay } from "../tools/highlights";
import { createD1 } from "./d1-shim";

const BOOK = {
	asin: "B0TEST",
	title: "Walden",
	authors: ["Henry David Thoreau"],
	coverUrl: "",
	resourceType: "EBOOK",
	originType: "PURCHASE",
};

const row = (start: number, text: string, over: Partial<HighlightRow> = {}) =>
	({
		asin: BOOK.asin,
		id: `highlight:${start}:${start + 10}`,
		kind: "highlight",
		text,
		note: null,
		color: "yellow",
		location: start,
		start_pos: start,
		end_pos: start + 10,
		truncated: 0,
		modified_at: 1000,
		first_seen_at: 1,
		...over,
	}) satisfies HighlightRow;

/** Two-number vectors: how many times the text says "simple", and its length. */
const vectorOf = (text: string) => [
	(text.match(/simpl/gi) ?? []).length,
	text.length / 100,
];

function makeEnv() {
	const vectors = new Map<string, number[]>();
	const calls = { documents: [] as string[][], queries: [] as string[][] };
	const env = {
		DB: createD1(),
		TIMEZONE: "America/Los_Angeles",
		AI: {
			run: async (
				_model: string,
				input: { documents?: string[]; queries?: string[] },
			) => {
				if (input.documents) calls.documents.push(input.documents);
				if (input.queries) calls.queries.push(input.queries);
				return { data: (input.documents ?? input.queries ?? []).map(vectorOf) };
			},
		},
		VECTORIZE: {
			upsert: async (items: { id: string; values: number[] }[]) => {
				for (const item of items) vectors.set(item.id, item.values);
			},
			deleteByIds: async (ids: string[]) => {
				for (const id of ids) vectors.delete(id);
			},
			query: async (vector: number[], options: { topK: number }) => ({
				matches: [...vectors]
					.map(([id, values]) => ({ id, score: values[0] * vector[0] }))
					.sort((a, b) => b.score - a.score)
					.slice(0, options.topK),
			}),
		},
	} as unknown as Env;
	return { env, vectors, calls, store: new Store(env.DB) };
}

describe("vectorIdFor", () => {
	it("is stable and 32 hex characters", async () => {
		const id = await vectorIdFor("B0TEST", "highlight:1:11");
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await vectorIdFor("B0TEST", "highlight:1:11")).toBe(id);
		expect(await vectorIdFor("B0TEST", "highlight:2:12")).not.toBe(id);
	});
});

describe("indexPending", () => {
	it("does nothing when the bindings are missing", async () => {
		expect(await indexPending({ DB: createD1() } as Env)).toBeNull();
	});

	it("embeds each highlight once", async () => {
		const { env, vectors, calls, store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "Simplify, simplify."), row(20, "", { note: "My own note" })],
			true,
			5,
		);

		expect(await indexPending(env)).toEqual({
			embedded: 2,
			removed: 0,
			pending: 0,
		});
		expect(vectors.size).toBe(2);
		expect(calls.documents.flat()).toEqual([
			"Simplify, simplify.",
			"My own note",
		]);

		// Sync rewrites the book's rows on every run. That must not re-embed.
		await store.saveBook(
			BOOK,
			"walden",
			await store.highlights("B0TEST"),
			false,
			6,
		);
		expect(await indexPending(env)).toEqual({
			embedded: 0,
			removed: 0,
			pending: 0,
		});
		expect((await store.totals()).indexed).toBe(2);
	});

	it("works through a backlog in batches", async () => {
		const { env, store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "One."), row(20, "Two."), row(40, "Three.")],
			true,
			5,
		);
		expect(await indexPending(env, 2)).toMatchObject({
			embedded: 2,
			pending: 1,
		});
		expect(await indexPending(env, 2)).toMatchObject({
			embedded: 1,
			pending: 0,
		});
	});

	it("embeds again when a preview becomes the full passage", async () => {
		const { env, calls, store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "Our life is", { truncated: 1 })],
			true,
			5,
		);
		await indexPending(env);
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "Our life is frittered away by detail.")],
			true,
			6,
		);
		expect(await indexPending(env)).toMatchObject({ embedded: 1 });
		expect(calls.documents.flat()).toEqual([
			"Our life is",
			"Our life is frittered away by detail.",
		]);
	});

	it("removes the vector of a deleted highlight", async () => {
		const { env, vectors, store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "One."), row(20, "Two.")],
			true,
			5,
		);
		await indexPending(env);
		await store.saveBook(BOOK, "walden", [row(1, "One.")], true, 6);

		expect(await indexPending(env)).toEqual({
			embedded: 0,
			removed: 1,
			pending: 0,
		});
		expect([...vectors.keys()]).toEqual([
			await vectorIdFor("B0TEST", "highlight:1:11"),
		]);
	});
});

describe("semanticSearch", () => {
	it("returns stored highlights in score order with the book", async () => {
		const { env, calls, store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[row(1, "I went to the woods."), row(20, "Simplify, simplify.")],
			true,
			5,
		);
		await indexPending(env);

		const found = await semanticSearch(env, "a simple life", 1);
		expect(calls.queries).toEqual([["a simple life"]]);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			text: "Simplify, simplify.",
			title: "Walden",
			score: 2,
		});
		expect(found[0]).not.toHaveProperty("vector_id");
	});

	it("says so when the bindings are missing", async () => {
		await expect(
			semanticSearch({ DB: createD1() } as Env, "anything", 5),
		).rejects.toThrow(/not set up/);
	});
});

describe("resurfacing", () => {
	it("finds highlights made on this day in an earlier year", async () => {
		const { store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[
				// 11pm on July 4 2020 in Los Angeles is already July 5 in UTC.
				row(1, "Earlier year.", { modified_at: Date.UTC(2020, 6, 5, 6) }),
				row(20, "This year.", { modified_at: Date.UTC(2026, 6, 4, 20) }),
				row(40, "Another day.", { modified_at: Date.UTC(2020, 6, 6, 20) }),
			],
			true,
			5,
		);
		const today = localDay(Date.UTC(2026, 6, 4, 20), "America/Los_Angeles");
		expect(today).toEqual({
			year: "2026",
			monthDay: "07-04",
			offsetMinutes: -420,
		});

		const rows = await store.onThisDay(
			today.monthDay,
			today.year,
			today.offsetMinutes,
			5,
		);
		expect(rows.map((r) => r.text)).toEqual(["Earlier year."]);
	});

	it("picks only full-text highlights at random", async () => {
		const { store } = makeEnv();
		await store.saveBook(
			BOOK,
			"walden",
			[
				row(1, "Full."),
				row(20, "Preview", { truncated: 1 }),
				row(40, "", { note: "n" }),
			],
			true,
			5,
		);
		const rows = await store.randomHighlights(5);
		expect(rows.map((r) => r.text)).toEqual(["Full."]);
		expect(rows[0].title).toBe("Walden");
	});
});
