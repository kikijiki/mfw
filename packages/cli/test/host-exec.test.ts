import { describe, expect, test } from "bun:test";
import { SANDBOX_PATHS } from "../../daemon/src/containment/compile-bwrap.ts";
import {
	HOST_CONTENT_IDS,
	HOST_ENTRY_IDS,
	type HostEntryId,
} from "../../daemon/src/containment/host-script.ts";
import {
	ALLOWED_CHILDREN,
	HOST_ENTRY_ENV,
	HOST_ENTRY_MODULES,
	type HostExecContext,
	hostExecRefusal,
	runHostEntry,
	runtimeOptionProblem,
	SANDBOX_MARKERS,
} from "../src/host-exec.ts";

function ctx(over: Partial<HostExecContext> = {}): HostExecContext {
	return {
		compiled: true,
		env: {},
		execArgv: [],
		isDir: () => false,
		...over,
	};
}

describe("mfw __host refusals", () => {
	test("only a compiled mfw runs host entries", () => {
		expect(
			hostExecRefusal(["agent-launcher"], ctx({ compiled: false })),
		).toContain("internal to a compiled mfw");
		expect(hostExecRefusal(["agent-launcher"], ctx())).toBeNull();
	});

	test("an unknown id, or an entry asked for as content, is refused", () => {
		expect(hostExecRefusal([], ctx())).toContain("has no entry");
		expect(hostExecRefusal(["sh"], ctx())).toContain("has no entry 'sh'");
		expect(hostExecRefusal(["egress-relay"], ctx())).toContain("has no entry");
		expect(hostExecRefusal(["emit", "agent-launcher"], ctx())).toContain(
			"has no content",
		);
		for (const id of HOST_CONTENT_IDS) {
			expect(hostExecRefusal(["emit", id], ctx())).toBeNull();
		}
	});

	test("bun runtime options are refused: they would load code into mfw", () => {
		for (const env of [
			{ BUN_OPTIONS: "--preload ./x.ts" },
			{ BUN_BE_BUN: "1" },
		]) {
			expect(hostExecRefusal(["egress-proxy"], ctx({ env }))).toContain(
				"refusing",
			);
		}
		expect(
			hostExecRefusal(["egress-proxy"], ctx({ execArgv: ["--smol"] })),
		).toContain("bun was given options");
		expect(runtimeOptionProblem({}, [])).toBeNull();
	});

	test("inside an mfw sandbox every entry and emit is refused", () => {
		const inSandbox = ctx({ isDir: (p) => p === SANDBOX_PATHS.home });
		for (const id of HOST_ENTRY_IDS) {
			expect(hostExecRefusal([id], inSandbox)).toContain(
				"inside an mfw sandbox",
			);
		}
		expect(hostExecRefusal(["emit", "mcp-main"], inSandbox)).toContain(
			"inside an mfw sandbox",
		);
	});

	test("the sandbox marker is the sandbox's home mount point", () => {
		expect(SANDBOX_MARKERS).toContain(SANDBOX_PATHS.home);
	});

	test("a child never re-execs through the launcher again", () => {
		const from = (parent: string) => ctx({ env: { [HOST_ENTRY_ENV]: parent } });
		for (const id of HOST_ENTRY_IDS) {
			expect(hostExecRefusal([id], from("agent-launcher"))).toContain(
				"never re-execs through the launcher",
			);
		}
		expect(ALLOWED_CHILDREN["agent-launcher"]).toBeUndefined();
	});

	test("only the driver-to-bridge and to-launcher edges are allowed", () => {
		const allowed: [HostEntryId, HostEntryId][] = [];
		for (const parent of HOST_ENTRY_IDS) {
			for (const child of HOST_ENTRY_IDS) {
				const env = { [HOST_ENTRY_ENV]: parent };
				if (hostExecRefusal([child], ctx({ env })) === null) {
					allowed.push([parent, child]);
				}
			}
		}
		expect(allowed.sort()).toEqual(
			(
				[
					["acp-bridge", "agent-launcher"],
					["app-server-driver", "acp-bridge"],
					["app-server-driver", "agent-launcher"],
					["app-server-driver", "claude-bridge"],
					["app-server-driver", "codex-bridge"],
					["app-server-driver", "codex-exec-bridge"],
					["claude-bridge", "agent-launcher"],
					["codex-bridge", "agent-launcher"],
					["codex-exec-bridge", "agent-launcher"],
				] as [HostEntryId, HostEntryId][]
			).sort(),
		);
		// An unknown parent value allows nothing.
		expect(
			hostExecRefusal(
				["agent-launcher"],
				ctx({ env: { [HOST_ENTRY_ENV]: "x" } }),
			),
		).toContain("from inside x");
	});

	test("every entry id has a module", () => {
		expect(Object.keys(HOST_ENTRY_MODULES).sort()).toEqual(
			[...HOST_ENTRY_IDS].sort(),
		);
	});
});

describe("runHostEntry", () => {
	test("a refusal exits 78 and runs nothing", async () => {
		const err: string[] = [];
		const code = await runHostEntry(["agent-launcher"], {
			ctx: ctx({ compiled: false }),
			err: (l) => err.push(l),
			write: () => {
				throw new Error("wrote");
			},
			content: () => "",
		});
		expect(code).toBe(78);
		expect(err.join("\n")).toContain("mfw: ");
	});

	test("emit writes the embedded content and exits 0", async () => {
		const out: string[] = [];
		const code = await runHostEntry(["emit", "wip-helper"], {
			ctx: ctx(),
			err: () => {},
			write: (t) => out.push(t),
			content: (id) => `content of ${id}`,
		});
		expect(code).toBe(0);
		expect(out).toEqual(["content of wip-helper"]);
	});
});
