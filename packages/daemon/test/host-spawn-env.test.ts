import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	AGENT_LAUNCH_ENV,
	agentSpawnEnv,
} from "../src/containment/agent-launch-argv.ts";
import {
	forbiddenHostEnvName,
	HOST_ENV_NAMES,
	hostSpawnEnv,
	hostSpawnEnvShell,
	withoutForbiddenEnv,
} from "../src/containment/host-spawn-env.ts";

const ROOT = resolve(import.meta.dir, "../../..");

/** What an owner's or a provider's environment can carry (security review REL-1 M1). */
const LOADERS = {
	BUN_OPTIONS: "--preload /tmp/x.ts",
	BUN_BE_BUN: "1",
	BUN_INSPECT: "ws://x",
	BUN_INSPECT_PRELOAD: "/tmp/x.ts",
	BUN_JSC_useJIT: "0",
	NODE_OPTIONS: "--require /tmp/x.js",
	LD_PRELOAD: "/tmp/x.so",
	LD_LIBRARY_PATH: "/tmp",
	LD_AUDIT: "/tmp/a.so",
	DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
	GLIBC_TUNABLES: "glibc.malloc.x=1",
	BASH_ENV: "/tmp/x.sh",
	ENV: "/tmp/x.sh",
	"BASH_FUNC_x%%": "() { :; }",
};
const AMBIENT = {
	PATH: "/usr/bin",
	HOME: "/srv/u",
	LC_ALL: "C.UTF-8",
	MFW_HOME: "/m",
	XDG_RUNTIME_DIR: "/run/user/1",
	SSH_AUTH_SOCK: "/tmp/agent.sock",
	EDITOR: "vi",
};

describe("the host spawn environment", () => {
	test("keeps the base, MFW_* and locale names, and drops everything else", () => {
		const env = hostSpawnEnv({ ...AMBIENT, ...LOADERS });
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/srv/u",
			LC_ALL: "C.UTF-8",
			MFW_HOME: "/m",
			XDG_RUNTIME_DIR: "/run/user/1",
		});
	});

	test("a declared name passes, and is carried to the next hop", () => {
		const first = hostSpawnEnv(
			{ ...AMBIENT, ANTHROPIC_API_KEY: "k", CODEX_HOME: "/c" },
			["ANTHROPIC_API_KEY", "CODEX_HOME"],
		);
		expect(first.ANTHROPIC_API_KEY).toBe("k");
		expect(first[HOST_ENV_NAMES]).toBe("ANTHROPIC_API_KEY,CODEX_HOME");
		// The next hop declares nothing itself and still keeps them.
		const second = hostSpawnEnv({ ...first, OTHER: "x" });
		expect(second.CODEX_HOME).toBe("/c");
		expect(second.OTHER).toBeUndefined();
	});

	test("a loader name is never passed, even when declared or carried", () => {
		const declared = Object.keys(LOADERS);
		const env = hostSpawnEnv({ ...AMBIENT, ...LOADERS }, declared);
		for (const name of declared) expect(env[name], name).toBeUndefined();
		const carried = hostSpawnEnv({
			...LOADERS,
			[HOST_ENV_NAMES]: "LD_PRELOAD,BUN_OPTIONS",
		});
		expect(carried).toEqual({});
		for (const name of declared) expect(forbiddenHostEnvName(name)).toBe(true);
		expect(forbiddenHostEnvName("BUNNY")).toBe(false);
	});

	test("the caller-environment form only removes the loader names", () => {
		expect(withoutForbiddenEnv({ ...AMBIENT, ...LOADERS })).toEqual(AMBIENT);
	});

	test("the bash form keeps exactly what the TypeScript form keeps", () => {
		const bash = Bun.which("bash") as string;
		const envBin = Bun.which("env") as string;
		const source = {
			...AMBIENT,
			...LOADERS,
			SECRET_TOKEN: "s e c\nret",
			PROVIDER_URL: "https://x",
		};
		const declared = ["SECRET_TOKEN", "PROVIDER_URL", "LD_PRELOAD"];
		const script = [
			...hostSpawnEnvShell(declared),
			`${envBin} -i "\${mfw_env[@]}" ${envBin} -0`,
		].join("\n");
		const r = Bun.spawnSync([bash, "-c", script], {
			env: source,
			stdout: "pipe",
		});
		expect(r.exitCode).toBe(0);
		const got = Object.fromEntries(
			r.stdout
				.toString()
				.split("\0")
				.filter((l) => l !== "")
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		expect(got).toEqual(hostSpawnEnv(source, declared));
		expect(got.LD_PRELOAD).toBeUndefined();
		expect(got.SECRET_TOKEN).toBe("s e c\nret");
	});

	test("the launcher gets the allowlist; the agent CLI itself is not narrowed again", () => {
		const withRequest = {
			...AMBIENT,
			...LOADERS,
			[AGENT_LAUNCH_ENV]: "/r.json",
		};
		expect(agentSpawnEnv(withRequest).BUN_OPTIONS).toBeUndefined();
		expect(agentSpawnEnv(withRequest)[AGENT_LAUNCH_ENV]).toBe("/r.json");
		const cli = { ...AMBIENT, EDITOR: "vi" };
		expect(agentSpawnEnv(cli)).toEqual(cli);
	});
});

