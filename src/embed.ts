/**
 * Meaning search: each highlight gets a vector from Workers AI, stored in a
 * Vectorize index. Both bindings are optional; without them this module does
 * nothing and the rest of the server is unaffected.
 */
import { type HighlightRow, type ScoredHighlight, Store } from "./store";

export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
/** The model's limit on texts per call. */
const MODEL_BATCH = 32;
/** Highlights embedded per run. Small, so one run stays inside the free plan's CPU limit. */
export const INDEX_BATCH = 64;
/** Vectorize returns at most 100 matches when no values or metadata are asked for. */
export const MAX_MATCHES = 100;

export interface IndexResult {
	embedded: number;
	removed: number;
	pending: number;
}

export function searchReady(
	env: Env,
): env is Env & { AI: Ai; VECTORIZE: Vectorize } {
	return Boolean(env.AI && env.VECTORIZE);
}

/** A stable id of 32 hex characters. Vectorize caps ids at 64 bytes. */
export async function vectorIdFor(asin: string, id: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${asin}:${id}`),
	);
	return [...new Uint8Array(digest)]
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const passageOf = (row: HighlightRow) =>
	[row.text, row.note].filter(Boolean).join("\n");

async function embed(
	ai: Ai,
	texts: string[],
	as: "documents" | "queries",
): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let i = 0; i < texts.length; i += MODEL_BATCH) {
		const slice = texts.slice(i, i + MODEL_BATCH);
		const out = await ai.run(EMBEDDING_MODEL, { [as]: slice });
		const data = (out as { data?: number[][] }).data ?? [];
		if (data.length !== slice.length) {
			throw new Error(
				`Embedding model returned ${data.length} vectors for ${slice.length} texts`,
			);
		}
		vectors.push(...data);
	}
	return vectors;
}

/**
 * Embed highlights that have no vector or a stale one, and delete vectors of
 * highlights that are gone. Returns null when meaning search is not set up.
 */
export async function indexPending(
	env: Env,
	limit = INDEX_BATCH,
): Promise<IndexResult | null> {
	if (!searchReady(env)) return null;
	const store = new Store(env.DB);

	const orphans = await store.orphanEmbeddings(500);
	if (orphans.length) {
		await env.VECTORIZE.deleteByIds(orphans.map((o) => o.vector_id));
		await store.dropEmbeddings(orphans);
	}

	const rows = await store.pendingEmbeddings(limit);
	if (rows.length) {
		const vectors = await embed(env.AI, rows.map(passageOf), "documents");
		const marked = await Promise.all(
			rows.map(async (row) => ({
				row,
				vectorId: await vectorIdFor(row.asin, row.id),
			})),
		);
		await env.VECTORIZE.upsert(
			marked.map(({ row, vectorId }, i) => ({
				id: vectorId,
				values: vectors[i],
				metadata: { asin: row.asin },
			})),
		);
		await store.markEmbedded(marked, Date.now());
	}

	return {
		embedded: rows.length,
		removed: orphans.length,
		pending: await store.pendingEmbeddingCount(),
	};
}

/** Highlights closest in meaning to `query`, best first. */
export async function semanticSearch(
	env: Env,
	query: string,
	limit: number,
	asin?: string,
): Promise<ScoredHighlight[]> {
	if (!searchReady(env)) {
		throw new Error(
			"Meaning search is not set up on this server (AI and VECTORIZE bindings)",
		);
	}
	const [vector] = await embed(env.AI, [query], "queries");
	const { matches } = await env.VECTORIZE.query(vector, {
		topK: Math.min(limit, MAX_MATCHES),
		...(asin ? { filter: { asin } } : {}),
	});
	return new Store(env.DB).highlightsByVector(
		matches.map((m) => ({ id: m.id, score: m.score })),
	);
}
