import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrationsDir } from "../src/client.ts";
import {
	buildMigrations,
	type EmbeddedMigrations,
	embeddableMigrations,
	MIGRATIONS_MANIFEST,
	MIGRATIONS_OUTPUT_DIR,
	registerEmbeddedMigrations,
	verifyEmbeddedMigrations,
	withVerifiedMigrations,
} from "../src/migration-source.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface Built {
	root: string;
	/** A module inside the production build. */
	moduleUrl: string;
	dir: string;
	checkout: string;
}

/** A build output beside a checkout whose migrations an agent could change. */
function built(): Built {
	const root = mkdtempSync(join(tmpdir(), "mfw-migration-source-"));
	roots.push(root);
	const checkout = join(root, "repo/packages/db/migrations");
	mkdirSync(join(root, "repo/packages/db"), { recursive: true });
	cpSync(migrationsDir(), checkout, { recursive: true });
	const output = join(root, "repo/apps/start/.output");
	buildMigrations(checkout, output);
	const chunk = join(output, "server/chunks/db.js");
	mkdirSync(join(output, "server/chunks"), { recursive: true });
	writeFileSync(chunk, "");
	return {
		root,
		checkout,
		moduleUrl: pathToFileURL(chunk).href,
		dir: join(output, MIGRATIONS_OUTPUT_DIR),
	};
}

const applied = (b: Built) =>
	withVerifiedMigrations(b.moduleUrl, async (folder) =>
		JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")),
	);

const firstSql = (dir: string) =>
	readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort()[0] as string;

function writable(path: string): void {
	chmodSync(path, 0o644);
}

describe("a production build migrates only from its verified copy", () => {
	test("an agent-authored migration merged into the checkout is not applied", async () => {
		const b = built();
		const journalPath = join(b.checkout, "meta/_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8"));
		journal.entries.push({
			idx: journal.entries.length,
			version: "6",
			when: Date.now() + 1000,
			tag: "9999_agent",
			breakpoints: true,
		});
		writeFileSync(journalPath, JSON.stringify(journal));
		writeFileSync(join(b.checkout, "9999_agent.sql"), "DROP TABLE runs;");

		const seen = await applied(b);
		expect(seen.entries.map((e: { tag: string }) => e.tag)).not.toContain(
			"9999_agent",
		);
	});

	test("a changed migration is refused", async () => {
		const b = built();
		const file = join(b.dir, firstSql(b.dir));
		writable(file);
		writeFileSync(file, "DROP TABLE runs;");
		await expect(applied(b)).rejects.toThrow(/does not match its manifest/);
	});

	test("a changed journal is refused", async () => {
		const b = built();
		const file = join(b.dir, "meta/_journal.json");
		writable(file);
		writeFileSync(file, '{"version":"7","dialect":"sqlite","entries":[]}');
		await expect(applied(b)).rejects.toThrow(/does not match its manifest/);
	});

	test("a migration added beside the manifest is refused", async () => {
		const b = built();
		chmodSync(b.dir, 0o755);
		writeFileSync(join(b.dir, "9999_agent.sql"), "DROP TABLE runs;");
		await expect(applied(b)).rejects.toThrow(/not in the manifest/);
	});

	test("a symlinked migration is refused", async () => {
		const b = built();
		chmodSync(b.dir, 0o755);
		const file = join(b.dir, firstSql(b.dir));
		rmSync(file);
		symlinkSync(join(b.checkout, firstSql(b.checkout)), file);
		await expect(applied(b)).rejects.toThrow(/not a regular file/);
	});

	test("a build with no manifest is refused, even with the checkout present", async () => {
		const b = built();
		chmodSync(b.dir, 0o755);
		rmSync(join(b.dir, MIGRATIONS_MANIFEST));
		await expect(applied(b)).rejects.toThrow(/no migration manifest/);
	});

	test("the environment override cannot redirect a production build", async () => {
		const b = built();
		const before = process.env.MFW_MIGRATIONS_DIR;
		process.env.MFW_MIGRATIONS_DIR = b.checkout;
		try {
			await expect(applied(b)).rejects.toThrow(/MFW_MIGRATIONS_DIR/);
		} finally {
			if (before === undefined) delete process.env.MFW_MIGRATIONS_DIR;
			else process.env.MFW_MIGRATIONS_DIR = before;
		}
	});

	test("the migrator reads a private copy that is gone afterwards", async () => {
		const b = built();
		let folder = "";
		await withVerifiedMigrations(b.moduleUrl, async (f) => {
			folder = f;
			expect(f.startsWith(b.dir)).toBe(false);
			expect(existsSync(join(f, "meta/_journal.json"))).toBe(true);
		});
		expect(existsSync(folder)).toBe(false);
	});
});

