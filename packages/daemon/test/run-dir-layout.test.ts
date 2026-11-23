import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	driverRunPaths,
	ensureRunDirLayout,
	isSplitRunDir,
	RunDirLayoutError,
	runEventsPath,
	runStateRoot,
	verifyRunDirLayout,
} from "../src/containment/run-dir.ts";

const made: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "mfw-run-dir-"));
	made.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("run dir layout", () => {
	test("creates a private root with control and outbox", () => {
		const root = join(tmp(), "run");
		const layout = ensureRunDirLayout(root);
		for (const path of [layout.root, layout.control, layout.outbox]) {
			expect(statSync(path).mode & 0o777).toBe(0o700);
		}
		expect(isSplitRunDir(root)).toBe(true);
	});

	test("tightens a root the registry created with a default mode", () => {
		const root = join(tmp(), "run");
		mkdirSync(root, { mode: 0o755 });
		chmodSync(root, 0o755);
		ensureRunDirLayout(root);
		expect(statSync(root).mode & 0o777).toBe(0o700);
	});

	test("is idempotent and keeps existing contents", () => {
		const root = join(tmp(), "run");
		const { control } = ensureRunDirLayout(root);
		writeFileSync(join(control, "exit"), "exit:3");
		ensureRunDirLayout(root);
		expect(Bun.file(join(control, "exit")).size).toBe(6);
	});

	for (const name of ["control", "outbox"]) {
		test(`refuses a planted ${name} symlink and leaves its target alone`, () => {
			const base = tmp();
			const root = join(base, "run");
			const target = join(base, "target");
			mkdirSync(root);
			mkdirSync(target, { mode: 0o755 });
			chmodSync(target, 0o755);
			symlinkSync(target, join(root, name));
			expect(() => ensureRunDirLayout(root)).toThrow(RunDirLayoutError);
			expect(statSync(target).mode & 0o777).toBe(0o755);
			expect(isSplitRunDir(root)).toBe(false);
		});

		test(`refuses a planted ${name} file`, () => {
			const root = join(tmp(), "run");
			mkdirSync(root);
			writeFileSync(join(root, name), "x");
			expect(() => ensureRunDirLayout(root)).toThrow(RunDirLayoutError);
		});

		test(`verify refuses a group-accessible ${name}`, () => {
			const root = join(tmp(), "run");
			const layout = ensureRunDirLayout(root);
			chmodSync(name === "control" ? layout.control : layout.outbox, 0o770);
			expect(() => verifyRunDirLayout(root)).toThrow(/open to other users/);
		});
	}

	test("verify refuses a root owned by another uid", () => {
		const root = join(tmp(), "run");
		ensureRunDirLayout(root);
		const other = (process.getuid?.() ?? 0) + 1;
		expect(() => verifyRunDirLayout(root, other)).toThrow(/owned by uid/);
	});

	test("finds the project state root only for the real location", () => {
		expect(runStateRoot("/p/.mfw/runs/01ABC")).toBe("/p/.mfw");
		expect(runStateRoot("/p/runs/01ABC")).toBeNull();
		expect(runStateRoot("/tmp/x/run")).toBeNull();
	});

	test("a driver uses the split paths once the host wrote its config there", () => {
		const root = join(tmp(), "run");
		const { control, outbox } = ensureRunDirLayout(root);
		writeFileSync(join(control, "driver.json"), "{}");
		expect(driverRunPaths(root)).toEqual({
			config: join(control, "driver.json"),
			steer: join(control, "steer.jsonl"),
			controls: join(control, "control.jsonl"),
			events: join(outbox, "events.jsonl"),
		});
	});

	test("a driver of an older flat run keeps the flat paths", () => {
		const root = tmp();
		expect(driverRunPaths(root).config).toBe(join(root, "driver.json"));
		expect(driverRunPaths(root).events).toBe(join(root, "events.jsonl"));
	});

	test("events resolve to the outbox, then to the flat path", () => {
		const root = join(tmp(), "run");
		const { outbox } = ensureRunDirLayout(root);
		expect(runEventsPath(root)).toBe(join(root, "events.jsonl"));
		writeFileSync(join(outbox, "events.jsonl"), "");
		expect(runEventsPath(root)).toBe(join(outbox, "events.jsonl"));
	});
});
