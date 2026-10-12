/**
 * A fake `claude` for brain-turn tests: records its argv and emulates the
 * session store the real CLI keeps.
 *
 *   FAKE_BRAIN_STORE=<dir>   argv.log (one JSON line per invocation),
 *                            sessions/<id>.json, plan.json, release
 *
 * - `--session-id X` creates session X; `--resume X` needs it to exist, else
 *   "No conversation found with session ID: X" on stderr and exit 1 (what the
 *   real CLI does, verified on v2.1.296).
 * - `plan.json` is a list of behaviours consumed one per invocation:
 *   "ok" (default), "die" (SIGKILL itself mid-turn), "fail" (an error result),
 *   "hold" (wait for the `release` file, then ok), "tokens:<n>" (report that
 *   many input tokens), "cost:<usd>" (add that much to the running total).
 * - Each ok turn adds $0.50 (unless `cost:`) to the conversation's running
 *   `total_cost_usd`, as a resumed conversation reports it.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const store = process.env.FAKE_BRAIN_STORE;
if (!store) throw new Error("FAKE_BRAIN_STORE is required");
mkdirSync(join(store, "sessions"), { recursive: true });

const argv = process.argv.slice(2);
const flag = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
appendFileSync(
	join(store, "argv.log"),
	`${JSON.stringify({
		argv,
		cwd: process.cwd(),
		projectDir: process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? null,
	})}\n`,
);
const invocation = readFileSync(join(store, "argv.log"), "utf8")
	.split("\n")
	.filter(Boolean).length;

const resume = flag("--resume");
const created = flag("--session-id");
const sessionFile = (id: string) => join(store, "sessions", `${id}.json`);
if (resume && !existsSync(sessionFile(resume))) {
	process.stderr.write(`No conversation found with session ID: ${resume}\n`);
	process.exit(1);
}
const sessionId = resume ?? created ?? crypto.randomUUID();
if (!existsSync(sessionFile(sessionId))) {
	writeFileSync(sessionFile(sessionId), JSON.stringify({ turns: 0, cost: 0 }));
}

const plan: string[] = existsSync(join(store, "plan.json"))
	? JSON.parse(readFileSync(join(store, "plan.json"), "utf8"))
	: [];
const behaviour = plan[invocation - 1] ?? "ok";

const stdin = Bun.stdin.stream().getReader();
async function userMessage(): Promise<string> {
	let buf = "";
	for (;;) {
		const { value, done } = await stdin.read();
		if (done) return "";
		buf += new TextDecoder().decode(value);
		const at = buf.indexOf("\n");
		if (at >= 0) {
			const m = JSON.parse(buf.slice(0, at));
			if (m.type === "user") return m.message?.content?.[0]?.text ?? "";
		}
	}
}

const text = await userMessage();
// Real claude echoes the user line under --replay-user-messages.
console.log(
	JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	}),
);

if (behaviour === "die") process.kill(process.pid, "SIGKILL");
if (behaviour === "hold") {
	const release = join(store, "release");
	const deadline = Date.now() + 60_000;
	while (!existsSync(release) && Date.now() < deadline) await Bun.sleep(50);
}
if (behaviour === "fail") {
	console.log(
		JSON.stringify({
			type: "result",
			is_error: true,
			result: "simulated provider failure",
			session_id: sessionId,
		}),
	);
	process.exit(1);
}

const state = JSON.parse(readFileSync(sessionFile(sessionId), "utf8")) as {
	turns: number;
	cost: number;
};
state.turns += 1;
state.cost += behaviour.startsWith("cost:") ? Number(behaviour.slice(5)) : 0.5;
writeFileSync(sessionFile(sessionId), JSON.stringify(state));
const inputTokens = behaviour.startsWith("tokens:")
	? Number(behaviour.slice(7))
	: 1000;

console.log(
	JSON.stringify({
		type: "assistant",
		message: {
			content: [
				{ type: "text", text: `ack ${state.turns}: ${text.length} chars` },
			],
		},
		session_id: sessionId,
	}),
);
console.log(
	JSON.stringify({
		type: "result",
		result: `done turn ${state.turns}`,
		session_id: sessionId,
		total_cost_usd: state.cost,
		num_turns: 1,
		usage: { input_tokens: inputTokens, output_tokens: 10 },
	}),
);
// stream-json -p keeps reading until the bridge closes stdin.
for (;;) {
	const { done } = await stdin.read();
	if (done) break;
}
