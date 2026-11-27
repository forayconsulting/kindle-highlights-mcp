import { afterEach, describe, expect, it, vi } from "vitest";
import { AmazonError, type Annotation, type Book } from "../amazon/types";
import { Store } from "../store";
import { runSync, type SyncSource } from "../sync";
import { createD1, createKV } from "./d1-shim";

const transport = {
	name: "unused",
	send: async () => {
		throw new Error("transport must not be used when a source is given");
	},
};

function makeEnv(over: Partial<Env> = {}): Env {
	return {
		DB: createD1(),
		KINDLE_KV: createKV(),
		TIMEZONE: "America/Los_Angeles",
		GITHUB_REPO: "owner/repo",
		GITHUB_BRANCH: "main",
		SYNC_BATCH_SIZE: "25",
		...over,
	} as Env;
}

const book = (asin: string, title: string): Book => ({
	asin,
	title,
	authors: ["Ann Author"],
	coverUrl: "",
	resourceType: "EBOOK",
	originType: "PURCHASE",
});

const hl = (
	start: number,
	text: string,
	over: Partial<Annotation> = {},
): Annotation => ({
	id: `highlight:${start}:${start + 10}`,
	kind: "highlight",
	text,
	note: null,
	color: "yellow",
	location: start,
	start,
	end: start + 10,
	truncated: false,
	modifiedAt: 1000,
	...over,
});

function makeSource(
	books: Book[],
	annotations: Record<string, Annotation[] | Error>,
	copyText: SyncSource["copyText"] = async () => "The full passage.",
) {
	const calls = { annotations: [] as string[], copyText: 0 };
	const source: SyncSource = {
		library: async () => books,
		annotations: async (asin) => {
			calls.annotations.push(asin);
			const answer = annotations[asin] ?? [];
			if (answer instanceof Error) throw answer;
			return { items: answer, guid: "G", revision: "R" };
		},
		copyText: async (...args) => {
			calls.copyText++;
			return copyText(...args);
		},
	};
	return { source, calls };
}

const run = (env: Env, source: SyncSource, maxBooks?: number) =>
	runSync(env, { transport, source, pauseMs: 0, maxBooks });

afterEach(() => vi.unstubAllGlobals());

