/**
 * Parsing for /service/mobile/reader/getAnnotations.
 *
 * Amazon returns `context` for a highlight as a short preview (roughly 100
 * characters) even though `start`/`end` describe the full passage, so each
 * highlight carries a `truncated` flag computed from the range length. The
 * rule and its two constants come from minholi/omakindle (MIT).
 */
import type { Annotation } from "./types";

const PREVIEW_CAP_HINT = 91;
const TRUNCATION_MISMATCH = 40;

interface RawAnnotation {
	type?: string;
	context?: string;
	note?: string | null;
	highlightColor?: string | null;
	position?: number | null;
	start?: number | null;
	end?: number | null;
	modifiedTimestamp?: number | null;
}

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export function isTruncated(
	text: string,
	start: number | null,
	end: number | null,
): boolean {
	const length = [...text].length;
	const range = start !== null && end !== null && end > start ? end - start : 0;
	return length >= PREVIEW_CAP_HINT || range - length > TRUNCATION_MISMATCH;
}

/** Highlights and notes in a getAnnotations response body. Bookmarks are skipped. */
export function parseAnnotations(body: string): Annotation[] {
	const response = JSON.parse(body) as { annotations?: RawAnnotation[] };
	const items: Annotation[] = [];
	const seen = new Set<string>();

	for (const raw of response.annotations ?? []) {
		const type = raw.type ?? "";
		if (type === "kindle.bookmark") continue;

		const text = (raw.context ?? "").trim();
		const note = raw.note?.trim() || null;
		if (!text && !note) continue;

		const kind = type === "kindle.note" ? "note" : "highlight";
		const start = num(raw.start);
		const end = num(raw.end);
		const location = num(raw.position) ?? start;

		const id = `${kind}:${start ?? location ?? "x"}:${end ?? "x"}`;
		if (seen.has(id)) continue;
		seen.add(id);

		items.push({
			id,
			kind,
			text,
			note,
			color: raw.highlightColor?.trim() || null,
			location,
			start,
			end,
			truncated: kind === "highlight" && isTruncated(text, start, end),
			modifiedAt: num(raw.modifiedTimestamp),
		});
	}
	return items;
}
