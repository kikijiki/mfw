import { describe, expect, test } from "bun:test";
import {
	LAST_MESSAGE_BYTES,
	summarizeTranscriptText,
} from "../src/transcript-summary.ts";

const line = (o: Record<string, unknown>, seq: number) =>
	JSON.stringify({ ts: "2026-01-01T00:00:00Z", seq, ...o });

describe("summarizeTranscriptText", () => {
	test("keeps the last assistant message, tool counts, files, first error", () => {
		const text = [
			line({ type: "message", role: "assistant", text: "first" }, 1),
			line({ type: "message", role: "user", text: "steer" }, 2),
			line({ type: "tool_call", id: "a", name: "Bash", input: {} }, 3),
			line({ type: "tool_call", id: "b", name: "Bash", input: {} }, 4),
			line(
				{
					type: "tool_call",
					id: "c",
					name: "Write",
					input: { file_path: "z.ts" },
				},
				5,
			),
			line(
				{
					type: "file_change",
					id: "d",
					phase: "completed",
					changes: [{ path: "a.ts", kind: "update" }],
				},
				6,
			),
			line({ type: "error", message: "one", fatal: false }, 7),
			line({ type: "error", message: "two", fatal: true }, 8),
			line({ type: "message", role: "assistant", text: "final" }, 9),
			"{torn line",
		].join("\n");
		expect(summarizeTranscriptText(text, 42)).toEqual({
			lastAssistant: "final",
			toolCalls: { Bash: 2, Write: 1 },
			filesTouched: ["a.ts", "z.ts"],
			firstError: "one",
			events: 9,
			prunedAt: 42,
		});
	});

	test("truncates the last message to 2 KiB on a code point boundary", () => {
		const long = "é".repeat(LAST_MESSAGE_BYTES); // 2 bytes each
		const s = summarizeTranscriptText(
			line({ type: "message", role: "assistant", text: long }, 1),
		);
		const out = s.lastAssistant as string;
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LAST_MESSAGE_BYTES);
		expect(out).toBe("é".repeat(LAST_MESSAGE_BYTES / 2));
	});

	test("an empty transcript summarizes to nothing", () => {
		expect(summarizeTranscriptText("", 1)).toEqual({
			lastAssistant: null,
			toolCalls: {},
			filesTouched: [],
			firstError: null,
			events: 0,
			prunedAt: 1,
		});
	});
});
