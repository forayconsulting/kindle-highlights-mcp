/**
 * The sync job: read the Kindle library, pull annotations for a batch of
 * books, store what changed, and commit the changed books to the repo.
 */

import { websiteCookies } from "./amazon/device";
import { CloudReader } from "./amazon/reader";
import type { Transport } from "./amazon/transport";
import { AmazonError, type Annotation, type Book } from "./amazon/types";
import {
	deviceTokenFor,
	loadCredentials,
	loadCursor,
	saveCursor,
} from "./auth";
import { indexPending } from "./embed";
import { commitFiles, type RepoFile } from "./github";
import { filePathFor, renderBook, slugify } from "./render";
import { type HighlightRow, Store } from "./store";

/** Books at the top of the library (most recently read) checked on every run. */
export const RECENT_BOOKS = 5;
/** Full-text lookups per run, so one heavily highlighted book cannot use the whole run. */
const COPY_TEXT_BUDGET = 150;
const PAUSE_MS = 250;

/** What sync reads from. `CloudReader` is the real one. */
export interface SyncSource {
	library(): Promise<Book[]>;
	annotations(
		asin: string,
	): Promise<{ items: Annotation[]; guid: string; revision: string }>;
	copyText(
		asin: string,
		guid: string,
		revision: string,
		start: number,
		end: number,
	): Promise<string>;
}

export interface SyncOptions {
	maxBooks?: number;
	transport: Transport;
	/** Replaces the Amazon client; used by tests. */
	source?: SyncSource;
	/** Delay between Amazon calls. */
	pauseMs?: number;
}

async function openReader(env: Env, transport: Transport): Promise<SyncSource> {
	const credentials = await loadCredentials(env);
	const cookies = await websiteCookies(credentials);
	return new CloudReader(transport, cookies, await deviceTokenFor(env));
}

export interface SyncResult {
	status: "ok" | "partial" | "failed";
	librarySize: number;
	booksChecked: number;
	newHighlights: number;
	changedBooks: string[];
	commit: string | null;
	/** Highlights embedded for meaning search this run. */
	indexed: number;
	errors: string[];
}

/**
 * Which library positions to check this run: the most recent few every time,
 * plus the next slice of a sweep through the rest.
 */
export function selectBooks(
	total: number,
	cursor: number,
	batch: number,
	recent = RECENT_BOOKS,
): { indices: number[]; nextCursor: number } {
	const head = Math.min(recent, total, batch);
	const indices = Array.from({ length: head }, (_, i) => i);
	const sweep = Math.max(batch - head, 0);
	if (total <= head || sweep === 0) return { indices, nextCursor: head };

	const start = cursor >= head && cursor < total ? cursor : head;
	const end = Math.min(start + sweep, total);
	for (let i = start; i < end; i++) indices.push(i);
	return { indices, nextCursor: end >= total ? head : end };
}

const rowKey = (r: HighlightRow) =>
	JSON.stringify([r.id, r.text, r.note, r.color, r.truncated, r.modified_at]);

/**
 * Combine what Amazon returned with what is stored. A stored full text is
 * kept when Amazon sends the same highlight again as a preview.
 */
export function mergeAnnotations(
	asin: string,
	existing: HighlightRow[],
	fetched: Annotation[],
	now: number,
): { rows: HighlightRow[]; added: string[]; needText: HighlightRow[] } {
	const known = new Map(existing.map((r) => [r.id, r]));
	const rows: HighlightRow[] = [];
	const added: string[] = [];
	const needText: HighlightRow[] = [];

	for (const a of fetched) {
		const old = known.get(a.id);
		const keepFullText =
			old !== undefined &&
			old.truncated === 0 &&
			a.truncated &&
			old.modified_at === a.modifiedAt;
		const row: HighlightRow = {
			asin,
			id: a.id,
			kind: a.kind,
			text: keepFullText ? old.text : a.text,
			note: a.note,
			color: a.color,
			location: a.location,
			start_pos: a.start,
			end_pos: a.end,
			truncated: keepFullText ? 0 : a.truncated ? 1 : 0,
			modified_at: a.modifiedAt,
			first_seen_at: old?.first_seen_at ?? now,
		};
		rows.push(row);
		if (!old) added.push(a.id);
		if (row.truncated && row.start_pos !== null && row.end_pos !== null) {
			needText.push(row);
		}
	}
	return { rows, added, needText };
}

