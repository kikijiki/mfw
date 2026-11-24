import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { SecretEnvironment } from "../src/execution-environment.ts";
import { git } from "../src/git.ts";
import { pinnedTool, resetBwrapAvailableCache } from "../src/sandbox.ts";
import {
	baseSpec,
	fakeHome,
	installCleanup,
	plant,
	savedEnv,
	usable,
} from "./support/review-fixes.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Security review wave 1 (C), X8: git, mkfifo and sh come from a trusted PATH only. */

installCleanup();

describe("X8: git, mkfifo and sh are resolved from a trusted PATH only", () => {
	test("a planted git, mkfifo and sh in a run-writable PATH entry never run", async () => {
		const { home, base, mk } = await fakeHome();
		process.env.HOME = home;
		const marker = join(home, "ran");
		for (const n of ["git", "mkfifo", "sh"])
			plant(join(home, "bin"), n, marker);
		process.env.PATH = `${join(home, "bin")}:${savedEnv.PATH}`;
		resetBwrapAvailableCache();
		expect((await git(["--version"], base)).exitCode).toBe(0);
		expect(pinnedTool("sh")).not.toContain(home);
		// mkfifo runs when a launch carries a secret.
		const why = await usable();
		if (!why) {
			const runDir = mk("run");
			const driver = join(base, "d.ts");
			writeFileSync(driver, "process.exit(0);");
			const { runner, procs } = runShTmux();
			const host = new AgentHost(undefined, { tmuxRunner: runner });
			await host.launch({
				...baseSpec(base, "x8", runDir, mk("wt")),
				driverScript: driver,
				secretEnvironment: new SecretEnvironment({ MFW_X8: "v" }),
			});
			await procs.get("mfw_x8")?.exited;
		}
		expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe("");
	}, 40_000);
});
