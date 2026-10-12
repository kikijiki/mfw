/**
 * A fake `codex exec [resume <id>] --json -`: records argv and the prompt it
 * read from stdin, then prints the JSONL a real run prints.
 *   FAKE_CODEX_LOG=<file>   one JSON line per invocation
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const prompt = await Bun.stdin.text();
const resumeAt = argv.indexOf("resume");
const thread = resumeAt >= 0 ? (argv[resumeAt + 1] ?? "") : "thread-fresh-1";
if (process.env.FAKE_CODEX_LOG) {
	appendFileSync(
		process.env.FAKE_CODEX_LOG,
		`${JSON.stringify({ argv, prompt })}\n`,
	);
}
const out = (o: unknown) => console.log(JSON.stringify(o));
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
out({
	type: "item.completed",
	item: {
		id: "i0",
		type: "agent_message",
		text: `heard ${prompt.length} chars`,
	},
});
out({
	type: "turn.completed",
	usage: { input_tokens: 700, cached_input_tokens: 200, output_tokens: 30 },
});
