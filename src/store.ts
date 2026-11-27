import type { Book } from "./amazon/types";

export interface BookRow {
	asin: string;
	title: string;
	authors: string;
	cover_url: string;
	slug: string;
	highlight_count: number;
	dirty: number;
	last_synced_at: number | null;
}

export interface HighlightRow {
	asin: string;
	id: string;
	kind: string;
	text: string;
	note: string | null;
	color: string | null;
	location: number | null;
	start_pos: number | null;
	end_pos: number | null;
	truncated: number;
	modified_at: number | null;
	first_seen_at: number;
}

export interface SyncRunRow {
	id: number;
	started_at: number;
	finished_at: number | null;
	status: string;
	books_checked: number;
	new_highlights: number;
	detail: string | null;
}

export type HighlightWithBook = HighlightRow & {
	title: string;
	authors: string;
};

export type ScoredHighlight = HighlightWithBook & { score: number };

export interface EmbeddingRef {
	asin: string;
	id: string;
	vector_id: string;
}

const WITH_BOOK =
	"SELECT h.*, b.title, b.authors FROM highlights h JOIN books b ON b.asin = h.asin";

export class Store {
	constructor(private readonly db: D1Database) {}

	async book(asin: string): Promise<BookRow | null> {
		return this.db
			.prepare("SELECT * FROM books WHERE asin = ?")
			.bind(asin)
			.first<BookRow>();
	}

	async slugOwner(slug: string): Promise<string | null> {
		const row = await this.db
			.prepare("SELECT asin FROM books WHERE slug = ?")
			.bind(slug)
			.first<{ asin: string }>();
		return row?.asin ?? null;
	}

	/** Books that have at least one highlight, most recently synced first. */
	async booksWithHighlights(): Promise<BookRow[]> {
		const { results } = await this.db
			.prepare(
				"SELECT * FROM books WHERE highlight_count > 0 ORDER BY last_synced_at DESC, title",
			)
			.all<BookRow>();
		return results;
	}

	/** Match by ASIN, or by a case-insensitive part of the title. */
	async findBooks(query: string): Promise<BookRow[]> {
		const { results } = await this.db
			.prepare(
				"SELECT * FROM books WHERE asin = ?1 OR title LIKE '%' || ?1 || '%' ORDER BY highlight_count DESC LIMIT 10",
			)
			.bind(query.trim())
			.all<BookRow>();
		return results;
	}

	async dirtyBooks(): Promise<BookRow[]> {
		const { results } = await this.db
			.prepare("SELECT * FROM books WHERE dirty = 1")
			.all<BookRow>();
		return results;
	}

	async clearDirty(asins: string[]): Promise<void> {
		if (asins.length === 0) return;
		await this.db.batch(
			asins.map((asin) =>
				this.db.prepare("UPDATE books SET dirty = 0 WHERE asin = ?").bind(asin),
			),
		);
	}

	async highlights(asin: string): Promise<HighlightRow[]> {
		const { results } = await this.db
			.prepare(
				"SELECT * FROM highlights WHERE asin = ? ORDER BY COALESCE(start_pos, location, 0), id",
			)
			.bind(asin)
			.all<HighlightRow>();
		return results;
	}

	async search(query: string, limit: number): Promise<HighlightWithBook[]> {
		const { results } = await this.db
			.prepare(
				`SELECT h.*, b.title, b.authors FROM highlights h JOIN books b ON b.asin = h.asin
				 WHERE h.text LIKE '%' || ?1 || '%' OR h.note LIKE '%' || ?1 || '%'
				 ORDER BY h.first_seen_at DESC LIMIT ?2`,
			)
			.bind(query.trim(), limit)
			.all<HighlightWithBook>();
		return results;
	}

	/** Highlights by when they were made (falling back to when sync first saw them). */
	async recent(sinceMs: number, limit: number): Promise<HighlightWithBook[]> {
		const { results } = await this.db
			.prepare(
				`SELECT h.*, b.title, b.authors FROM highlights h JOIN books b ON b.asin = h.asin
				 WHERE COALESCE(h.modified_at, h.first_seen_at) >= ?1
				 ORDER BY COALESCE(h.modified_at, h.first_seen_at) DESC LIMIT ?2`,
			)
			.bind(sinceMs, limit)
			.all<HighlightWithBook>();
		return results;
	}

