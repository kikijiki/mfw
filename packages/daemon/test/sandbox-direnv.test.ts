import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { resetBwrapAvailableCache } from "../src/sandbox.ts";
import {
	baseSpec,
	fakeHome,
	installCleanup,
	savedEnv,
	usable,
	waitFor,
} from "./support/review-fixes.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Security review wave 1 (C), X14: direnv trust never persists into the real HOME. */

installCleanup();

describe("X14: direnv trust never persists into the real HOME", () => {
	test("the gate records trust in a throwaway data dir", async () => {
		const why = await usable();
		if (why) return console.log(`skip: ${why}`);
		const { base, mk } = await fakeHome();
		const cwd = mk("wt");
		// A HOME the sandbox can see (the worktree is bound), so a trust record written there is observable.
		const home = join(cwd, "home");
		mkdirSync(home);
		process.env.HOME = home;
		// What the real environment would hand the sandbox: the user's data dir, here a fake one.
		process.env.XDG_DATA_HOME = join(home, ".local/share");
		mkdirSync(join(cwd, "bin"));
		const fake = join(cwd, "bin", "direnv");
		writeFileSync(
			fake,
			`#!/bin/sh
case "$1" in
  allow) d="\${XDG_DATA_HOME:-$HOME/.local/share}/direnv/allow"; mkdir -p "$d"; : > "$d/trusted" ;;
  export) echo "export FROM_DIRENV=1" ;;
esac
`,
		);
		chmodSync(fake, 0o755);
		// No real direnv may shadow the stand-in.
		const withoutDirenv = (savedEnv.PATH ?? "")
			.split(":")
			.filter((d) => !existsSync(join(d, "direnv")))
			.join(":");
		process.env.PATH = `${withoutDirenv}:${join(cwd, "bin")}`;
		resetBwrapAvailableCache();
		// The primary checkout's .envrc must be visible inside the sandbox: keep it under the bound worktree.
		const root = join(cwd, "primary");
		mkdirSync(root);
		writeFileSync(join(root, ".envrc"), "layout node\n");
		writeFileSync(join(cwd, ".envrc"), "layout node\n");
		const runDir = mk("run");
		const driver = join(base, "d.ts");
		writeFileSync(
			driver,
			`require("node:fs").writeFileSync(${JSON.stringify(join(runDir, "outbox", "env.txt"))}, String(process.env.FROM_DIRENV));`,
		);
		const { runner, procs } = runShTmux(
			{},
			{ HOME: home, XDG_DATA_HOME: join(home, ".local/share") },
		);
		const host = new AgentHost(undefined, { tmuxRunner: runner });
		await host.launch({
			...baseSpec(base, "x14", runDir, cwd),
			projectRoot: root,
			driverScript: driver,
		});
		await procs.get("mfw_x14")?.exited;
		expect(
			await waitFor(() => existsSync(join(runDir, "outbox", "env.txt"))),
		).toBe(true);
		// direnv's exports still reach the driver, but its trust record is not in HOME.
		expect(await readFile(join(runDir, "outbox", "env.txt"), "utf8")).toBe("1");
		expect(existsSync(join(home, ".local/share/direnv/allow/trusted"))).toBe(
			false,
		);
	}, 40_000);
});
