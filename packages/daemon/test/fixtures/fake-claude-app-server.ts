export {};

let buf = "";
for await (const bytes of Bun.stdin.stream()) {
	buf += new TextDecoder().decode(bytes);
	let at = buf.indexOf("\n");
	while (at >= 0) {
		const line = buf.slice(0, at).trim();
		buf = buf.slice(at + 1);
		at = buf.indexOf("\n");
		if (!line) continue;
		const m = JSON.parse(line);
		if (m.type === "user") {
			const text = m.message?.content?.[0]?.text;
			// Real `claude` echoes the user line back under --replay-user-messages,
			// which the bridge always passes.
			console.log(line);
			console.log(
				JSON.stringify({
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: text === "WAIT_FOR_INTERRUPT" ? "waiting" : "hello",
							},
							{
								type: "tool_use",
								id: "t1",
								name: "Read",
								input: { path: "x" },
							},
						],
					},
				}),
			);
			// Keep the turn active until the compatibility bridge sends SIGINT.
			// This lets the driver integration test exercise the real interrupt path.
			if (text === "WAIT_FOR_INTERRUPT") continue;
			console.log(
				JSON.stringify({
					type: "result",
					result: "hello",
					usage: { input_tokens: 2, output_tokens: 3 },
					num_turns: 1,
				}),
			);
		}
	}
}