	/**
	 * Replace a book's highlights with `rows` and update the book. `changed`
	 * marks its repo file as needing a rewrite.
	 */
	async saveBook(
		book: Book,
		slug: string,
		rows: HighlightRow[],
		changed: boolean,
		now: number,
	): Promise<void> {
		const statements: D1PreparedStatement[] = [
			this.db
				.prepare(
					`INSERT INTO books (asin, title, authors, cover_url, slug, highlight_count, dirty, last_synced_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
					 ON CONFLICT (asin) DO UPDATE SET title = ?2, authors = ?3, cover_url = ?4,
					   highlight_count = ?6, dirty = MAX(dirty, ?7), last_synced_at = ?8`,
				)
				.bind(
					book.asin,
					book.title,
					book.authors.join(", "),
					book.coverUrl,
					slug,
					rows.length,
					changed ? 1 : 0,
					now,
				),
			this.db.prepare("DELETE FROM highlights WHERE asin = ?").bind(book.asin),
		];
		for (const r of rows) {
			statements.push(
				this.db
					.prepare(
						`INSERT INTO highlights (asin, id, kind, text, note, color, location, start_pos, end_pos, truncated, modified_at, first_seen_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						r.asin,
						r.id,
						r.kind,
						r.text,
						r.note,
						r.color,
						r.location,
						r.start_pos,
						r.end_pos,
						r.truncated,
						r.modified_at,
						r.first_seen_at,
					),
			);
		}
		await this.db.batch(statements);
	}

	async startRun(now: number): Promise<number> {
		const result = await this.db
			.prepare(
				"INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')",
			)
			.bind(now)
			.run();
		return result.meta.last_row_id;
	}

	async finishRun(
		id: number,
		now: number,
		status: string,
		booksChecked: number,
		newHighlights: number,
		detail: string,
	): Promise<void> {
		await this.db
			.prepare(
				"UPDATE sync_runs SET finished_at = ?, status = ?, books_checked = ?, new_highlights = ?, detail = ? WHERE id = ?",
			)
			.bind(now, status, booksChecked, newHighlights, detail, id)
			.run();
	}

	async lastRuns(limit: number): Promise<SyncRunRow[]> {
		const { results } = await this.db
			.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?")
			.bind(limit)
			.all<SyncRunRow>();
		return results;
	}

	async totals(): Promise<{
		books: number;
		highlights: number;
		indexed: number;
	}> {
		const row = await this.db
			.prepare(
				`SELECT (SELECT COUNT(*) FROM books WHERE highlight_count > 0) AS books,
				 (SELECT COUNT(*) FROM highlights) AS highlights,
				 (SELECT COUNT(*) FROM embeddings) AS indexed`,
			)
			.first<{ books: number; highlights: number; indexed: number }>();
		return row ?? { books: 0, highlights: 0, indexed: 0 };
	}

	/** Highlights with no vector yet, or whose vector was made from older text. */
	async pendingEmbeddings(limit: number): Promise<HighlightRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT h.* FROM highlights h
				 LEFT JOIN embeddings e ON e.asin = h.asin AND e.id = h.id
				 WHERE (h.text <> '' OR COALESCE(h.note, '') <> '')
				   AND (e.id IS NULL OR e.truncated <> h.truncated OR e.modified_at IS NOT h.modified_at)
				 ORDER BY h.asin, h.id LIMIT ?`,
			)
			.bind(limit)
			.all<HighlightRow>();
		return results;
	}

	async pendingEmbeddingCount(): Promise<number> {
		const row = await this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM highlights h
				 LEFT JOIN embeddings e ON e.asin = h.asin AND e.id = h.id
				 WHERE (h.text <> '' OR COALESCE(h.note, '') <> '')
				   AND (e.id IS NULL OR e.truncated <> h.truncated OR e.modified_at IS NOT h.modified_at)`,
			)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	/** Vectors whose highlight no longer exists. */
	async orphanEmbeddings(limit: number): Promise<EmbeddingRef[]> {
		const { results } = await this.db
			.prepare(
				`SELECT e.asin, e.id, e.vector_id FROM embeddings e
				 LEFT JOIN highlights h ON h.asin = e.asin AND h.id = e.id
				 WHERE h.id IS NULL LIMIT ?`,
			)
			.bind(limit)
			.all<EmbeddingRef>();
		return results;
	}

	async markEmbedded(
		rows: { row: HighlightRow; vectorId: string }[],
		now: number,
	): Promise<void> {
		if (rows.length === 0) return;
		await this.db.batch(
			rows.map(({ row, vectorId }) =>
				this.db
					.prepare(
						`INSERT INTO embeddings (asin, id, vector_id, truncated, modified_at, embedded_at)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
						 ON CONFLICT (asin, id) DO UPDATE SET vector_id = ?3, truncated = ?4, modified_at = ?5, embedded_at = ?6`,
					)
					.bind(
						row.asin,
						row.id,
						vectorId,
						row.truncated,
						row.modified_at,
						now,
					),
			),
		);
	}

	async dropEmbeddings(refs: EmbeddingRef[]): Promise<void> {
		if (refs.length === 0) return;
		await this.db.batch(
			refs.map((r) =>
				this.db
					.prepare("DELETE FROM embeddings WHERE asin = ? AND id = ?")
					.bind(r.asin, r.id),
			),
		);
	}

	/** Highlights for the given vector ids, in the order given, with their scores. */
	async highlightsByVector(
		matches: { id: string; score: number }[],
	): Promise<ScoredHighlight[]> {
		if (matches.length === 0) return [];
		const marks = matches.map(() => "?").join(", ");
		const { results } = await this.db
			.prepare(
				`SELECT h.*, b.title, b.authors, e.vector_id FROM embeddings e
				 JOIN highlights h ON h.asin = e.asin AND h.id = e.id
				 JOIN books b ON b.asin = h.asin
				 WHERE e.vector_id IN (${marks})`,
			)
			.bind(...matches.map((m) => m.id))
			.all<HighlightWithBook & { vector_id: string }>();
		const byVector = new Map(results.map((r) => [r.vector_id, r]));
		const out: ScoredHighlight[] = [];
		for (const match of matches) {
			const found = byVector.get(match.id);
			if (!found) continue;
			const { vector_id: _vector, ...row } = found;
			out.push({ ...row, score: match.score });
		}
		return out;
	}

	/** Every highlight with its book, or one book's, in reading order. */
	async highlightsWithBook(asin?: string): Promise<HighlightWithBook[]> {
		const order =
			"ORDER BY b.title, COALESCE(h.start_pos, h.location, 0), h.id";
		const statement = asin
			? this.db.prepare(`${WITH_BOOK} WHERE h.asin = ? ${order}`).bind(asin)
			: this.db.prepare(`${WITH_BOOK} ${order}`);
		const { results } = await statement.all<HighlightWithBook>();
		return results;
	}

	/** Full-text highlights picked at random. */
	async randomHighlights(limit: number): Promise<HighlightWithBook[]> {
		const { results } = await this.db
			.prepare(
				`${WITH_BOOK} WHERE h.text <> '' AND h.truncated = 0 ORDER BY RANDOM() LIMIT ?`,
			)
			.bind(limit)
			.all<HighlightWithBook>();
		return results;
	}

	/**
	 * Highlights made on this month and day in an earlier year. `monthDay` is
	 * "MM-DD" and `year` is "YYYY", both in the reader's time zone, and
	 * `offsetMinutes` is that zone's offset from UTC.
	 */
	async onThisDay(
		monthDay: string,
		year: string,
		offsetMinutes: number,
		limit: number,
	): Promise<HighlightWithBook[]> {
		const local = "h.modified_at / 1000 + ?1 * 60, 'unixepoch'";
		const { results } = await this.db
			.prepare(
				`${WITH_BOOK} WHERE h.modified_at IS NOT NULL
				   AND strftime('%m-%d', ${local}) = ?2
				   AND strftime('%Y', ${local}) < ?3
				 ORDER BY h.modified_at DESC LIMIT ?4`,
			)
			.bind(offsetMinutes, monthDay, year, limit)
			.all<HighlightWithBook>();
		return results;
	}
}
