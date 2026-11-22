import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/boot.ts";
import { brainSocketFor } from "../src/brain-runtime/brain-socket.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const p of paths.splice(0))
		await rm(p, { recursive: true, force: true });
});

test("shutdown stops the brain socket and removes its file and tokens", async () => {
	const home = await mkdtemp(join(tmpdir(), "mfw-bss-home-"));
	const root = await mkdtemp(join(tmpdir(), "mfw-bss-repo-"));
	paths.push(home, root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@test"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.ts"), "export {};\n");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);

	const orchestrator = await boot({
		projects: [{ name: "one", root }],
		mfwHome: home,
		autostart: false,
		log: silentLogger(),
	});
	const socket = brainSocketFor(home);
	socket.setHandler(async () => new Response("{}"));
	const access = await socket.issue({
		project: "one",
		sessionId: "S1",
		runId: "R1",
	});
	expect(existsSync(access.socketPath)).toBe(true);
	expect(existsSync(access.tokenFile)).toBe(true);

	await orchestrator.shutdown();
	expect(existsSync(access.socketPath)).toBe(false);
	expect(existsSync(access.tokenFile)).toBe(false);
	expect(socket.liveTurns()).toEqual([]);
});
