/**
 * `mfw env ...`: the owner's trust gesture for a project's dev environment,
 * modelled on `direnv allow` and `mise trust` (dev-env-trust.ts). It runs
 * outside the sandbox, like `mfw auth`, against `$MFW_HOME`, which no agent
 * sandbox can see. `allow` prints exactly which files and hashes it approves;
 * running it is the approval.
 *
 * Nothing here evaluates the environment on the host: `build` runs the
 * env-build and env-install sandboxes (dev-env-build.ts), and every other
 * command reads only the repository's objects and the trust store.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type StoredProjectConfig } from "../config.ts";
import type { EnvConfig } from "./dev-env-config.ts";
import {
	type DevEnvResolution,
	type ResolveDevEnvInput,
	resolveDevEnv,
} from "./dev-env-resolve.ts";
import { EnvSourceError, resolveCommit } from "./dev-env-sources.ts";
import {
	allowEnv,
	denyEnv,
	EnvTrustStore,
	envConfigHash,
	proposeApproval,
} from "./dev-env-trust.ts";

export const ENV_USAGE = [
	"usage: mfw env <command>",
	"",
	"  status [<project>]   the dev environment of each project, as runs would get it",
	"  allow <project> [--rev <commit>]",
	"                approve the environment at one commit (default: the integration",
	"                branch). Prints every file and hash it approves. Evaluation then",
	"                happens only at that commit, inside the env-build sandbox",
	"  deny <project>       refuse the project's environment until it is allowed again",
	"  build <project>      evaluate and install the approved environment now, in its",
	"                sandboxes, and print what runs will get",
].join("\n");

export interface EnvCliDeps {
	home: string;
	out: (line: string) => void;
	err: (line: string) => void;
	/** The tests' caged chain. */
	seams?: ResolveDevEnvInput["seams"];
	now?: () => Date;
}

function projectOf(
	projects: readonly StoredProjectConfig[],
	name: string | undefined,
	d: EnvCliDeps,
): StoredProjectConfig | null {
	if (!name) {
		d.err(ENV_USAGE);
		return null;
	}
	const p = projects.find((x) => x.name === name);
	if (!p) {
		d.err(
			`mfw env: no project named ${name} in $MFW_HOME/config.json (known: ${projects.map((x) => x.name).join(", ") || "none"})`,
		);
	}
	return p ?? null;
}

const base = (p: StoredProjectConfig) => p.integrationBranch ?? "HEAD";

function describe(p: StoredProjectConfig, r: DevEnvResolution): string[] {
	switch (r.kind) {
		case "none":
			return [`${p.name}: no dev environment declared`];
		case "ready": {
			const c = r.capture;
			const lines = [
				`${p.name}: ${c.source ?? "setup"} approved at ${c.commit.slice(0, 12)}, evaluated ${c.builtAt}`,
				`  PATH: ${c.path.length} entries; ${Object.keys(c.env).length} variables; ${c.closure.length} store paths`,
			];
			if (c.dropped.length > 0) {
				lines.push(
					`  dropped: ${c.dropped.map((x) => `${x.name} (${x.reason})`).join(", ")}`,
				);
			}
			if (c.egress.denied.length > 0) {
				lines.push(`  refused hosts: ${c.egress.denied.join(", ")}`);
			}
			if (r.deps) {
				lines.push(
					`  dependencies: ${r.deps.outputs.join(", ") || "(none produced)"}`,
				);
			}
			return lines;
		}
		case "refused":
			return [`${p.name}: ${r.code}: ${r.reason}`, `  fix: ${r.fix}`];
	}
}