// ---------------------------------------------------------------------------
// Every spawn of mfw, bun or another compiled bun executable uses the helper.
// ---------------------------------------------------------------------------

/** What marks a file as starting mfw or bun: it builds such a command line. */
const STARTS_MFW_OR_BUN =
	/\b(?:hostCommand|hostArgv|agentSpawnArgv|mfwExecutable|selfExecutable|HOST_BUN_FLAGS|bridgeArgv|compiledServerCommand)\b|process\.execPath|runForwarding/;

const SPAWN_CALL = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|runProc)\(/g;

/** An env option that is one of the helpers, or a literal with nothing inherited. */
function envIsClean(call: string): boolean {
	if (/"-i"/.test(call)) return true; // `env -i ...`: nothing inherited
	const at = call.search(/\benv:/);
	if (at < 0) return false; // no env option: the whole environment is inherited
	const value = call.slice(at);
	// `inferenceEnv` is the brain's own allowlist for an agent CLI on the host.
	if (/^env:\s*(?:hostSpawnEnv|agentSpawnEnv|inferenceEnv)\(/.test(value))
		return true;
	if (/^env:\s*\{\s*\.\.\.withoutForbiddenEnv\(/.test(value)) return true;
	const literal = value.match(/^env:\s*(\{[^{}]*\})/)?.[1];
	return literal !== undefined && !/process\.env|\.\.\./.test(literal);
}

/**
 * Spawns in such files that are not of mfw or bun, or whose environment is an
 * explicit literal the check cannot parse: the file, a piece of the call that
 * identifies it, and why it is exempt.
 */
const EXEMPT: { file: string; call: string; why: string }[] = [
	{
		file: "packages/daemon/src/agent-host.ts",
		call: 'requireHostTool("mkfifo")',
		why: "coreutils mkfifo, not a bun executable",
	},
	{
		file: "packages/daemon/src/doctor/live-probes.ts",
		call: "PATH: pathVar",
		why: "an explicit PATH, XDG_RUNTIME_DIR and DBUS-only literal",
	},
	{
		file: "packages/daemon/src/deployment-smoke.ts",
		call: "",
		why: "an operator tool run by hand from the owner's shell, with explicit literals",
	},
	{
		file: "packages/daemon/src/verify-runpod-live.ts",
		call: "",
		why: "an operator tool run by hand from the owner's shell",
	},
];
const exempt = (rel: string, call: string) =>
	EXEMPT.some((e) => e.file === rel && call.includes(e.call));

function callText(text: string, open: number): string {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
	}
	return text.slice(open);
}

function* sourceFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (name === "node_modules" || name === "test") continue;
		if (statSync(p).isDirectory()) yield* sourceFiles(p);
		else if (/\.tsx?$/.test(name) && !/\.(?:d|test)\.tsx?$/.test(name)) yield p;
	}
}

describe("spawn sites", () => {
	test("every spawn in a file that starts mfw or bun has a clean environment", () => {
		const offenders: string[] = [];
		let checked = 0;
		const trees = [
			...readdirSync(join(ROOT, "packages")).map((p) =>
				join(ROOT, "packages", p, "src"),
			),
			join(ROOT, "apps/start/src"),
		];
		for (const tree of trees) {
			try {
				statSync(tree);
			} catch {
				continue;
			}
			for (const file of sourceFiles(tree)) {
				const text = readFileSync(file, "utf8");
				if (!STARTS_MFW_OR_BUN.test(text)) continue;
				const rel = relative(ROOT, file);
				for (const m of text.matchAll(SPAWN_CALL)) {
					const call = callText(text, (m.index ?? 0) + m[0].length - 1);
					checked++;
					if (envIsClean(call) || exempt(rel, call)) continue;
					const line = text.slice(0, m.index).split("\n").length;
					offenders.push(`${rel}:${line} ${m[0]}`);
				}
			}
		}
		expect(checked).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});

	test("the detector itself flags an inherited environment", () => {
		expect(
			envIsClean('Bun.spawn([mfw, "__host", id], { stdout: "pipe" })'),
		).toBe(false);
		expect(envIsClean("Bun.spawn(argv, { env: process.env })")).toBe(false);
		expect(
			envIsClean("Bun.spawn(argv, { env: { ...process.env, A: 1 } })"),
		).toBe(false);
		expect(
			envIsClean("Bun.spawn(argv, { env: hostSpawnEnv(process.env) })"),
		).toBe(true);
		expect(envIsClean('Bun.spawn(argv, { env: { PATH: "/x" } })')).toBe(true);
		expect(envIsClean('Bun.spawn([env, "-i", mfw], {})')).toBe(true);
	});
});
