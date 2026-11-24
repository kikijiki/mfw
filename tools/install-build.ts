#!/usr/bin/env bun
/**
 * Assembles a compiled install under a prefix:
 *
 *   bun run tools/install-build.ts --prefix <dir> --runtime <bun>
 *       [--runtime-in-place] [--skip-build] [--bun-executable <path>]
 *       [--target bun-linux-x64] [--read-only]
 *
 *   <prefix>/bin/mfw, <prefix>/bin/mfw-board     compiled (tools/compile.ts)
 *   <prefix>/lib/mfw/server, public, THIRD_PARTY_NOTICES.txt   the server bundle
 *   <prefix>/lib/mfw/runtime/bun                 the pinned bun (unless in place)
 *   <prefix>/lib/mfw/install.json                the install manifest
 *   <prefix>/share/mfw/THIRD_PARTY_NOTICES.txt   notices for the executables
 *
 * The server bundle is copied without its host scripts: in a compiled install
 * every host entry is `mfw __host`. `--runtime` is the bun that runs the server;
 * it is copied into the install, or with `--runtime-in-place` recorded at its
 * own absolute path (a Nix store path). Get an official one with
 * `tools/fetch-bun-runtime.ts`, which checks it against packaging/bun-runtime.json.
 *
 * `mfw` is compiled last, with the digests of the server tree and the runtime
 * built in, so a manifest rewritten to match other files is still refused.
 * Nothing here downloads anything.
 */

import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { HOST_SCRIPTS_DIR } from "../packages/daemon/src/containment/host-script.ts";
import {
	INSTALL_LIB_DIR,
	INSTALL_MANIFEST,
	INSTALL_MANIFEST_VERSION,
	type InstallManifest,
	SERVER_TREE_ENTRIES,
	sha256OfFile,
	treeDigest,
} from "../packages/daemon/src/containment/install-manifest.ts";
import { type CompileOptions, compileBoard, compileMfw } from "./compile.ts";
import { collect, render } from "./third-party-notices.ts";

export interface InstallBuildOptions {
	root: string;
	prefix: string;
	runtime: string;
	runtimeInPlace?: boolean;
	skipBuild?: boolean;
	bunExecutable?: string;
	target?: string;
	readOnly?: boolean;
	/** Passed to the `mfw` compile (the caged smoke test only). */
	mfwPlugins?: CompileOptions["plugins"];
	env?: Record<string, string | undefined>;
}

export interface InstallBuildResult {
	prefix: string;
	libDir: string;
	manifest: InstallManifest;
	sizes: Record<string, number>;
}

function runtimeVersion(runtime: string): string {
	const r = Bun.spawnSync([runtime, "--version"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: "/nonexistent" },
	});
	const v = r.stdout.toString().trim();
	if (r.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(v)) {
		throw new Error(
			`${runtime} is not a working bun (${r.stderr.toString().trim()})`,
		);
	}
	return v;
}

/** Never through a link: the bundle's links point inside it, and are left as they are. */
function makeReadOnly(path: string): void {
	const st = lstatSync(path);
	if (st.isSymbolicLink()) return;
	if (st.isDirectory()) {
		for (const child of readdirSync(path)) makeReadOnly(join(path, child));
		chmodSync(path, 0o555);
	} else if (st.isFile()) {
		chmodSync(path, st.mode & 0o111 ? 0o555 : 0o444);
	}
}