export async function runEnvCommand(
	args: string[],
	d: EnvCliDeps,
): Promise<number> {
	const [cmd, ...rest] = args;
	if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
		(cmd ? d.out : d.err)(ENV_USAGE);
		return cmd ? 0 : 2;
	}
	const config = await loadConfig(d.home);
	const resolve = (p: StoredProjectConfig, build: boolean) =>
		resolveDevEnv({
			mfwHome: d.home,
			project: p.name,
			root: p.root,
			stateDir: join(p.root, ".mfw"),
			config: p.env as EnvConfig | undefined,
			rev: base(p),
			build,
			...(d.seams ? { seams: d.seams } : {}),
		});

	switch (cmd) {
		case "status": {
			const wanted = rest[0];
			const projects = wanted
				? [projectOf(config.projects, wanted, d)].filter((p) => p !== null)
				: config.projects;
			if (wanted && projects.length === 0) return 1;
			let refused = false;
			for (const p of projects) {
				const r = await resolve(p, false);
				if (r.kind === "refused" && r.code !== "env_not_built") refused = true;
				for (const line of describe(p, r)) d.out(line);
			}
			return refused ? 1 : 0;
		}
		case "allow": {
			const name = rest.find((a) => !a.startsWith("--"));
			const p = projectOf(config.projects, name, d);
			if (!p) return 2;
			const at = rest.indexOf("--rev");
			const rev = at >= 0 ? rest[at + 1] : base(p);
			if (at >= 0 && !rev) {
				d.err("mfw env allow: --rev needs a commit");
				return 2;
			}
			let root: string;
			let commit: string;
			try {
				root = realpathSync(p.root);
				commit = await resolveCommit(root, rev as string);
			} catch (e) {
				d.err(
					`mfw env allow: ${(e as Error).message}${e instanceof EnvSourceError ? `. Fix: ${e.fix}` : ""}`,
				);
				return 1;
			}
			const setting = p.env?.source ?? "auto";
			const { detection } = await proposeApproval({
				project: p.name,
				root,
				commit,
				setting,
				config: p.env,
			});
			if (detection.kind === "unsupported") {
				d.err(`mfw env allow: ${detection.reason}. Fix: ${detection.fix}`);
				return 1;
			}
			d.out(
				`approving the ${detection.kind === "none" ? "setup" : detection.kind} environment of ${p.name} at ${commit}:`,
			);
			for (const f of detection.files) {
				d.out(`  ${f.path}  sha256:${f.sha256}  (blob ${f.oid})`);
			}
			if (p.env?.setup?.length) {
				d.out(
					`  setup: ${p.env.setup.map((c) => JSON.stringify(c)).join(", ")}`,
				);
			}
			d.out(`  config: sha256:${envConfigHash(p.env)}`);
			await allowEnv(new EnvTrustStore(d.home), {
				project: p.name,
				root,
				commit,
				setting,
				config: p.env,
				via: "cli",
				...(d.now ? { now: d.now } : {}),
			});
			d.out(
				`approved. It is evaluated only at this commit, in the env-build sandbox; \`mfw env build ${p.name}\` does it now.`,
			);
			return 0;
		}
		case "deny": {
			const p = projectOf(config.projects, rest[0], d);
			if (!p) return 2;
			const root = realpathSync(p.root);
			const commit = await resolveCommit(root, base(p));
			await denyEnv(new EnvTrustStore(d.home), {
				project: p.name,
				root,
				commit,
				config: p.env,
				via: "cli",
				...(d.now ? { now: d.now } : {}),
			});
			d.out(
				`denied: runs of ${p.name} are refused until \`mfw env allow ${p.name}\``,
			);
			return 0;
		}
		case "build": {
			const p = projectOf(config.projects, rest[0], d);
			if (!p) return 2;
			const r = await resolve(p, true);
			for (const line of describe(p, r)) d.out(line);
			if (r.kind === "refused" && r.log) {
				d.err("--- last lines of the log ---");
				d.err(r.log.slice(-8000));
			}
			return r.kind === "refused" ? 1 : 0;
		}
		default:
			d.err(`mfw env: unknown command ${cmd}\n${ENV_USAGE}`);
			return 2;
	}
}
