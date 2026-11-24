/**
 * A project's `env` entry in `$MFW_HOME/config.json`: how its development
 * environment is found and prepared. It lives in the daemon home, which no
 * agent can write, and its canonical hash is part of every approval
 * (dev-env-trust.ts), so changing it asks the owner again.
 */

import { z } from "zod";

/** `host:port`, lower case, no wildcard and no IP literal: what the proxy accepts. */
export const HostPort = z
	.string()
	.max(260)
	.regex(
		/^(?=.{1,253}:)(?!\d+\.\d+\.\d+\.\d+:)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+:[1-9][0-9]{0,4}$/,
		"must be an exact host:port such as registry.npmjs.org:443",
	);

/** A tree path the setup step produces: relative, no `..`, at most one `*` segment. */
const OutputPath = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(p) =>
			!p.startsWith("/") &&
			!p.includes("\0") &&
			p
				.split("/")
				.every(
					(s) =>
						s !== "" &&
						s !== "." &&
						s !== ".." &&
						!s.startsWith("-") &&
						s !== ".git" &&
						(s === "*" || !s.includes("*")),
				) &&
			p.split("/").filter((s) => s === "*").length <= 1,
		"must be a relative path with at most one * segment and no .. or .git",
	);

export const EnvConfigSchema = z.strictObject({
	/** `auto` picks the first present source (direnv, mise, flake, devenv). */
	source: z
		.enum(["auto", "none", "direnv", "mise", "flake", "devenv"])
		.optional(),
	/**
	 * Commands that install dependencies, run in the deps sandbox at the
	 * approved commit with only `registries` reachable. Lifecycle scripts run
	 * there and nowhere else.
	 */
	setup: z.array(z.string().min(1).max(2000)).max(16).optional(),
	/**
	 * Packages whose lifecycle scripts may run during `setup`. Empty (the
	 * default): lifecycle scripts are off for bun, npm, pnpm and yarn. Any entry
	 * turns them on for the install, and the card shows the list; per-package
	 * enforcement is the package manager's (bun's own `trustedDependencies`).
	 * Build scripts of cargo (`build.rs`) and python builds cannot be turned off.
	 */
	trustedDependencies: z.array(z.string().min(1).max(214)).max(256).optional(),
	/** What `setup` produces and runs reuse. Default: the node_modules directories. */
	outputs: z.array(OutputPath).max(32).optional(),
	/** Registry hosts `setup` may reach. Default: from the lockfiles present. */
	registries: z.array(HostPort).max(32).optional(),
	/** Further hosts the evaluation may reach (a flake input on another forge). */
	extraHosts: z.array(HostPort).max(32).optional(),
	/**
	 * Let the evaluation use the host's nix daemon. Required for flake and
	 * devenv sources, and for an `.envrc` that uses nix. The daemon fetches and
	 * builds with the host's network, outside the run's proxy, can reach this
	 * machine's loopback services, can read the whole store and can collect
	 * unrooted store paths: set it only for a project you trust that far.
	 */
	nixDaemon: z.boolean().optional(),
	/** Refuse an evaluation when /nix/store has less free space than this, in MiB. Default 4096. */
	minStoreFreeMb: z.number().int().min(0).max(10_000_000).optional(),
	/** Fail an evaluation that grows /nix/store by more than this, in MiB. Default 16384. */
	maxStoreGrowthMb: z.number().int().min(1).max(10_000_000).optional(),
	/** Wall-clock limit of one evaluation or setup, in seconds. Default 900. */
	timeoutSeconds: z.number().int().min(10).max(7200).optional(),
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

export const DEFAULT_ENV_TIMEOUT_SECONDS = 900;
export const DEFAULT_MIN_STORE_FREE_MB = 4096;
export const DEFAULT_MAX_STORE_GROWTH_MB = 16384;

/** Sources that need the nix daemon: always for these two, for direnv when the `.envrc` uses nix. */
export const NIX_SOURCES = ["flake", "devenv"] as const;
