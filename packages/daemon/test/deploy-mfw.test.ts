import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DeployCommand,
	type DeployMfwResult,
	deployMfw,
} from "../src/deploy-mfw.ts";
import type { ProcResult } from "../src/proc.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const roots: string[] = [];

async function waitFor(path: string): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (!existsSync(path)) {
		if (performance.now() >= deadline) {
			throw new Error(`timed out waiting for ${path}`);
		}
		await Bun.sleep(10);
	}
}

function result(patch: Partial<ProcResult> = {}): ProcResult {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		truncated: false,
		signalCode: null,
		...patch,
	};
}

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-deploy-test-"));
	roots.push(root);
	await mkdir(join(root, "apps/start/.output/server"), { recursive: true });
	await writeFile(
		join(root, "apps/start/.output/server/index.mjs"),
		"old artifact",
	);
	await mkdir(join(root, "apps/start/.output/public/assets"), {
		recursive: true,
	});
	await writeFile(
		join(root, "apps/start/.output/public/assets/old-lazy-aaaaaaaa.js"),
		"old lazy asset",
	);
	await writeFile(join(root, "primary-revision"), "not-the-requested-sha");
	return root;
}

function fakeCommands(
	options: {
		buildFails?: boolean;
		checkoutFails?: boolean;
		installFails?: boolean;
		onRestart?: () => void | Promise<void>;
		sha?: string;
	} = {},
) {
	const builtSha = options.sha ?? SHA;
	const calls: { argv: string[]; cwd?: string }[] = [];
	const run: DeployCommand = async (argv, commandOptions) => {
		calls.push({ argv: [...argv], cwd: commandOptions?.cwd });
		if (argv[0] === "git" && argv[1] === "rev-parse") {
			return result({ stdout: `${builtSha}\n` });
		}
		if (argv[0] === "git" && argv[1] === "merge-base") {
			return result({ exitCode: 1 });
		}
		if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add") {
			if (options.checkoutFails) {
				return result({ exitCode: 1, stderr: "synthetic checkout failure" });
			}
		}
		if (argv[0] === "bun" && argv[1] === "install") {
			if (options.installFails) {
				return result({ exitCode: 1, stderr: "synthetic install failure" });
			}
		}
		if (argv[0] === "bun" && argv[1] === "run" && argv[2] === "build") {
			if (options.buildFails) {
				return result({ exitCode: 1, stderr: "synthetic build failure" });
			}
			const cwd = commandOptions?.cwd;
			if (!cwd) throw new Error("build command had no cwd");
			await mkdir(join(cwd, "apps/start/.output/server"), {
				recursive: true,
			});
			await writeFile(
				join(cwd, "apps/start/.output/server/index.mjs"),
				`artifact built from ${builtSha}`,
			);
			await mkdir(join(cwd, "apps/start/.output/public/assets"), {
				recursive: true,
			});
			await writeFile(
				join(
					cwd,
					"apps/start/.output/public/assets",
					`app-${builtSha.slice(0, 12)}.js`,
				),
				`lazy asset built from ${builtSha}`,
			);
		}
		if (argv[0] === "systemd-run") await options.onRestart?.();
		return result();
	};
	return { calls, run };
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("deployMfw", () => {
	test("builds MFW_SHA in a detached worktree and publishes that artifact", async () => {
		const root = await fixture();
		let artifactAtRestart: string | undefined;
		const fake = fakeCommands({
			onRestart: async () => {
				artifactAtRestart = await readFile(
					join(root, "apps/start/.output/server/index.mjs"),
					"utf8",
				);
			},
		});

		const deployed = await deployMfw({
			repoRoot: root,
			sha: SHA,
			run: fake.run,
		});

		expect(deployed).toEqual({
			sha: SHA,
			status: "deployed",
			restartArranged: true,
		});
		expect(
			await readFile(join(root, "apps/start/.output/server/index.mjs"), "utf8"),
		).toBe(`artifact built from ${SHA}`);
		expect(artifactAtRestart).toBe(`artifact built from ${SHA}`);
		expect(
			await readFile(
				join(root, "apps/start/.output/public/assets/old-lazy-aaaaaaaa.js"),
				"utf8",
			),
		).toBe("old lazy asset");
		const add = fake.calls.find(
			(call) => call.argv[0] === "git" && call.argv[1] === "worktree",
		);
		expect(add?.argv.slice(0, 4)).toEqual([
			"git",
			"worktree",
			"add",
			"--detach",
		]);
		expect(add?.argv.at(-1)).toBe(SHA);
		expect(
			fake.calls.find(
				(call) => call.argv[0] === "bun" && call.argv[1] === "run",
			)?.cwd,
		).not.toBe(root);
		expect(
			fake.calls.filter((call) => call.argv[0] === "systemd-run"),
		).toHaveLength(1);
		const restart = fake.calls.find((call) => call.argv[0] === "systemd-run");
		expect(restart?.argv).toContain("--on-active=2s");
		expect(restart?.argv.slice(-4)).toEqual([
			"systemctl",
			"--user",
			"restart",
			"mfw.service",
		]);
	});

	test("retains lazy assets for one release window without accumulating older releases", async () => {
		const root = await fixture();
		await deployMfw({ repoRoot: root, sha: SHA, run: fakeCommands().run });

		const firstAsset = join(
			root,
			"apps/start/.output/public/assets",
			`app-${SHA.slice(0, 12)}.js`,
		);
		const legacyAsset = join(
			root,
			"apps/start/.output/public/assets/old-lazy-aaaaaaaa.js",
		);
		expect(await readFile(firstAsset, "utf8")).toContain(SHA);
		expect(await readFile(legacyAsset, "utf8")).toBe("old lazy asset");

		await deployMfw({
			repoRoot: root,
			sha: NEW_SHA,
			run: fakeCommands({ sha: NEW_SHA }).run,
		});

		expect(await readFile(firstAsset, "utf8")).toContain(SHA);
		expect(
			await readFile(
				join(
					root,
					"apps/start/.output/public/assets",
					`app-${NEW_SHA.slice(0, 12)}.js`,
				),
				"utf8",
			),
		).toContain(NEW_SHA);
		await expect(readFile(legacyAsset, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		const marker = JSON.parse(
			await readFile(
				join(root, "apps/start/.output/.mfw-deployment.json"),
				"utf8",
			),
		) as { publicAssets: string[] };
		expect(marker.publicAssets).toEqual([
			`assets/app-${NEW_SHA.slice(0, 12)}.js`,
		]);
	});

	test.each([
		["checkout", { checkoutFails: true }, "synthetic checkout failure"],
		["dependency", { installFails: true }, "synthetic install failure"],
	] as const)("a %s failure preserves the live artifact and never requests a restart", async (_kind, failure, message) => {
		const root = await fixture();
		const fake = fakeCommands(failure);

		await expect(
			deployMfw({ repoRoot: root, sha: SHA, run: fake.run }),
		).rejects.toThrow(message);

		expect(
			await readFile(join(root, "apps/start/.output/server/index.mjs"), "utf8"),
		).toBe("old artifact");
		expect(
			fake.calls.filter((call) => call.argv[0] === "systemd-run"),
		).toHaveLength(0);
	});

	test("a failed build preserves the live artifact and never requests a restart", async () => {
		const root = await fixture();
		const fake = fakeCommands({ buildFails: true });

		await expect(
			deployMfw({ repoRoot: root, sha: SHA, run: fake.run }),
		).rejects.toThrow("synthetic build failure");

		expect(
			await readFile(join(root, "apps/start/.output/server/index.mjs"), "utf8"),
		).toBe("old artifact");
		expect(
			fake.calls.filter((call) => call.argv[0] === "systemd-run"),
		).toHaveLength(0);
	});

	test("a failed invocation releases the publication lock", async () => {
		const root = await fixture();
		await expect(
			deployMfw({
				repoRoot: root,
				sha: SHA,
				run: fakeCommands({ buildFails: true }).run,
			}),
		).rejects.toThrow("synthetic build failure");

		const recovered = await deployMfw({
			repoRoot: root,
			sha: NEW_SHA,
			run: fakeCommands({ sha: NEW_SHA }).run,
		});
		expect(recovered).toMatchObject({ sha: NEW_SHA, status: "deployed" });
	});

	test("replaying a successfully deployed SHA is a no-op", async () => {
		const root = await fixture();
		const fake = fakeCommands();

		await deployMfw({ repoRoot: root, sha: SHA, run: fake.run });
		const callsAfterDeploy = fake.calls.length;
		const replay = await deployMfw({ repoRoot: root, sha: SHA, run: fake.run });

		expect(replay).toEqual({
			sha: SHA,
			status: "unchanged",
			restartArranged: false,
		});
		expect(fake.calls).toHaveLength(callsAfterDeploy);
		expect(
			fake.calls.filter((call) => call.argv[0] === "systemd-run"),
		).toHaveLength(1);
	});

	test("an artifact published before restart scheduling is retried without rebuilding", async () => {
		const root = await fixture();
		await writeFile(
			join(root, "apps/start/.output/.mfw-deployment.json"),
			`${JSON.stringify({ sha: SHA, restartArranged: false })}\n`,
		);
		const fake = fakeCommands();

		const retried = await deployMfw({
			repoRoot: root,
			sha: SHA,
			run: fake.run,
		});

		expect(retried.status).toBe("restart-arranged");
		expect(fake.calls.map((call) => call.argv[0])).toEqual(["systemd-run"]);
	});

	test("a late replay cannot regress a newer deployed descendant", async () => {
		const root = await fixture();
		await writeFile(
			join(root, "apps/start/.output/.mfw-deployment.json"),
			`${JSON.stringify({ sha: NEW_SHA, restartArranged: true })}\n`,
		);
		const fake = fakeCommands();
		const run: DeployCommand = async (argv, options) => {
			if (argv[0] === "git" && argv[1] === "merge-base") {
				fake.calls.push({ argv: [...argv], cwd: options?.cwd });
				return result();
			}
			return fake.run(argv, options);
		};

		const replay = await deployMfw({ repoRoot: root, sha: OLD_SHA, run });

		expect(replay).toEqual({
			sha: NEW_SHA,
			status: "unchanged",
			restartArranged: false,
		});
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.argv).toEqual([
			"git",
			"merge-base",
			"--is-ancestor",
			OLD_SHA,
			NEW_SHA,
		]);
		expect(
			await readFile(join(root, "apps/start/.output/server/index.mjs"), "utf8"),
		).toBe("old artifact");
	});

	test("an older cross-process invocation queued behind a newer deploy cannot regress it", async () => {
		const root = await fixture();
		const ready = join(root, "new-build-ready");
		const release = join(root, "release-new-build");
		const newResult = join(root, "new-result.json");
		const oldResult = join(root, "old-result.json");
		const child = (childSha: string, resultPath: string, gate = false) =>
			Bun.spawn(
				["bun", "packages/daemon/test/fixtures/deploy-mfw-process.ts"],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						TEST_REPO: root,
						TEST_SHA: childSha,
						TEST_RESULT: resultPath,
						TEST_OLD_SHA: OLD_SHA,
						TEST_NEW_SHA: NEW_SHA,
						...(gate
							? { TEST_BUILD_READY: ready, TEST_BUILD_RELEASE: release }
							: {}),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);

		const newer = child(NEW_SHA, newResult, true);
		await waitFor(ready);
		const older = child(OLD_SHA, oldResult);
		await Bun.sleep(100);
		expect(existsSync(oldResult)).toBe(false);
		await writeFile(release, "release\n");

		const [newStderr, oldStderr] = await Promise.all([
			new Response(newer.stderr).text(),
			new Response(older.stderr).text(),
		]);
		expect(await newer.exited, newStderr).toBe(0);
		expect(await older.exited, oldStderr).toBe(0);
		const newOutcome = JSON.parse(await readFile(newResult, "utf8")) as {
			builds: number;
		};
		const oldOutcome = JSON.parse(await readFile(oldResult, "utf8")) as {
			builds: number;
			deployment: DeployMfwResult;
		};
		expect(newOutcome.builds).toBe(1);
		expect(oldOutcome.builds).toBe(0);
		expect(oldOutcome.deployment).toEqual({
			sha: NEW_SHA,
			status: "unchanged",
			restartArranged: false,
		});
		expect(
			await readFile(join(root, "apps/start/.output/server/index.mjs"), "utf8"),
		).toBe(`artifact built from ${NEW_SHA}`);
	});

	test("rejects a non-full MFW_SHA before invoking any command", async () => {
		const root = await fixture();
		const fake = fakeCommands();
		await expect(
			deployMfw({ repoRoot: root, sha: OLD_SHA.slice(0, 12), run: fake.run }),
		).rejects.toThrow("full hexadecimal commit id");
		expect(fake.calls).toHaveLength(0);
	});
});
