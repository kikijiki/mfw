/**
 * Writes THIRD_PARTY_NOTICES.txt: the name, version, licence and full licence
 * text of every third-party package the app's production dependency closure
 * pulls in (the vendored fonts among them), grouped by identical licence text.
 *
 *   bun run tools/third-party-notices.ts <out-file>...
 *
 * `apps/start`'s `build` runs it so the notices sit in the build output
 * (`.output/THIRD_PARTY_NOTICES.txt`). Workspace packages (`@mfw/*`) are this project, not third party.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Dep {
	name: string;
	version: string;
	license: string;
	text: string;
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|$)/i;

interface Pkg {
	name: string;
	version: string;
	license?: unknown;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	workspaces?: unknown;
}

function readPkg(dir: string): Pkg | null {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg;
	} catch {
		return null;
	}
}

/** The nearest `node_modules/<name>` from `from` upward, like Node resolution. */
function findPackageDir(name: string, from: string): string | null {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(dir) === dir) return null;
	}
}

function licenseName(pkg: Pkg): string {
	const l = pkg.license;
	if (typeof l === "string") return l;
	if (l && typeof l === "object" && "type" in l)
		return String((l as { type: unknown }).type);
	return "UNKNOWN";
}

function licenseText(dir: string): string {
	const files = readdirSync(dir)
		.filter((f) => LICENSE_FILE.test(f))
		.sort();
	return files
		.map((f) => readFileSync(join(dir, f), "utf8").trim())
		.join("\n\n")
		.trim();
}

/** Production closure of `appDir`'s dependencies; workspace packages are walked, not listed. */
export function collect(appDir: string): Dep[] {
	const seen = new Set<string>();
	const out: Dep[] = [];
	const visit = (linked: string, listed: boolean) => {
		// The isolated linker symlinks packages; a package's own dependencies sit
		// beside its real directory, so resolve from there.
		const dir = realpathSync(linked);
		const pkg = readPkg(dir);
		if (!pkg) return;
		const key = `${pkg.name}@${pkg.version}`;
		if (seen.has(key)) return;
		seen.add(key);
		const workspace = pkg.name.startsWith("@mfw/") || !listed;
		if (!workspace) {
			out.push({
				name: pkg.name,
				version: pkg.version,
				license: licenseName(pkg),
				text: licenseText(dir),
			});
		}
		const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
		for (const dep of Object.keys(deps)) {
			const found = findPackageDir(dep, dir);
			if (found) visit(found, true);
		}
	};
	visit(resolve(appDir), false);
	return out.sort(
		(a, b) =>
			a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
	);
}

export function render(deps: readonly Dep[]): string {
	const groups = new Map<string, Dep[]>();
	for (const d of deps) {
		const key = createHash("sha256")
			.update(`${d.license}\n${d.text}`)
			.digest("hex");
		groups.set(key, [...(groups.get(key) ?? []), d]);
	}
	const parts = [
		"THIRD-PARTY NOTICES",
		"",
		"mfw bundles the third-party packages below, including the fonts the UI",
		"ships (IBM Plex, JetBrains Mono, Archivo, Figtree and Source Sans 3, under",
		"the SIL Open Font License 1.1). Each is used under the licence shown.",
		"Packages with the same licence text are listed together.",
	];
	for (const group of [...groups.values()].sort((a, b) =>
		(a[0]?.name ?? "").localeCompare(b[0]?.name ?? ""),
	)) {
		const first = group[0];
		if (!first) continue;
		parts.push(
			"",
			"=".repeat(72),
			"",
			...group.map((d) => `${d.name}@${d.version} (${d.license})`),
			"",
			first.text ||
				`(no licence file shipped; declared licence: ${first.license})`,
		);
	}
	return `${parts.join("\n")}\n`;
}

if (import.meta.main) {
	const outs = process.argv.slice(2);
	if (outs.length === 0) {
		console.error("usage: third-party-notices.ts <out-file>...");
		process.exit(2);
	}
	const text = render(collect(join(import.meta.dir, "..", "apps", "start")));
	for (const out of outs) {
		await mkdir(dirname(resolve(out)), { recursive: true });
		await writeFile(out, text);
	}
}
