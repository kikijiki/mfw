/**
 * What a dev environment's evaluation and setup may reach (design "Egress"):
 * exact host and port, no wildcards, each entry with where it was observed.
 *
 * Provenance: every entry below was contacted by a fixture of the live suite
 * (`dev-env-build-live.test.ts`, `dev-env-deps-live.test.ts`) through the
 * per-run proxy, which records allowed and denied destinations; the fixture
 * named in `source` fails if its entry is removed. Substitution from a binary
 * cache (cache.nixos.org) is done by the nix daemon on the host, with its own
 * configuration, and never passes through this proxy: it is not listed.
 *
 * A project adds hosts in its own config (`env.extraHosts`, `env.registries`);
 * the owner approves them with the environment, because the config is part of
 * the approval's hash.
 */

/** An exact `host:port`, validated by the config schema (`HostPort`). */
type HostPortString = string;

import type { AllowEntry } from "./egress-policy.ts";

export interface EnvEgressEntry {
	host: string;
	port: number;
	/** Which step reaches it. */
	purpose:
		| "flake-input"
		| "mise-registry"
		| "mise-download"
		| "package-registry";
	/** The fixture that contacted it, and why. */
	source: string;
}

/** Flake inputs on GitHub (`github:` refs): the API resolves, codeload serves the tarball. */
const FLAKE_INPUTS: readonly EnvEgressEntry[] = [
	{
		host: "github.com",
		port: 443,
		purpose: "flake-input",
		source:
			"flake fixture with an uncached github: input: nix fetches the archive here",
	},
	{
		host: "api.github.com",
		port: 443,
		purpose: "flake-input",
		source:
			"flake fixture with an uncached github: input: nix resolves the ref to a commit",
	},
	{
		host: "codeload.github.com",
		port: 443,
		purpose: "flake-input",
		source:
			"flake fixture with an uncached github: input: the archive's redirect target",
	},
];

/**
 * mise resolving and downloading a tool from GitHub releases. `api.github.com`
 * is not here: mise asked it only when its own version index was refused.
 */
const MISE: readonly EnvEgressEntry[] = [
	{
		host: "mise-versions.jdx.dev",
		port: 443,
		purpose: "mise-registry",
		source: "mise fixture (jq 1.7.1): the version index mise asks first",
	},
	{
		host: "github.com",
		port: 443,
		purpose: "mise-download",
		source: "mise fixture (jq 1.7.1): the release asset URL",
	},
	{
		host: "release-assets.githubusercontent.com",
		port: 443,
		purpose: "mise-download",
		source: "mise fixture (jq 1.7.1): the redirect target of the release asset",
	},
];

/** The evaluation's allowlist, before the project's own additions. */
export const ENV_BUILD_EGRESS: readonly EnvEgressEntry[] = [
	...FLAKE_INPUTS,
	...MISE,
];

/** Package registries, by the lockfile that selects them. */
export const REGISTRY_EGRESS: Readonly<
	Record<string, readonly EnvEgressEntry[]>
> = {
	npm: [
		{
			host: "registry.npmjs.org",
			port: 443,
			purpose: "package-registry",
			source:
				"deps fixture (bun.lock / package-lock.json): bun and npm fetch metadata and tarballs here",
		},
	],
	yarn: [
		{
			host: "registry.yarnpkg.com",
			port: 443,
			purpose: "package-registry",
			source: "yarn.lock: yarn classic's default registry",
		},
	],
	cargo: [
		{
			host: "index.crates.io",
			port: 443,
			purpose: "package-registry",
			source: "Cargo.lock: the sparse index",
		},
		{
			host: "static.crates.io",
			port: 443,
			purpose: "package-registry",
			source: "Cargo.lock: crate downloads",
		},
	],
	python: [
		{
			host: "pypi.org",
			port: 443,
			purpose: "package-registry",
			source: "uv.lock / poetry.lock / requirements: the simple index",
		},
		{
			host: "files.pythonhosted.org",
			port: 443,
			purpose: "package-registry",
			source: "uv.lock / poetry.lock / requirements: distribution files",
		},
	],
};

/** Which registries a lockfile selects. */
export const LOCKFILE_REGISTRIES: Readonly<Record<string, readonly string[]>> =
	{
		"bun.lock": ["npm"],
		"bun.lockb": ["npm"],
		"package-lock.json": ["npm"],
		"npm-shrinkwrap.json": ["npm"],
		"pnpm-lock.yaml": ["npm"],
		"yarn.lock": ["npm", "yarn"],
		"Cargo.lock": ["cargo"],
		"uv.lock": ["python"],
		"poetry.lock": ["python"],
		"requirements.txt": ["python"],
	};

function parseHostPort(
	entry: string,
): AllowEntry & { host: string; port: number } {
	const i = entry.lastIndexOf(":");
	return { host: entry.slice(0, i), port: Number(entry.slice(i + 1)) };
}

function unique(
	entries: readonly { host: string; port: number }[],
): (AllowEntry & { host: string; port: number })[] {
	const seen = new Map<string, { host: string; port: number }>();
	for (const e of entries)
		seen.set(`${e.host}:${e.port}`, { host: e.host, port: e.port });
	return [...seen.values()].sort((a, b) =>
		`${a.host}:${a.port}` < `${b.host}:${b.port}` ? -1 : 1,
	);
}

/** The exact pairs an evaluation may reach. */
export function envBuildAllowlist(
	extra: readonly HostPortString[] = [],
): (AllowEntry & { host: string; port: number })[] {
	return unique([...ENV_BUILD_EGRESS, ...extra.map(parseHostPort)]);
}

/** The exact pairs a setup step may reach: the configured registries, else those the lockfiles select. */
export function envInstallAllowlist(
	lockfiles: readonly string[],
	configured: readonly HostPortString[] | undefined,
): (AllowEntry & { host: string; port: number })[] {
	if (configured) return unique(configured.map(parseHostPort));
	const kinds = new Set(lockfiles.flatMap((l) => LOCKFILE_REGISTRIES[l] ?? []));
	return unique([...kinds].flatMap((k) => REGISTRY_EGRESS[k] ?? []));
}
