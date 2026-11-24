#!/usr/bin/env bun
/**
 * Compiles the standalone `mfw` and `mfw-board` executables.
 *
 *   bun run tools/compile.ts [--out <dir>] [--target bun-linux-x64]
 *                            [--bun-executable <path>] [--only mfw|mfw-board]
 *
 * Writes `<out>/mfw` and `<out>/mfw-board` (default `dist/bin`). Each is one
 * self-contained file: nothing it runs is read from a checkout or from
 * `node_modules` afterwards.
 *
 * `mfw` embeds, through the virtual module `mfw:embedded`:
 *  - the project database's migrations with their hash manifest, checked at
 *    every open exactly as a bundle checks its copies;
 *  - the scripts a sandbox runs (egress relay, WIP helper, the brain's MCP
 *    server) and the remote runtime, prebuilt;
 *  - the libsql addon for the target, loaded through `native-addon.ts`;
 *  - every host entry, run by self re-exec (`mfw __host <id>`).
 *
 * Neither executable reads `.env` or `bunfig.toml` at start, and both refuse
 * bun runtime options from the environment. The build is reproducible in the
 * ways it can be: the stamp's time comes from `SOURCE_DATE_EPOCH` or the commit,
 * and embedded module paths are relative to the repository root, so the
 * builder's directories do not end up in the binary.
 *
 * `--bun-executable` is the bun the executables are made from. By default it is
 * the bun running this script; a Nix-built bun links against the Nix store, so
 * for a portable executable pass an official bun (see packaging/bun-runtime.json).
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { BuildStamp } from "../packages/core/src/build-info.ts";
import {
	EGRESS_RELAY,
	type HostContentId,
	type HostScript,
	MCP_MAIN,
	REMOTE_RUNTIME,
	sha256Hex,
	WIP_HELPER,
} from "../packages/daemon/src/containment/host-script.ts";
import { embeddableMigrations } from "../packages/db/src/migration-source.ts";
import { buildStampFor, packageVersion, stampDefine } from "./build-stamp.ts";

/** The libsql addon package for each compile target. Only installed ones build. */
export const LIBSQL_ADDONS: Record<string, string> = {
	"bun-linux-x64": "@libsql/linux-x64-gnu",
	"bun-linux-arm64": "@libsql/linux-arm64-gnu",
	"bun-darwin-x64": "@libsql/darwin-x64",
	"bun-darwin-arm64": "@libsql/darwin-arm64",
};

/** The scripts `mfw` carries for a sandbox or a remote host. */
const CONTENT_SCRIPTS: readonly HostScript[] = [
	EGRESS_RELAY,
	WIP_HELPER,
	MCP_MAIN,
	REMOTE_RUNTIME,
];

/** Same as the bundle's host scripts: native packages stay out of a script. */
const SCRIPT_EXTERNAL = ["@libsql/*", "libsql"];

const LIBSQL_LOADER = 'globalThis[Symbol.for("mfw.libsqlNative")]()';

export interface CompileOptions {
	root: string;
	outDir: string;
	target?: string;
	bunExecutable?: string;
	/** Digests of the install this `mfw` belongs to (`tools/install-build.ts`). */
	integrity?: Record<string, string>;
	/** Extra plugins, applied last: only the caged smoke test passes any. */
	plugins?: BunPlugin[];
	env?: Record<string, string | undefined>;
}

export interface CompiledBinary {
	path: string;
	sha256: string;
	bytes: number;
	stamp: BuildStamp;
}

export function hostTarget(): string {
	const os = process.platform === "darwin" ? "darwin" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `bun-${os}-${arch}`;
}

function realResolve(spec: string, from: string): string {
	return realpathSync(Bun.resolveSync(spec, from));
}

/** The installed `.node` file for `target`, found through libsql's own dependency. */
export function libsqlAddonPath(root: string, target: string): string {
	const pkg = LIBSQL_ADDONS[target];
	if (!pkg) throw new Error(`no libsql addon is known for ${target}`);
	try {
		const client = realResolve("@libsql/client", join(root, "packages/db"));
		const libsql = realResolve("libsql", dirname(client));
		return realResolve(`${pkg}/index.node`, dirname(libsql));
	} catch {
		throw new Error(
			`the libsql addon for ${target} (${pkg}) is not installed, so mfw cannot be compiled for it`,
		);
	}
}

/**
 * libsql picks its addon at run time by package name; a compiled executable
 * has no `node_modules`, so its loader calls the one `native-addon.ts` installs.
 */
export function libsqlShimPlugin(): BunPlugin {
	return {
		name: "mfw-libsql-shim",
		setup(build) {
			build.onLoad(
				{ filter: /node_modules[\\/]libsql[\\/]index\.js$/ },
				async (args) => {
					const text = await Bun.file(args.path).text();
					const loader = /function requireNative\(\) \{[\s\S]*?\n\}\n/;
					if (!loader.test(text)) {
						throw new Error(
							`libsql's loader changed (${args.path}); update the shim in tools/compile.ts`,
						);
					}
					return {
						loader: "js",
						contents: text.replace(
							loader,
							`function requireNative() {\n  return ${LIBSQL_LOADER};\n}\n`,
						),
					};
				},
			);
		},
	};
}

/**
 * Bun writes a CommonJS module's absolute `__dirname` and `__filename` into
 * the bundle. In dependencies they only locate worker files, which a compiled
 * executable does not use, so they become paths relative to the repository and
 * the builder's directories stay out of the binary.
 */