export function hasChanged(
	existing: HighlightRow[],
	rows: HighlightRow[],
): boolean {
	if (existing.length !== rows.length) return true;
	const before = new Set(existing.map(rowKey));
	return rows.some((r) => !before.has(rowKey(r)));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const describe = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

async function slugFor(store: Store, book: Book): Promise<string> {
	const stored = await store.book(book.asin);
	if (stored) return stored.slug;
	const slug = slugify(book.title);
	const owner = await store.slugOwner(slug);
	return owner && owner !== book.asin
		? `${slug}-${book.asin.toLowerCase()}`
		: slug;
}

/** Write every book whose file is behind the database, in one commit. */
export async function commitDirtyBooks(
	env: Env,
	store: Store,
	newHighlights: number,
): Promise<string | null> {
	if (!env.GITHUB_TOKEN) return null;
	const dirty = await store.dirtyBooks();
	if (dirty.length === 0) return null;

	const files: RepoFile[] = [];
	for (const book of dirty) {
		files.push({
			path: filePathFor(book.slug),
			content: renderBook(
				book,
				await store.highlights(book.asin),
				env.TIMEZONE,
			),
		});
	}
	const what = dirty.length === 1 ? dirty[0].title : `${dirty.length} books`;
	const sha = await commitFiles(
		env.GITHUB_TOKEN,
		env.GITHUB_REPO,
		env.GITHUB_BRANCH,
		files,
		`Sync Kindle highlights: ${what}${newHighlights ? ` (${newHighlights} new)` : ""}`,
	);
	await store.clearDirty(dirty.map((b) => b.asin));
	return sha;
}

export async function runSync(
	env: Env,
	options: SyncOptions,
): Promise<SyncResult> {
	const store = new Store(env.DB);
	const runId = await store.startRun(Date.now());
	const result: SyncResult = {
		status: "ok",
		librarySize: 0,
		booksChecked: 0,
		newHighlights: 0,
		changedBooks: [],
		commit: null,
		indexed: 0,
		errors: [],
	};

	try {
		const reader = options.source ?? (await openReader(env, options.transport));
		const pauseMs = options.pauseMs ?? PAUSE_MS;

		const library = await reader.library();
		result.librarySize = library.length;

		const batch = options.maxBooks ?? (Number(env.SYNC_BATCH_SIZE) || 25);
		const { indices, nextCursor } = selectBooks(
			library.length,
			await loadCursor(env),
			batch,
		);

		let copyBudget = COPY_TEXT_BUDGET;
		for (const index of indices) {
			const book = library[index];
			try {
				const { items, guid, revision } = await reader.annotations(book.asin);
				const existing = await store.highlights(book.asin);
				result.booksChecked++;
				if (items.length === 0 && existing.length === 0) continue;

				const now = Date.now();
				const { rows, added, needText } = mergeAnnotations(
					book.asin,
					existing,
					items,
					now,
				);
				for (const row of needText) {
					if (copyBudget <= 0) break;
					copyBudget--;
					try {
						row.text = await reader.copyText(
							book.asin,
							guid,
							revision,
							row.start_pos as number,
							row.end_pos as number,
						);
						row.truncated = 0;
					} catch (error) {
						if (error instanceof AmazonError && error.kind === "auth-expired") {
							throw error;
						}
						// Publisher limits: the preview stays, flagged truncated.
					}
					await pause(pauseMs);
				}

				const changed = hasChanged(existing, rows);
				await store.saveBook(
					book,
					await slugFor(store, book),
					rows,
					changed,
					now,
				);
				result.newHighlights += added.length;
				if (changed) result.changedBooks.push(book.title);
			} catch (error) {
				if (
					error instanceof AmazonError &&
					(error.kind === "auth-expired" || error.kind === "blocked")
				) {
					throw error;
				}
				result.errors.push(`${book.title}: ${describe(error)}`);
			}
			await pause(pauseMs);
		}
		await saveCursor(env, nextCursor);
		if (result.errors.length) result.status = "partial";
	} catch (error) {
		result.status = "failed";
		result.errors.push(describe(error));
	}

	try {
		result.commit = await commitDirtyBooks(env, store, result.newHighlights);
	} catch (error) {
		if (result.status === "ok") result.status = "partial";
		result.errors.push(`Commit: ${describe(error)}`);
	}

	try {
		result.indexed = (await indexPending(env))?.embedded ?? 0;
	} catch (error) {
		if (result.status === "ok") result.status = "partial";
		result.errors.push(`Search index: ${describe(error)}`);
	}

	await store.finishRun(
		runId,
		Date.now(),
		result.status,
		result.booksChecked,
		result.newHighlights,
		JSON.stringify({
			librarySize: result.librarySize,
			changedBooks: result.changedBooks,
			commit: result.commit,
			errors: result.errors.slice(0, 20),
		}),
	);
	return result;
}
