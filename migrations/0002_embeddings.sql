-- One row per highlight that has a vector in the Vectorize index. Kept apart
-- from `highlights` because sync rewrites that table's rows for a book on every run.
CREATE TABLE IF NOT EXISTS embeddings (
	asin TEXT NOT NULL,
	id TEXT NOT NULL,
	vector_id TEXT NOT NULL,
	-- The highlight's truncated flag and modified_at when it was embedded.
	-- A difference from the highlight means the vector is stale.
	truncated INTEGER NOT NULL,
	modified_at INTEGER,
	embedded_at INTEGER NOT NULL,
	PRIMARY KEY (asin, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_vector ON embeddings (vector_id);