export function relativeDirnamePlugin(root: string): BunPlugin {
	const prefix = `${resolve(root)}/`;
	return {
		name: "mfw-relative-dirname",
		setup(build) {
			build.onLoad(
				{ filter: /[\\/]node_modules[\\/].*\.[cm]?js$/ },
				async (args) => {
					const text = await Bun.file(args.path).text();
					if (!/\b__(?:dirname|filename)\b/.test(text)) return undefined;
					const rel = (p: string) =>
						JSON.stringify(p.startsWith(prefix) ? p.slice(prefix.length) : p);
					return {
						loader: "js",
						contents: text
							.replace(/\b__dirname\b/g, rel(dirname(args.path)))
							.replace(/\b__filename\b/g, rel(args.path)),
					};
				},
			);
		},
	};
}

/** The virtual module `mfw:embedded`, from the payload's parts. */
export function embeddedPlugin(source: string): BunPlugin {
	return {
		name: "mfw-embedded",
		setup(build) {
			build.onResolve({ filter: /^mfw:embedded$/ }, () => ({
				path: "embedded",
				namespace: "mfw-embedded",
			}));
			build.onLoad({ filter: /.*/, namespace: "mfw-embedded" }, () => ({
				loader: "js",
				contents: source,
			}));
		},
	};
}

async function bundleScript(root: string, script: HostScript): Promise<string> {
	const built = await Bun.build({
		entrypoints: [join(root, script.fromRoot)],
		target: "bun",
		format: "esm",
		minify: false,
		sourcemap: "none",
		external: SCRIPT_EXTERNAL,
		root,
	});
	const output = built.outputs[0];
	if (!built.success || built.outputs.length !== 1 || !output) {
		throw new Error(
			`could not bundle ${script.fromRoot}: ${built.logs.join("\n")}`,
		);
	}
	return output.text();
}

export async function contentScripts(
	root: string,
): Promise<Record<HostContentId, string>> {
	const out: Partial<Record<HostContentId, string>> = {};
	for (const script of CONTENT_SCRIPTS) {
		out[script.id as HostContentId] = await bundleScript(root, script);
	}
	return out as Record<HostContentId, string>;
}

function sizeOf(path: string): number {
	return statSync(path).size;
}

async function compileOne(
	o: CompileOptions,
	entry: string,
	outName: string,
	stamp: BuildStamp,
	plugins: BunPlugin[],
): Promise<CompiledBinary> {
	const target = o.target ?? hostTarget();
	const outfile = join(o.outDir, outName);
	const built = await Bun.build({
		entrypoints: [join(o.root, entry)],
		root: o.root,
		target: "bun",
		format: "esm",
		minify: false,
		sourcemap: "none",
		define: stampDefine(stamp),
		plugins: [...plugins, ...(o.plugins ?? [])],
		compile: {
			target: target as Bun.Build.CompileTarget,
			outfile,
			autoloadDotenv: false,
			autoloadBunfig: false,
			autoloadTsconfig: false,
			autoloadPackageJson: false,
			...(o.bunExecutable ? { executablePath: o.bunExecutable } : {}),
		},
	});
	if (!built.success) {
		throw new Error(`could not compile ${outName}: ${built.logs.join("\n")}`);
	}
	const bytes = await Bun.file(outfile).bytes();
	return {
		path: outfile,
		sha256: sha256Hex(bytes),
		bytes: sizeOf(outfile),
		stamp,
	};
}

function stampOf(
	o: CompileOptions,
	packageJson: string,
	integrity?: Record<string, string>,
): BuildStamp {
	return buildStampFor(
		o.root,
		"compiled",
		{
			version: packageVersion(join(o.root, packageJson)),
			target: o.target ?? hostTarget(),
			...(integrity && Object.keys(integrity).length > 0 ? { integrity } : {}),
		},
		o.env,
	);
}

export async function compileMfw(o: CompileOptions): Promise<CompiledBinary> {
	const target = o.target ?? hostTarget();
	const addon = libsqlAddonPath(o.root, target);
	const scripts = await contentScripts(o.root);
	const migrations = embeddableMigrations(
		join(o.root, "packages/db/migrations"),
	);
	const addonSha = sha256Hex(await Bun.file(addon).bytes());
	const source = [
		`import libsqlFile from ${JSON.stringify(addon)} with { type: "file" };`,
		`export default {`,
		`  migrations: ${JSON.stringify(migrations)},`,
		`  scripts: ${JSON.stringify(scripts)},`,
		`  libsql: { file: libsqlFile, sha256: ${JSON.stringify(addonSha)} },`,
		`  integrity: {},`,
		`};`,
	].join("\n");
	return compileOne(
		o,
		"packages/cli/src/compiled-main.ts",
		"mfw",
		stampOf(o, "packages/cli/package.json", o.integrity),
		[embeddedPlugin(source), libsqlShimPlugin(), relativeDirnamePlugin(o.root)],
	);
}

export async function compileBoard(o: CompileOptions): Promise<CompiledBinary> {
	return compileOne(
		o,
		"packages/board/src/cli.ts",
		"mfw-board",
		stampOf(o, "packages/board/package.json"),
		[relativeDirnamePlugin(o.root)],
	);
}

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const root = resolve(import.meta.dir, "..");
	const only = flag(argv, "--only");
	const opts: CompileOptions = {
		root,
		outDir: resolve(flag(argv, "--out") ?? join(root, "dist/bin")),
		...(flag(argv, "--target") ? { target: flag(argv, "--target") } : {}),
		...(flag(argv, "--bun-executable")
			? { bunExecutable: resolve(flag(argv, "--bun-executable") as string) }
			: {}),
	};
	const results: CompiledBinary[] = [];
	if (only !== "mfw-board") results.push(await compileMfw(opts));
	if (only !== "mfw") results.push(await compileBoard(opts));
	for (const r of results) {
		console.log(
			`${r.path}: ${(r.bytes / 1e6).toFixed(1)} MB, sha256 ${r.sha256}`,
		);
	}
}
