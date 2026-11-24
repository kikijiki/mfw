/**
 * Bundles every host script into the production build, with a content-hash
 * manifest the server checks at each launch. Runs after `vite build`:
 *
 *   bun run build
 *
 * Each script becomes one self-contained file, so nothing it runs is read from
 * the checkout afterwards. Packages with native parts stay external and load
 * from the server's own `node_modules` in the build output.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	BUILT_HOST_SCRIPTS,
	builtScriptName,
	HOST_SCRIPTS_DIR,
	HOST_SCRIPTS_MANIFEST,
	HOST_SCRIPTS_MANIFEST_VERSION,
	type HostScriptManifest,
	sha256Hex,
} from "../packages/daemon/src/containment/host-script.ts";
import { buildStampFor, stampDefine } from "./build-stamp.ts";

const EXTERNAL = ["@libsql/*", "libsql"];

/** Build into `outputDir` (an `.output`), replacing any earlier copies whole. */
export async function buildHostScripts(
	repoRoot: string,
	outputDir: string,
): Promise<HostScriptManifest> {
	const finalDir = join(outputDir, HOST_SCRIPTS_DIR);
	const stagingDir = `${finalDir}.staging-${process.pid}`;
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	try {
		const scripts: Record<string, string> = {};
		// The same stamp as the server bundle: a copied build knows it is one.
		const define = stampDefine(buildStampFor(repoRoot, "bundle"));
		for (const script of BUILT_HOST_SCRIPTS) {
			const built = await Bun.build({
				entrypoints: [join(repoRoot, script.fromRoot)],
				target: "bun",
				format: "esm",
				minify: false,
				sourcemap: "none",
				external: EXTERNAL,
				define,
			});
			const output = built.outputs[0];
			if (!built.success || built.outputs.length !== 1 || !output) {
				throw new Error(
					`could not bundle ${script.fromRoot}: ${built.logs.join("\n")}`,
				);
			}
			const bytes = new Uint8Array(await output.arrayBuffer());
			const name = builtScriptName(script);
			writeFileSync(join(stagingDir, name), bytes, { mode: 0o444 });
			scripts[name] = sha256Hex(bytes);
		}
		const manifest: HostScriptManifest = {
			version: HOST_SCRIPTS_MANIFEST_VERSION,
			scripts,
		};
		writeFileSync(
			join(stagingDir, HOST_SCRIPTS_MANIFEST),
			`${JSON.stringify(manifest, null, 2)}\n`,
			{ mode: 0o444 },
		);
		rmSync(finalDir, { recursive: true, force: true });
		renameSync(stagingDir, finalDir);
		return manifest;
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	// An explicit output directory is for the build's own regression test.
	const output = process.argv[2]
		? resolve(process.argv[2])
		: join(root, "apps/start/.output");
	const manifest = await buildHostScripts(root, output);
	console.log(
		`host scripts: ${Object.keys(manifest.scripts).length} built with a hash manifest`,
	);
}
