import { readFile } from "node:fs/promises";
import { parseAgentEventLine } from "./agents/events.ts";

/**
 * What survives of a run once its transcript directory is garbage collected:
 * enough for the inspector to say what happened without the entries. Written
 * to `runs.transcript_summary` by gc BEFORE the directory is removed.
 */
export interface TranscriptSummary {
	/** Last assistant message, truncated to 2 KiB. */
	lastAssistant: string | null;
	/** Tool calls by tool name. */
	toolCalls: Record<string, number>;
	/** Distinct paths the run changed or edited (bounded). */
	filesTouched: string[];
	/** The first error event's message, if any. */
	firstError: string | null;
	/** Transcript lines that parsed as events. */
	events: number;
	/** Epoch ms the transcript was pruned. */
	prunedAt: number;
}

export const LAST_MESSAGE_BYTES = 2048;
const MAX_FILES = 100;

/** Truncate to `bytes` UTF-8 bytes without splitting a code point. */
function clipUtf8(text: string, bytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= bytes) return text;
	let end = bytes;
	// back off to a code point boundary (continuation bytes are 10xxxxxx)
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

function pathOf(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const o = input as Record<string, unknown>;
	for (const k of ["file_path", "path", "filePath", "notebook_path"]) {
		if (typeof o[k] === "string" && o[k]) return o[k] as string;
	}
	return null;
}

/** Fold an `events.jsonl` body into its summary. Pure; torn or foreign lines are skipped. */
export function summarizeTranscriptText(
	text: string,
	prunedAt = Date.now(),
): TranscriptSummary {
	const toolCalls: Record<string, number> = {};
	const files = new Set<string>();
	let lastAssistant: string | null = null;
	let firstError: string | null = null;
	let events = 0;
	for (const line of text.split("\n")) {
		const e = parseAgentEventLine(line);
		if (!e) continue;
		events++;
		switch (e.type) {
			case "message":
				if (e.role === "assistant") lastAssistant = e.text;
				break;
			case "tool_call": {
				toolCalls[e.name] = (toolCalls[e.name] ?? 0) + 1;
				const p = pathOf(e.input);
				if (
					p &&
					/^(edit|write|multiedit|notebookedit|str_replace)/i.test(e.name)
				)
					files.add(p);
				break;
			}
			case "file_change":
				for (const c of e.changes) files.add(c.path);
				break;
			case "error":
				firstError ??= e.message;
				break;
			default:
				break;
		}
	}
	return {
		lastAssistant:
			lastAssistant === null
				? null
				: clipUtf8(lastAssistant, LAST_MESSAGE_BYTES),
		toolCalls,
		filesTouched: [...files].sort().slice(0, MAX_FILES),
		firstError,
		events,
		prunedAt,
	};
}

/** Summarize the transcript file; a missing file reads as an empty one. */
export async function summarizeTranscript(
	eventsPath: string,
	prunedAt = Date.now(),
): Promise<TranscriptSummary> {
	let text = "";
	try {
		text = await readFile(eventsPath, "utf8");
	} catch {
		// no transcript: the summary then says so with zero events
	}
	return summarizeTranscriptText(text, prunedAt);
}