describe("the migration build", () => {
	test("refuses a journal entry with no file and a file with no journal entry", () => {
		const b = built();
		const output = join(b.root, "other/apps/start/.output");
		const orphan = join(b.checkout, "9999_orphan.sql");
		writeFileSync(orphan, "SELECT 1;");
		expect(() => buildMigrations(b.checkout, output)).toThrow(/9999_orphan/);
		rmSync(orphan);
		rmSync(join(b.checkout, firstSql(b.checkout)));
		expect(() => buildMigrations(b.checkout, output)).toThrow(/no file/);
	});

	test("the real chain is complete, ordered, snapshotted and fully listed", () => {
		const source = migrationsDir();
		const journal = JSON.parse(
			readFileSync(join(source, "meta/_journal.json"), "utf8"),
		) as { entries: { idx: number; when: number; tag: string }[] };
		const numbers = journal.entries.map((e) => Number(e.tag.slice(0, 4)));
		// 0011 was never issued; every other number appears once, in order.
		const last = numbers.at(-1) as number;
		const expected = Array.from({ length: last + 1 }, (_, n) => n).filter(
			(n) => n !== 11,
		);
		expect(numbers).toEqual(expected);
		journal.entries.forEach((e, i) => {
			expect(e.idx).toBe(i);
			if (i > 0) {
				expect(e.when).toBeGreaterThan(
					(journal.entries[i - 1] as { when: number }).when,
				);
			}
			const name = e.tag.slice(0, 4);
			expect(existsSync(join(source, "meta", `${name}_snapshot.json`))).toBe(
				true,
			);
		});

		const root = mkdtempSync(join(tmpdir(), "mfw-migration-chain-"));
		roots.push(root);
		const manifest = buildMigrations(source, root);
		expect(Object.keys(manifest.files).sort()).toEqual(
			[
				"meta/_journal.json",
				...journal.entries.map((e) => `${e.tag}.sql`),
			].sort(),
		);
	});
});

describe("a compiled mfw's embedded migrations", () => {
	const real = () => embeddableMigrations(migrationsDir());
	const EMBEDDED = Symbol.for("mfw.embeddedMigrations");
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[EMBEDDED];
	});

	test("carry every journal entry with the build's manifest, and verify", () => {
		const embedded = real();
		const names = Object.keys(embedded.files);
		expect(names).toContain("meta/_journal.json");
		expect(names.filter((n) => n.endsWith(".sql")).length).toBe(
			names.length - 1,
		);
		const manifest = JSON.parse(embedded.manifest);
		expect(Object.keys(manifest.files).sort()).toEqual([...names].sort());
		registerEmbeddedMigrations(embedded);
		expect(Object.keys(verifyEmbeddedMigrations().files).length).toBe(
			names.length,
		);
	});

	test("an executable built without them refuses", () => {
		expect(() => verifyEmbeddedMigrations()).toThrow(/carries no migrations/);
	});

	test("a changed, added or missing file is refused, like a build directory", () => {
		const embedded = real();
		const sql = Object.keys(embedded.files).find((n) =>
			n.endsWith(".sql"),
		) as string;
		const cases: EmbeddedMigrations[] = [
			{ ...embedded, files: { ...embedded.files, [sql]: "DROP TABLE runs;" } },
			{
				...embedded,
				files: { ...embedded.files, "9999_planted.sql": "SELECT 1;" },
			},
			{
				...embedded,
				files: Object.fromEntries(
					Object.entries(embedded.files).filter(([n]) => n !== sql),
				),
			},
			{ ...embedded, manifest: "{" },
		];
		const expected = [
			/does not match its manifest hash/,
			/is not in the manifest/,
			/is not a regular file/,
			/manifest is unreadable/,
		];
		cases.forEach((c, i) => {
			registerEmbeddedMigrations(c);
			expect(() => verifyEmbeddedMigrations()).toThrow(expected[i] as RegExp);
		});
	});

	test("registration is frozen: later code cannot swap a file in", () => {
		registerEmbeddedMigrations(real());
		const stored = (globalThis as Record<symbol, EmbeddedMigrations>)[EMBEDDED];
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(stored?.files)).toBe(true);
	});
});
