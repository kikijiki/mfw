/**
 * Test fixture: a fake stream-json agent. Reads user messages from stdin and,
 * for each, replays the `user` line back (real `claude` does this under
 * `--replay-user-messages`, which the driver always passes) before emitting
 * an `assistant` echo + a `result` event. Exits on stdin EOF — letting the
 * driver drive completion + steering without the real `claude`.
 */
export {};

const dec = new TextDecoder();
let buf = "";
for await (const bytes of Bun.stdin.stream()) {
	buf += dec.decode(bytes, { stream: true });
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		let o: { type?: string; message?: { content?: { text?: string }[] } };
		try {
			o = JSON.parse(line);
		} catch {
			nl = buf.indexOf("\n");
			continue;
		}
		if (o.type === "user") {
			const text = o.message?.content?.[0]?.text ?? "";
			// Simulates the CLI's courtesy heads-up on crossing a utilisation
			// threshold — the request goes through; this is not a refusal.
			if (text === "RATE_LIMIT_WARN") {
				process.stdout.write(
					`${JSON.stringify({
						type: "rate_limit_event",
						rate_limit_info: {
							status: "allowed_warning",
							resetsAt: 1_787_068_800,
							utilization: 0.78,
							surpassedThreshold: 0.75,
						},
					})}\n`,
				);
			}
			process.stdout.write(`${line}\n`);
			process.stdout.write(
				`${JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: `got: ${text}` }] },
				})}\n`,
			);
			process.stdout.write(
				`${JSON.stringify({
					type: "result",
					subtype: "success",
					result: `ack: ${text}`,
				})}\n`,
			);
		}
		nl = buf.indexOf("\n");
	}
}
