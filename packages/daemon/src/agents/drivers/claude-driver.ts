/**
 * Claude driver: runs inside the tmux session (outlives the daemon).
 *
 *   bun run claude-driver.ts <runDir>
 *
 * Reads <runDir>/driver.json = { argv, cwd, env?, model?, initialMessage,
 * steer }. Spawns the claude CLI in stream-json mode and is the single writer
 * of <runDir>/events.jsonl (each stream-json line becomes a validated
 * AgentEvent). Raw output goes to stdout (→ pane → raw.log). On each `result`
 * it drains steer.jsonl; with nothing queued after a short grace it closes
 * stdin so the agent completes one-shot.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileSink } from "bun";
import { isAllowedStatus } from "../rate-limit-claude.ts";

const runDir = process.argv[2];
if (!runDir) {
	console.error("usage: claude-driver.ts <runDir>");
	process.exit(2);
}

const cfg = JSON.parse(readFileSync(join(runDir, "driver.json"), "utf8")) as {
	argv: string[];
	cwd: string;
	env?: Record<string, string>;
	model?: string;
	initialMessage: string;
	steer?: boolean;
};
const steerPath = join(runDir, "steer.jsonl");
const eventsPath = join(runDir, "events.jsonl");

let seq = 0;
function emit(event: Record<string, unknown>): void {
	appendFileSync(
		eventsPath,
		`${JSON.stringify({ ts: new Date().toISOString(), seq: seq++, ...event })}\n`,
	);
}

const TOOL_OUTPUT_CAP = 16 * 1024;
function cap(s: string): string {
	return s.length > TOOL_OUTPUT_CAP
		? `${s.slice(0, TOOL_OUTPUT_CAP)}\n[…truncated…]`
		: s;
}

// hello: capabilities verified by this driver (it drains steer.jsonl below); the daemon copies them into runs.capabilities.
emit({
	type: "hello",
	provider: "claude-cli",
	capabilities: { steer: cfg.steer !== false },
});

const proc = Bun.spawn(cfg.argv, {
	cwd: cfg.cwd,
	env: { ...process.env, ...(cfg.env ?? {}) },
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});
const writer = proc.stdin as FileSink;

function send(text: string): void {
	writer.write(
		`${JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
		})}\n`,
	);
	writer.flush?.();
	emit({ type: "message", role: "user", text });
}

let steerOffset = 0;
function drainSteer(): string[] {
	try {
		const buf = readFileSync(steerPath, "utf8");
		if (buf.length <= steerOffset) return [];
		const fresh = buf.slice(steerOffset);
		steerOffset = buf.length;
		return fresh
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => {
				try {
					return JSON.parse(s) as string;
				} catch {
					return s;
				}
			});
	} catch {
		return [];
	}
}

let lastResultText: string | undefined;
let sawFatalError = false;
let closing: ReturnType<typeof setTimeout> | null = null;

function onResult(): void {
	if (cfg.steer === false) {
		try {
			void writer.end();
		} catch {
			/* already closed */
		}
		return;
	}
	const steers = drainSteer();
	if (steers.length) {
		for (const s of steers) send(s);
		return;
	}
	if (closing) clearTimeout(closing);
	closing = setTimeout(() => {
		const late = drainSteer();
		if (late.length) {
			for (const s of late) send(s);
		} else {
			try {
				void writer.end();
			} catch {
				/* already closed */
			}
		}
	}, 1500);
}

/** Translate one claude stream-json object into AgentEvents. */
function translate(o: Record<string, unknown>): void {
	const type = o.type as string | undefined;
	if (type === "assistant" || type === "user") {
		const message = (o.message ?? {}) as {
			content?: { type?: string; [k: string]: unknown }[];
		};
		for (const part of message.content ?? []) {
			if (part.type === "text" && typeof part.text === "string") {
				// `--replay-user-messages` echoes back exactly what `send()` just
				// wrote to stdin; `send()` already emitted this text once, so a
				// user-role echo here would double it in the transcript. An
				// assistant text part is never an echo and always new.
				if (type === "assistant") {
					emit({ type: "message", role: "assistant", text: part.text });
				}
			} else if (
				part.type === "thinking" &&
				typeof part.thinking === "string"
			) {
				// Skip empty ones: in `--print --output-format stream-json` the CLI emits a
				// thinking block per turn with a `signature` and an empty `thinking` string
				// (reasoning is not streamed), which would fill the transcript with empty rows.
				if (part.thinking.trim())
					emit({ type: "thinking", text: part.thinking });
			} else if (part.type === "tool_use") {
				emit({
					type: "tool_call",
					id: String(part.id ?? ""),
					name: String(part.name ?? "tool"),
					input: part.input,
				});
			} else if (part.type === "tool_result") {
				const content = part.content;
				const text = Array.isArray(content)
					? content
							.map((c) =>
								typeof (c as { text?: unknown }).text === "string"
									? (c as { text: string }).text
									: "",
							)
							.join("\n")
					: typeof content === "string"
						? content
						: JSON.stringify(content ?? "");
				emit({
					type: "tool_result",
					id: String(part.tool_use_id ?? ""),
					ok: part.is_error !== true,
					output: cap(text),
				});
			}
		}
	} else if (type === "result") {
		if (typeof o.result === "string") lastResultText = o.result;
		const u = (o.usage ?? {}) as Record<string, unknown>;
		emit({
			type: "usage",
			inputTokens: num(u.input_tokens),
			outputTokens: num(u.output_tokens),
			costUsd: num(o.total_cost_usd),
			turns: num(o.num_turns),
		});
		if (o.is_error === true) {
			sawFatalError = true;
			emit({
				type: "error",
				message: typeof o.result === "string" ? o.result : "agent error",
				fatal: true,
			});
		}
		onResult();
	} else if (type === "rate_limit_event") {
		const info = (o.rate_limit_info ?? o.rate_limit ?? {}) as Record<
			string,
			unknown
		>;
		const status = String(info.status ?? "unknown");
		emit({
			type: "rate_limit",
			status,
			// Resolved here, where vendor vocabulary ("allowed_warning" is not a refusal) is known.
			// Downstream reads only this boolean, so an unseen future status cannot misclassify a run.
			limited: !isAllowedStatus(status),
			resetsAt: num(info.resetsAt ?? info.resets_at) ?? null,
			utilization: num(info.utilization) ?? null,
		});
	}
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// stderr → our stderr (→ pane → raw.log)
void (async () => {
	for await (const b of proc.stderr) process.stderr.write(b);
})();

send(cfg.initialMessage);

const dec = new TextDecoder();
let buf = "";
for await (const bytes of proc.stdout) {
	process.stdout.write(bytes); // raw passthrough → pane → raw.log
	buf += dec.decode(bytes, { stream: true });
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (line.startsWith("{")) {
			try {
				translate(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// non-json or torn line, raw.log keeps it for debugging
			}
		}
		nl = buf.indexOf("\n");
	}
}

const code = await proc.exited;
emit({
	type: "done",
	reason: code === 0 && !sawFatalError ? "complete" : "error",
	resultText: lastResultText,
});
process.exit(code ?? 0);