describe("runSync", () => {
	it("stores new highlights and reports them", async () => {
		const env = makeEnv();
		const { source } = makeSource(
			[book("B1", "First Book: Subtitle"), book("B2", "No Highlights")],
			{ B1: [hl(10, "One"), hl(50, "Two")] },
		);
		const result = await run(env, source);

		expect(result).toMatchObject({
			status: "ok",
			librarySize: 2,
			booksChecked: 2,
			newHighlights: 2,
			changedBooks: ["First Book: Subtitle"],
			commit: null,
			errors: [],
		});
		const store = new Store(env.DB);
		const books = await store.booksWithHighlights();
		expect(books.map((b) => [b.asin, b.slug, b.highlight_count])).toEqual([
			["B1", "first-book", 2],
		]);
		expect((await store.highlights("B1")).map((h) => h.text)).toEqual([
			"One",
			"Two",
		]);
		const [last] = await store.lastRuns(1);
		expect(last).toMatchObject({
			status: "ok",
			books_checked: 2,
			new_highlights: 2,
		});
		expect(last.finished_at).not.toBeNull();
	});

	it("finds nothing new on a second run and keeps first-seen times", async () => {
		const env = makeEnv();
		const { source } = makeSource([book("B1", "Book")], {
			B1: [hl(10, "One")],
		});
		await run(env, source);
		const store = new Store(env.DB);
		const [before] = await store.highlights("B1");

		const again = await run(env, source);
		expect(again.newHighlights).toBe(0);
		expect(again.changedBooks).toEqual([]);
		const [after] = await store.highlights("B1");
		expect(after.first_seen_at).toBe(before.first_seen_at);
	});

	it("picks up an added highlight and drops a deleted one", async () => {
		const env = makeEnv();
		const first = makeSource([book("B1", "Book")], {
			B1: [hl(10, "Stays"), hl(50, "Goes")],
		});
		await run(env, first.source);
		const second = makeSource([book("B1", "Book")], {
			B1: [hl(10, "Stays"), hl(90, "Arrives")],
		});
		const result = await run(env, second.source);

		expect(result.newHighlights).toBe(1);
		expect(result.changedBooks).toEqual(["Book"]);
		expect(
			(await new Store(env.DB).highlights("B1")).map((h) => h.text),
		).toEqual(["Stays", "Arrives"]);
	});

	it("expands a preview once and does not ask again", async () => {
		const env = makeEnv();
		const { source, calls } = makeSource([book("B1", "Book")], {
			B1: [hl(10, "Preview", { truncated: true })],
		});
		await run(env, source);
		const [stored] = await new Store(env.DB).highlights("B1");
		expect(stored).toMatchObject({ text: "The full passage.", truncated: 0 });

		const again = await run(env, source);
		expect(calls.copyText).toBe(1);
		expect(again.changedBooks).toEqual([]);
	});

	it("keeps the preview when Amazon refuses the full text, and retries next run", async () => {
		const env = makeEnv();
		const { source, calls } = makeSource(
			[book("B1", "Book")],
			{ B1: [hl(10, "Preview", { truncated: true })] },
			async () => {
				throw new AmazonError("http", "copyText status: LimitExceeded");
			},
		);
		const result = await run(env, source);
		expect(result.status).toBe("ok");
		const [stored] = await new Store(env.DB).highlights("B1");
		expect(stored).toMatchObject({ text: "Preview", truncated: 1 });

		await run(env, source);
		expect(calls.copyText).toBe(2);
	});

	it("carries on past one book's error and reports partial", async () => {
		const env = makeEnv();
		const { source } = makeSource([book("B1", "Broken"), book("B2", "Fine")], {
			B1: new AmazonError("http", "Amazon answered 500", 500),
			B2: [hl(10, "One")],
		});
		const result = await run(env, source);
		expect(result.status).toBe("partial");
		expect(result.errors).toEqual(["Broken: Amazon answered 500"]);
		expect(result.newHighlights).toBe(1);
	});

	it("stops at once when the session is refused", async () => {
		const env = makeEnv();
		const { source, calls } = makeSource(
			[book("B1", "First"), book("B2", "Second")],
			{ B1: new AmazonError("auth-expired", "Amazon redirected to sign-in") },
		);
		const result = await run(env, source);
		expect(result.status).toBe("failed");
		expect(calls.annotations).toEqual(["B1"]);
		expect((await new Store(env.DB).lastRuns(1))[0].status).toBe("failed");
	});

	it("gives two books with the same title different folders", async () => {
		const env = makeEnv();
		const { source } = makeSource(
			[book("B1", "Meditations"), book("B2", "Meditations")],
			{ B1: [hl(10, "One")], B2: [hl(10, "Two")] },
		);
		await run(env, source);
		const slugs = (await new Store(env.DB).booksWithHighlights())
			.map((b) => b.slug)
			.sort();
		expect(slugs).toEqual(["meditations", "meditations-b2"]);
	});

	it("sweeps the rest of the library across runs", async () => {
		const env = makeEnv();
		const books = Array.from({ length: 12 }, (_, i) =>
			book(`B${i}`, `Book ${i}`),
		);
		const { source, calls } = makeSource(books, {});
		await run(env, source, 8);
		await run(env, source, 8);
		await run(env, source, 8);
		expect(calls.annotations).toEqual([
			...["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7"],
			...["B0", "B1", "B2", "B3", "B4", "B8", "B9", "B10"],
			...["B0", "B1", "B2", "B3", "B4", "B11"],
		]);
	});

	it("commits changed books in one commit and does not recommit unchanged ones", async () => {
		const env = makeEnv({ GITHUB_TOKEN: "tok" });
		const requests: { method: string; path: string; body: any }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname;
			const body = init.body ? JSON.parse(String(init.body)) : null;
			requests.push({ method: init.method ?? "GET", path, body });
			expect((init.headers as Record<string, string>).Authorization).toBe(
				"Bearer tok",
			);
			const answer = path.endsWith("/git/ref/heads/main")
				? { object: { sha: "parent" } }
				: path.endsWith("/git/commits/parent")
					? { tree: { sha: "tree0" } }
					: path.endsWith("/git/trees")
						? { sha: "tree1" }
						: path.endsWith("/git/commits")
							? { sha: "newcommit" }
							: {};
			return new Response(JSON.stringify(answer), { status: 200 });
		});

		const { source } = makeSource(
			[book("B1", "First Book"), book("B2", "Second")],
			{
				B1: [hl(10, "One")],
				B2: [hl(10, "Two")],
			},
		);
		const result = await run(env, source);
		expect(result.commit).toBe("newcommit");

		const tree = requests.find((r) => r.path.endsWith("/git/trees"));
		expect(tree?.body.base_tree).toBe("tree0");
		expect(tree?.body.tree.map((f: { path: string }) => f.path).sort()).toEqual(
			["first-book/highlights.md", "second/highlights.md"],
		);
		expect(tree?.body.tree[0].content).toContain("> ");
		const commit = requests.find(
			(r) => r.method === "POST" && r.path.endsWith("/git/commits"),
		);
		expect(commit?.body).toMatchObject({ tree: "tree1", parents: ["parent"] });
		expect(commit?.body.message).toBe(
			"Sync Kindle highlights: 2 books (2 new)",
		);
		expect(requests.at(-1)).toMatchObject({
			method: "PATCH",
			path: "/repos/owner/repo/git/refs/heads/main",
			body: { sha: "newcommit" },
		});

		const count = requests.length;
		const again = await run(env, source);
		expect(again.commit).toBeNull();
		expect(requests.length).toBe(count);
	});

	it("keeps books marked for commit when GitHub fails, and commits them next run", async () => {
		const env = makeEnv({ GITHUB_TOKEN: "tok" });
		vi.stubGlobal(
			"fetch",
			async () => new Response("Bad credentials", { status: 401 }),
		);
		const { source } = makeSource([book("B1", "Book")], {
			B1: [hl(10, "One")],
		});
		const result = await run(env, source);
		expect(result.status).toBe("partial");
		expect(result.errors[0]).toContain("Commit: GitHub GET");
		expect(await new Store(env.DB).dirtyBooks()).toHaveLength(1);

		vi.stubGlobal("fetch", async (url: string) => {
			const path = new URL(url).pathname;
			const answer = path.includes("/git/ref/")
				? { object: { sha: "p" } }
				: path.endsWith("/git/commits/p")
					? { tree: { sha: "t0" } }
					: { sha: "next" };
			return new Response(JSON.stringify(answer), { status: 200 });
		});
		const retry = await run(env, source);
		expect(retry.newHighlights).toBe(0);
		expect(retry.commit).toBe("next");
		expect(await new Store(env.DB).dirtyBooks()).toHaveLength(0);
	});
});

