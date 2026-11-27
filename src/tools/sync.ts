import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Transport } from "../amazon/transport";
import { searchReady } from "../embed";
import { Store, type SyncRunRow } from "../store";
import { runSync, type SyncResult } from "../sync";

function when(ms: number | null, timeZone: string): string {
	if (!ms) return "-";
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		dateStyle: "short",
		timeStyle: "short",
		hour12: false,
	}).format(new Date(ms));
}

export function formatSyncResult(r: SyncResult): string {
	const lines = [
		`Sync ${r.status}: checked ${r.booksChecked} of ${r.librarySize} books, ${r.newHighlights} new highlights`,
	];
	if (r.changedBooks.length) {
		lines.push(`Changed: ${r.changedBooks.join("; ")}`);
	}
	if (r.commit) lines.push(`Committed to repo: ${r.commit.slice(0, 7)}`);
	if (r.indexed) lines.push(`Indexed for meaning search: ${r.indexed}`);
	if (r.errors.length) {
		lines.push("Errors:", ...r.errors.slice(0, 10).map((e) => `  ${e}`));
	}
	return lines.join("\n");
}

export function formatSyncStatus(
	runs: SyncRunRow[],
	totals: { books: number; highlights: number; indexed?: number },
	timeZone: string,
): string {
	const lines = [
		`Stored: ${totals.highlights} highlight${totals.highlights === 1 ? "" : "s"} across ${totals.books} book${totals.books === 1 ? "" : "s"}`,
	];
	if (totals.indexed !== undefined) {
		lines.push(
			`Indexed for meaning search: ${totals.indexed} of ${totals.highlights}`,
		);
	}
	if (!runs.length) return [...lines, "No sync has run yet"].join("\n");
	lines.push("Recent runs:");
	for (const run of runs) {
		let errors = 0;
		try {
			errors = (JSON.parse(run.detail ?? "{}").errors ?? []).length;
		} catch {}
		lines.push(
			`  ${when(run.started_at, timeZone)} — ${run.status}, ${run.books_checked} books checked, ${run.new_highlights} new${errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}`,
		);
	}
	const last = runs[0];
	if (last.status !== "ok" && last.detail) {
		try {
			const errors: string[] = JSON.parse(last.detail).errors ?? [];
			if (errors.length) {
				lines.push(
					"Last run errors:",
					...errors.slice(0, 5).map((e) => `  ${e}`),
				);
			}
		} catch {}
	}
	return lines.join("\n");
}

/** `transport` is passed in so this module stays free of Workers-only imports. */
export function registerSyncTools(
	server: McpServer,
	env: Env,
	transport: () => Transport,
) {
	server.tool(
		"sync_now",
		"Fetch new Kindle highlights from Amazon now instead of waiting for the daily sync",
		{
			max_books: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe(
					"How many books to check, most recently read first. Default 10",
				),
		},
		async ({ max_books }) => {
			try {
				const result = await runSync(env, {
					maxBooks: max_books ?? 10,
					transport: transport(),
				});
				return {
					content: [{ type: "text" as const, text: formatSyncResult(result) }],
					isError: result.status === "failed",
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error syncing: ${e instanceof Error ? e.message : e}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.tool(
		"sync_status",
		"Show when Kindle highlights were last synced and whether it worked",
		{},
		async () => {
			try {
				const store = new Store(env.DB);
				const { indexed, ...counts } = await store.totals();
				return {
					content: [
						{
							type: "text" as const,
							text: formatSyncStatus(
								await store.lastRuns(5),
								searchReady(env) ? { ...counts, indexed } : counts,
								env.TIMEZONE,
							),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error reading sync status: ${e instanceof Error ? e.message : e}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