export async function installBuild(
	o: InstallBuildOptions,
): Promise<InstallBuildResult> {
	const prefix = resolve(o.prefix);
	if (existsSync(prefix) && readdirSync(prefix).length > 0) {
		throw new Error(`refusing to assemble into ${prefix}: it is not empty`);
	}
	const output = join(o.root, "apps/start/.output");
	if (!o.skipBuild) {
		const built = Bun.spawnSync(["bun", "run", "build"], {
			cwd: o.root,
			stdout: "inherit",
			stderr: "inherit",
			env: o.env ?? process.env,
		});
		if (built.exitCode !== 0) throw new Error("bun run build failed");
	}
	if (!existsSync(join(output, "server", "index.mjs"))) {
		throw new Error("no server bundle. Fix: bun run build");
	}
	const libDir = join(prefix, INSTALL_LIB_DIR);
	const binDir = join(prefix, "bin");
	mkdirSync(libDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });

	const skipped = join(output, HOST_SCRIPTS_DIR);
	for (const entry of SERVER_TREE_ENTRIES) {
		// Links stay as written (relative, inside the bundle); without this they
		// would be rewritten to absolute paths back into the checkout.
		cpSync(join(output, entry), join(libDir, entry), {
			recursive: true,
			verbatimSymlinks: true,
			filter: (src) => src !== skipped && !src.startsWith(`${skipped}/`),
		});
	}

	const runtimeVer = runtimeVersion(o.runtime);
	let runtimePath: string;
	if (o.runtimeInPlace) {
		runtimePath = resolve(o.runtime);
	} else {
		mkdirSync(join(libDir, "runtime"));
		copyFileSync(o.runtime, join(libDir, "runtime", "bun"));
		chmodSync(join(libDir, "runtime", "bun"), 0o555);
		runtimePath = join(libDir, "runtime", "bun");
	}
	const runtimeSha = sha256OfFile(runtimePath);
	const serverDigest = treeDigest(libDir);

	const compileOpts: CompileOptions = {
		root: o.root,
		outDir: binDir,
		...(o.target ? { target: o.target } : {}),
		...(o.bunExecutable ? { bunExecutable: o.bunExecutable } : {}),
		...(o.env ? { env: o.env } : {}),
	};
	// mfw-board first: its digest is built into mfw, beside the server's and
	// the runtime's, so a manifest rewritten for other parts is still caught.
	const board = await compileBoard(compileOpts);
	const mfw = await compileMfw({
		...compileOpts,
		integrity: {
			server: serverDigest,
			runtime: runtimeSha,
			board: board.sha256,
		},
		...(o.mfwPlugins ? { plugins: o.mfwPlugins } : {}),
	});

	const manifest: InstallManifest = {
		version: INSTALL_MANIFEST_VERSION,
		kind: "compiled",
		mfw: { path: relative(libDir, mfw.path), sha256: mfw.sha256 },
		mfwBoard: { path: relative(libDir, board.path), sha256: board.sha256 },
		runtime: {
			path: o.runtimeInPlace ? runtimePath : relative(libDir, runtimePath),
			sha256: runtimeSha,
			bunVersion: runtimeVer,
		},
		server: { digest: serverDigest },
	};
	writeFileSync(
		join(libDir, INSTALL_MANIFEST),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	const notices = join(prefix, "share", "mfw", "THIRD_PARTY_NOTICES.txt");
	mkdirSync(join(prefix, "share", "mfw"), { recursive: true });
	writeFileSync(
		notices,
		render([
			...collect(join(o.root, "packages", "cli")),
			...collect(join(o.root, "packages", "board")),
		]),
	);
	if (o.readOnly) makeReadOnly(prefix);
	return {
		prefix,
		libDir,
		manifest,
		sizes: { mfw: mfw.bytes, "mfw-board": board.bytes },
	};
}

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const prefix = flag(argv, "--prefix");
	const runtime = flag(argv, "--runtime");
	if (!prefix || !runtime) {
		console.error(
			"usage: install-build.ts --prefix <dir> --runtime <bun> [--runtime-in-place] [--skip-build] [--bun-executable <path>] [--target <t>] [--read-only]",
		);
		process.exit(2);
	}
	try {
		const r = await installBuild({
			root: resolve(import.meta.dir, ".."),
			prefix,
			runtime: resolve(runtime),
			runtimeInPlace: argv.includes("--runtime-in-place"),
			skipBuild: argv.includes("--skip-build"),
			readOnly: argv.includes("--read-only"),
			...(flag(argv, "--bun-executable")
				? { bunExecutable: resolve(flag(argv, "--bun-executable") as string) }
				: {}),
			...(flag(argv, "--target") ? { target: flag(argv, "--target") } : {}),
		});
		console.log(`installed into ${r.prefix}`);
		for (const [name, bytes] of Object.entries(r.sizes)) {
			console.log(`  ${name}: ${(bytes / 1e6).toFixed(1)} MB`);
		}
		console.log(`  server digest ${r.manifest.server.digest}`);
		console.log(
			`  runtime ${r.manifest.runtime.path} (bun ${r.manifest.runtime.bunVersion})`,
		);
	} catch (e) {
		console.error(`install-build: ${(e as Error).message}`);
		process.exit(1);
	}
}
