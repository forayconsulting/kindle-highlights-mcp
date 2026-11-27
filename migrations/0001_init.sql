CREATE TABLE IF NOT EXISTS books (
	asin TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	authors TEXT NOT NULL DEFAULT '',
	cover_url TEXT NOT NULL DEFAULT '',
	slug TEXT NOT NULL,
	highlight_count INTEGER NOT NULL DEFAULT 0,
	-- 1 when the book's file in the repo is behind the database
	dirty INTEGER NOT NULL DEFAULT 0,
	last_synced_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS books_slug ON books (slug);

CREATE TABLE IF NOT EXISTS highlights (
	asin TEXT NOT NULL,
	id TEXT NOT NULL,
	kind TEXT NOT NULL,
	text TEXT NOT NULL DEFAULT '',
	note TEXT,
	color TEXT,
	location INTEGER,
	start_pos INTEGER,
	end_pos INTEGER,
	truncated INTEGER NOT NULL DEFAULT 0,
	modified_at INTEGER,
	first_seen_at INTEGER NOT NULL,
	PRIMARY KEY (asin, id)
);
CREATE INDEX IF NOT EXISTS highlights_first_seen ON highlights (first_seen_at);

CREATE TABLE IF NOT EXISTS sync_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	status TEXT NOT NULL,
	books_checked INTEGER NOT NULL DEFAULT 0,
	new_highlights INTEGER NOT NULL DEFAULT 0,
	detail TEXT
);
