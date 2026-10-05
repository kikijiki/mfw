import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DeployCommand, deployMfw } from "../../src/deploy-mfw.ts";
import type { ProcResult } from "../../src/proc.ts";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
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

const root = required("TEST_REPO");
const sha = required("TEST_SHA");
const output = required("TEST_RESULT");
const ready = process.env.TEST_BUILD_READY;
const release = process.env.TEST_BUILD_RELEASE;
let builds = 0;

const run: DeployCommand = async (argv, options) => {
	if (argv[0] === "git" && argv[1] === "merge-base") {
		const oldSha = process.env.TEST_OLD_SHA;
		const newSha = process.env.TEST_NEW_SHA;
		return result({
			exitCode: argv[3] === oldSha && argv[4] === newSha ? 0 : 1,
		});
	}
	if (argv[0] === "git" && argv[1] === "rev-parse") {
		return result({ stdout: `${sha}\n` });
	}
	if (argv[0] === "bun" && argv[1] === "run" && argv[2] === "build") {
		builds++;
		if (!options?.cwd) throw new Error("build command had no cwd");
		await mkdir(join(options.cwd, "apps/start/.output/server"), {
			recursive: true,
		});
		await mkdir(join(options.cwd, "apps/start/.output/public/assets"), {
			recursive: true,
		});
		await writeFile(
			join(options.cwd, "apps/start/.output/server/index.mjs"),
			`artifact built from ${sha}`,
		);
		await writeFile(
			join(
				options.cwd,
				"apps/start/.output/public/assets",
				`app-${sha.slice(0, 12)}.js`,
			),
			sha,
		);
		if (ready) await writeFile(ready, "ready\n");
		if (release) {
			while (!existsSync(release)) await Bun.sleep(10);
		}
	}
	return result();
};

try {
	const deployment = await deployMfw({ repoRoot: root, sha, run });
	await writeFile(output, `${JSON.stringify({ deployment, builds })}\n`);
} catch (error) {
	await writeFile(
		output,
		`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), builds })}\n`,
	);
	process.exitCode = 1;
}