describe("Store queries", () => {
	it("searches text and notes, and filters recent by highlight date", async () => {
		const env = makeEnv();
		const now = Date.now();
		const { source } = makeSource(
			[book("B1", "Book One"), book("B2", "Other")],
			{
				B1: [
					hl(10, "On memory palaces", { modifiedAt: now - 1000 }),
					hl(50, "Something else", {
						note: "ties to memory",
						modifiedAt: now - 30 * 86_400_000,
					}),
				],
				B2: [hl(10, "Unrelated", { modifiedAt: now - 2000 })],
			},
		);
		await run(env, source);
		const store = new Store(env.DB);

		expect((await store.search("MEMORY", 10)).map((h) => h.id).sort()).toEqual([
			"highlight:10:20",
			"highlight:50:60",
		]);
		expect((await store.search("memory", 10))[0].title).toBe("Book One");
		expect(
			(await store.recent(now - 7 * 86_400_000, 10)).map((h) => h.text),
		).toEqual(["On memory palaces", "Unrelated"]);
		expect((await store.findBooks("one")).map((b) => b.asin)).toEqual(["B1"]);
		expect((await store.findBooks("B2")).map((b) => b.asin)).toEqual(["B2"]);
		expect(await store.totals()).toEqual({
			books: 2,
			highlights: 3,
			indexed: 0,
		});
	});
});
