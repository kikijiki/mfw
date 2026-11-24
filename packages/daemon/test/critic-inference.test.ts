import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CriticTransportRefused,
	criticInferenceFor,
} from "../src/critic-inference.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";

const CANARY = "MFW_TEST_DAEMON_SECRET";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "mfw-critic-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function stub(name: string, reply: string): Promise<string> {
	const bin = join(dir, name);
	await writeFile(
		bin,
		`#!/bin/sh\nenv > "${bin}.env"\npwd > "${bin}.cwd"\nprintf '%s' '${reply}'\n`,
	);
	await chmod(bin, 0o755);
	return bin;
}

/**
 * In a fresh process that starts with the canary in its environment: Bun hands
 * a child the environment it started with, so a variable set from inside this
 * test would not reach the child on the old code either, and prove nothing.
 */
async function inDaemonEnv(body: string): Promise<void> {
	const brain = join(import.meta.dir, "../src/brain.ts");
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const b = await import(${JSON.stringify(brain)});
const opts = { model: "m", timeoutMs: 20000 };
${body}`,
		],
		{
			env: { ...process.env, [CANARY]: "leaked" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, err] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	expect(err.slice(-400)).toBe("");
	expect(code).toBe(0);
}

describe("the critic runs through the sandboxed reviewer launch", () => {
	const claude = { id: "claude-cli", type: "claude-cli" } as const;
	const request = { model: "m", timeoutMs: 5_000 };
	let project: string;
	let home: string;

	beforeEach(async () => {
		project = join(dir, "project");
		home = join(dir, "home");
		await mkdir(project);
		await mkdir(home);
		await writeFile(join(project, "secret.txt"), "project file\n");
		configureRunWorkspace(project, { workspaceRoot: join(home, "workspaces") });
	});
	afterEach(() => clearRunWorkspace(project));

	test("no tools, an empty tree, the prompt on stdin", async () => {
		const seen: {
			tree: string;
			files: string[];
			argv: readonly string[];
			prompt: string;
			role: string;
		}[] = [];
		const client = criticInferenceFor(claude, {
			projectRoot: project,
			mfwHome: home,
			stateDir: join(project, ".mfw"),
			launch: async (req) => {
				seen.push({
					tree: req.tree,
					files: await readdir(req.tree),
					argv: req.argv,
					prompt: req.prompt,
					role: req.role,
				});
				return {
					exitCode: 0,
					stdout: '{"result":"verdict"}',
					stderr: "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			},
		});
		const reply = await client.complete("DIFF-TEXT", request);
		expect(typeof reply === "string" ? reply : reply.text).toBe("verdict");
		const call = seen[0];
		expect(call?.role).toBe("reviewer");
		expect(call?.files).toEqual([]);
		expect(call?.tree.startsWith(project)).toBe(false);
		expect(call?.prompt).toBe("DIFF-TEXT");
		expect(call?.argv).not.toContain("DIFF-TEXT");
		const tools = call?.argv.indexOf("--tools") ?? -1;
		expect(tools).toBeGreaterThan(0);
		expect(call?.argv[tools + 1]).toBe("");
		// The empty tree does not outlive the call.
		expect(existsSync(call?.tree as string)).toBe(false);
	});

	test.each([
		["codex-cli", "codex-cli"],
		["opencode", "acp"],
		["gemini-cli", "acp"],
	] as const)("%s is refused, with the fix, and launches nothing", async (id, type) => {
		let launched = 0;
		const client = criticInferenceFor(
			{ id, type },
			{
				projectRoot: project,
				mfwHome: home,
				stateDir: join(project, ".mfw"),
				launch: async () => {
					launched++;
					throw new Error("must not launch");
				},
			},
		);
		const failure = await Promise.resolve(client.complete("p", request)).catch(
			(e: Error) => e,
		);
		expect(failure).toBeInstanceOf(CriticTransportRefused);
		expect((failure as Error).message).toContain("Fix:");
		expect(launched).toBe(0);
	});

	test("a failed launch is a failure, never a verdict", async () => {
		const client = criticInferenceFor(claude, {
			projectRoot: project,
			mfwHome: home,
			stateDir: join(project, ".mfw"),
			launch: async () => {
				throw new SandboxUnavailableError("no sandbox");
			},
		});
		await expect(
			Promise.resolve(client.complete("p", request)),
		).rejects.toThrow("no sandbox");
	});
});
