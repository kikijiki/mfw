/**
 * Where the project database's migrations come from.
 *
 * A production server applies only the copies built into its own output, each
 * checked against the build's hash manifest at every open. It never reads them
 * from the checkout: an autonomous merge fast-forwards that checkout, so a
 * migration found there would be agent-authored SQL applied at the next boot
 * with no review. A missing manifest, an unlisted file or a changed file is a
 * refusal, and the database is left as it was.
 *
 * From source the migrations beside this package are used; the daemon's
 * `source-run-guard.ts` refuses that when the checkout is itself a project mfw
 * manages, before any project database is opened.
 *
 * It never searches from the working directory or upward: a run's working
 * directory is agent-written, and a planted journal would be applied.
 *
 * Node builtins only. `import.meta.dir` is not used because Vite's dev server
 * does not define it.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Inside the build output, beside the built host scripts. */
export const MIGRATIONS_OUTPUT_DIR = join("server", "migrations");
export const MIGRATIONS_MANIFEST = "manifest.json";
export const MIGRATIONS_MANIFEST_VERSION = 1;

const JOURNAL = "meta/_journal.json";
const LISTED_NAME = /^(?:meta\/_journal\.json|[A-Za-z0-9_-]+\.sql)$/;
const BUNDLE_DIR = `${sep}apps${sep}start${sep}.output${sep}`;
const REBUILD = "Fix: rebuild with `bun run build` and restart the server";

export interface MigrationManifest {
	version: number;
	/** File path inside the migrations directory to the sha256 of its content. */
	files: Record<string, string>;
}

function sha256Hex(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function regularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** The files a migrations directory must ship: its journal and each entry's SQL. */
function journalFiles(sourceDir: string): string[] {
	const journal = JSON.parse(
		readFileSync(join(sourceDir, JOURNAL), "utf8"),
	) as { entries: { tag: string }[] };
	const listed = journal.entries.map((e) => `${e.tag}.sql`);
	for (const name of listed) {
		if (!LISTED_NAME.test(name) || !regularFile(join(sourceDir, name))) {
			throw new Error(`migration journal entry ${name} has no file`);
		}
	}
	const unlisted = readdirSync(sourceDir).filter(
		(f) => f.endsWith(".sql") && !listed.includes(f),
	);
	if (unlisted.length > 0) {
		throw new Error(`migrations not in the journal: ${unlisted.join(", ")}`);
	}
	return [JOURNAL, ...listed];
}

/** Build into `outputDir` (an `.output`), replacing any earlier copy whole. */
export function buildMigrations(
	sourceDir: string,
	outputDir: string,
): MigrationManifest {
	const finalDir = join(outputDir, MIGRATIONS_OUTPUT_DIR);
	const stagingDir = `${finalDir}.staging-${process.pid}`;
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(join(stagingDir, "meta"), { recursive: true });
	try {
		const files: Record<string, string> = {};
		for (const name of journalFiles(sourceDir)) {
			const bytes = readFileSync(join(sourceDir, name));
			writeFileSync(join(stagingDir, name), bytes, { mode: 0o444 });
			files[name] = sha256Hex(bytes);
		}
		const manifest: MigrationManifest = {
			version: MIGRATIONS_MANIFEST_VERSION,
			files,
		};
		writeFileSync(
			join(stagingDir, MIGRATIONS_MANIFEST),
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

function readManifest(dir: string): MigrationManifest {
	const path = join(dir, MIGRATIONS_MANIFEST);
	if (!regularFile(path)) {
		throw new Error(`refusing to migrate: no migration manifest. ${REBUILD}`);
	}
	let parsed: Partial<MigrationManifest>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(
			`refusing to migrate: the migration manifest is unreadable. ${REBUILD}`,
		);
	}
	if (
		parsed.version !== MIGRATIONS_MANIFEST_VERSION ||
		typeof parsed.files !== "object" ||
		parsed.files === null ||
		!Object.hasOwn(parsed.files, JOURNAL) ||
		!Object.keys(parsed.files).every((name) => LISTED_NAME.test(name))
	) {
		throw new Error(
			`refusing to migrate: the migration manifest has the wrong format. ${REBUILD}`,
		);
	}
	return parsed as MigrationManifest;
}

/** Every path under `dir`, relative to it, without following links. */
function walk(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const name = `${prefix}${entry.name}`;
		return entry.isDirectory()
			? walk(join(dir, entry.name), `${name}/`)
			: [name];
	});
}

/** The verified bytes of every listed file, read once. */
function verifiedFiles(dir: string): Map<string, Uint8Array> {
	const manifest = readManifest(dir);
	for (const name of walk(dir)) {
		if (name !== MIGRATIONS_MANIFEST && !Object.hasOwn(manifest.files, name)) {
			throw new Error(
				`refusing to migrate: ${name} is not in the manifest. ${REBUILD}`,
			);
		}
	}
	const out = new Map<string, Uint8Array>();
	for (const [name, expected] of Object.entries(manifest.files)) {
		const path = join(dir, name);
		if (!regularFile(path)) {
			throw new Error(
				`refusing to migrate: the built ${name} is not a regular file. ${REBUILD}`,
			);
		}
		const bytes = readFileSync(path);
		if (sha256Hex(bytes) !== expected) {
			throw new Error(
				`refusing to migrate: the built ${name} does not match its manifest hash. ${REBUILD}`,
			);
		}
		out.set(name, bytes);
	}
	return out;
}

/** The migrations beside this package, for a server running from source. */
export function sourceMigrationsDir(moduleUrl: string): string {
	const override = process.env.MFW_MIGRATIONS_DIR;
	if (override) {
		if (!existsSync(join(override, "meta", "_journal.json"))) {
			throw new Error(
				`MFW_MIGRATIONS_DIR="${override}" has no meta/_journal.json; unset it or point it at packages/db/migrations`,
			);
		}
		return override;
	}
	const beside = join(dirname(fileURLToPath(moduleUrl)), "..", "migrations");
	if (existsSync(join(beside, "meta", "_journal.json"))) return beside;
	throw new Error(
		`cannot locate the migrations from ${moduleUrl}: run the server from its checkout or from a production build`,
	);
}

/**
 * Run `fn` with the folder to migrate from. From a production build that is a
 * private copy of the verified bytes, so nothing can change between the check
 * and the migrator's read; it is removed afterwards.
 */
export async function withVerifiedMigrations<T>(
	moduleUrl: string,
	fn: (folder: string) => Promise<T>,
): Promise<T> {
	const moduleFile = fileURLToPath(moduleUrl);
	const bundle = moduleFile.lastIndexOf(BUNDLE_DIR);
	if (bundle < 0) return fn(sourceMigrationsDir(moduleUrl));
	if (process.env.MFW_MIGRATIONS_DIR) {
		throw new Error(
			"refusing to migrate: MFW_MIGRATIONS_DIR is set, and a production build applies only its own verified migrations. Fix: unset it",
		);
	}
	const output = moduleFile.slice(0, bundle + BUNDLE_DIR.length);
	const files = verifiedFiles(join(output, MIGRATIONS_OUTPUT_DIR));
	// mkdtemp creates the directory private to this user.
	const folder = mkdtempSync(join(tmpdir(), "mfw-migrations-"));
	try {
		mkdirSync(join(folder, "meta"));
		for (const [name, bytes] of files) {
			writeFileSync(join(folder, name), bytes, { mode: 0o400 });
		}
		return await fn(folder);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
