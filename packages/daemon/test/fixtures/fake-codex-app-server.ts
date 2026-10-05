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
		if (m.method === "initialize")
			console.log(JSON.stringify({ id: m.id, result: {} }));
		else if (m.method === "thread/start")
			console.log(
				JSON.stringify({ id: m.id, result: { thread: { id: "thread-1" } } }),
			);
		else if (m.method === "turn/start") {
			if (m.params?.effort !== "high") {
				console.log(
					JSON.stringify({
						id: m.id,
						error: { code: "BAD_EFFORT", message: "expected high effort" },
					}),
				);
				continue;
			}
			console.log(
				JSON.stringify({ id: m.id, result: { turn: { id: "turn-1" } } }),
			);
			for (let i = 0; i < 2; i++) {
				console.log(
					JSON.stringify({
						method: "account/rateLimits/updated",
						params: {
							rateLimits: {
								primary: { usedPercent: 42, resetsAt: 1_800_000_000 },
							},
						},
					}),
				);
			}
			console.log(
				JSON.stringify({
					method: "turn/started",
					params: { turn: { id: "turn-1", ordinal: 1 } },
				}),
			);
			console.log(
				JSON.stringify({
					method: "thread/status/changed",
					params: { threadId: "thread-1", status: { type: "active" } },
				}),
			);
			console.log(
				JSON.stringify({
					method: "item/completed",
					params: { item: { id: "user-1", type: "userMessage" } },
				}),
			);
			console.log(
				JSON.stringify({
					method: "item/started",
					params: {
						item: { id: "cmd-1", type: "commandExecution", command: "pwd" },
					},
				}),
			);
			console.log(
				JSON.stringify({
					method: "item/commandExecution/outputDelta",
					params: { itemId: "cmd-1", delta: "/tmp\n" },
				}),
			);
			console.log(
				JSON.stringify({
					method: "item/completed",
					params: {
						item: {
							id: "cmd-1",
							type: "commandExecution",
							status: "completed",
							exitCode: 0,
							aggregatedOutput: "/tmp\n",
						},
					},
				}),
			);
			console.log(
				JSON.stringify({
					method: "item/completed",
					params: { item: { id: "msg-1", type: "agentMessage", text: "done" } },
				}),
			);
			console.log(
				JSON.stringify({
					method: "turn/completed",
					params: { turn: { id: "turn-1", status: "completed" } },
				}),
			);
		} else if (m.method === "turn/steer")
			console.log(
				JSON.stringify({ id: m.id, result: { turn: { id: "turn-1" } } }),
			);
	}
}
