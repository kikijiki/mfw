import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeEnvCard } from "../src/containment/dev-env-card.ts";
import { runEnvCommand } from "../src/containment/dev-env-cli.ts";
import { approvalPlan, planLines } from "../src/containment/dev-env-plan.ts";
import {
	allowEnv,
	EnvTrustStore,
	envProtection,
} from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";

/**
 * F2 of the P8 security review: the owner reads what runs, not only the root
 * files' hashes; `allow` cannot approve a commit that moved under them; and
 * nested nix and mise configuration is protected.
 */

let base: string;
let root: string;
let home: string;

async function commitIn(files: Record<string, string>): Promise<string> {
	for (const [p, t] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), t);
	}
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "c"], root);
	return (await git(["rev-parse", "HEAD"], root)).stdout;
}

let first: string;

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-plan-")));
	root = join(base, "p");
	home = join(base, "mfw");
	mkdirSync(root);
	mkdirSync(home);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	first = await commitIn({
		".envrc": "use flake\nsource scripts/env.sh\n",
		"flake.nix": "{ outputs = _: import ./nix/devshell.nix; }\n",
		"nix/devshell.nix": "{}\n",
		"scripts/env.sh": "export A=1\n",
		"src/a.ts": "1\n",
	});
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			projects: [
				{
					name: "p",
					root,
					integrationBranch: "main",
					env: {},
				},
			],
		}),
	);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const cli = async (...args: string[]) => {
	const out: string[] = [];
	const code = await runEnvCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => out.push(l),
	});
	return { code, out: out.join("\n") };
};

describe("what a first approval shows", () => {
	test("every nix file and every tracked path a root file names", async () => {
		const plan = await approvalPlan(root, first, null);
		expect(plan.referenced).toEqual([
			".envrc",
			"flake.nix",
			"nix/devshell.nix",
			"scripts/env.sh",
		]);
		expect(planLines(plan).join("\n")).toContain("scripts/env.sh");
	});
});

describe("mfw env allow", () => {
	test("without --rev or --yes it prints the plan and approves nothing", async () => {
		const r = await cli("allow", "p");
		expect(r.code).toBe(3);
		expect(r.out).toContain("nix/devshell.nix");
		expect(r.out).toContain(`mfw env allow p --rev ${first}`);
		expect(new EnvTrustStore(home).read(root)).toBeNull();
	});

	test("a pasted commit prefix approves exactly that commit", async () => {
		const r = await cli("allow", "p", "--rev", first.slice(0, 12));
		expect(r.code).toBe(0);
		expect(new EnvTrustStore(home).read(root)?.commit).toBe(first);
	});

	test("after an approval it shows the whole-tree diff stat with the env diffs inline", async () => {
		const next = await commitIn({
			"nix/devshell.nix": "{ evil = true; }\n",
			"src/a.ts": "2\n",
		});
		const r = await cli("allow", "p");
		expect(r.code).toBe(3);
		expect(r.out).toContain(
			`changes since the approved commit ${first.slice(0, 12)}`,
		);
		expect(r.out).toContain("nix/devshell.nix");
		expect(r.out).toContain("src/a.ts");
		expect(r.out).toContain("+{ evil = true; }");
		expect(r.out).not.toContain("+2");
		const plan = await approvalPlan(root, next, first);
		const card = describeEnvCard({
			project: "p",
			commit: next,
			source: "direnv",
			files: [],
			configHash: "h",
			plan,
		});
		expect(card.detail).toContain("+{ evil = true; }");
	});
});

describe("what an approval protects", () => {
	test("a nix source: every *.nix at any depth", async () => {
		const rec = new EnvTrustStore(home).read(root);
		const p = envProtection(rec);
		expect(p("nix/devshell.nix")).toBe(true);
		expect(p("a/b/c/deep.nix")).toBe(true);
		expect(p(".envrc")).toBe(true);
		expect(p("src/a.ts")).toBe(false);
	});

	test("a mise source: .config/mise/conf.d", async () => {
		const m = join(base, "m");
		mkdirSync(m);
		await git(["init", "-q", "-b", "main", "."], m);
		await git(["config", "user.email", "t@t"], m);
		await git(["config", "user.name", "t"], m);
		writeFileSync(join(m, "mise.toml"), "[tools]\n");
		await git(["add", "-A"], m);
		await git(["commit", "-q", "-m", "c"], m);
		const c = (await git(["rev-parse", "HEAD"], m)).stdout;
		const store = new EnvTrustStore(join(base, "mfw2"));
		const rec = await allowEnv(store, {
			project: "m",
			root: m,
			commit: c,
			setting: "auto",
			config: {},
			via: "cli",
		});
		const p = envProtection(rec);
		expect(p(".config/mise/conf.d/x.toml")).toBe(true);
		expect(p("nix/devshell.nix")).toBe(false);
		expect(envProtection(null)("x.nix")).toBe(false);
	});
});
