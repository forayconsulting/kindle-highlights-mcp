/// <reference types="node" />
/**
 * A D1Database stand-in over node:sqlite, so Store's SQL and the sync job
 * run for real in tests. Covers only what Store uses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Params = (string | number | null)[];

export function createD1(): D1Database {
	const db = new DatabaseSync(":memory:");
	const migrations = new URL("../../migrations/", import.meta.url);
	for (const file of readdirSync(migrations).sort()) {
		if (file.endsWith(".sql")) {
			db.exec(readFileSync(new URL(file, migrations), "utf8"));
		}
	}

	const statement = (sql: string, params: Params = []) => ({
		bind: (...values: Params) => statement(sql, values),
		async first() {
			return db.prepare(sql).get(...params) ?? null;
		},
		async all() {
			return { results: db.prepare(sql).all(...params) };
		},
		async run() {
			const info = db.prepare(sql).run(...params);
			return { meta: { last_row_id: Number(info.lastInsertRowid) } };
		},
	});

	return {
		prepare: (sql: string) => statement(sql),
		async batch(statements: { run(): Promise<unknown> }[]) {
			db.exec("BEGIN");
			try {
				const out = [];
				for (const s of statements) out.push(await s.run());
				db.exec("COMMIT");
				return out;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

export function createKV(): KVNamespace {
	const data = new Map<string, string>();
	return {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			data.set(key, value);
		},
		delete: async (key: string) => {
			data.delete(key);
		},
	} as unknown as KVNamespace;
}
