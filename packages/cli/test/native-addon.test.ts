import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadNativeAddon, type NativeIo } from "../src/native-addon.ts";

const BYTES = new TextEncoder().encode("not really a shared object");
const SHA = createHash("sha256").update(BYTES).digest("hex");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(over: Partial<NativeIo> = {}) {
	const tmp = mkdtempSync(join(tmpdir(), "mfw-native-test-"));
	dirs.push(tmp);
	const loaded: { path: string; bytes: string; mode: number }[] = [];
	const value: NativeIo = {
		read: () => BYTES,
		tmp: () => tmp,
		dlopen: (m, path) => {
			loaded.push({
				path,
				bytes: readFileSync(path, "utf8"),
				mode: statSync(path).mode & 0o777,
			});
			(m as { exports: unknown }).exports = { loaded: true };
		},
		...over,
	};
	return { value, loaded, tmp };
}

describe("the embedded libsql addon", () => {
	test("is checked, loaded from a private copy, and the copy is removed", () => {
		const t = io();
		expect(
			loadNativeAddon({ file: "/$bunfs/root/x.node", sha256: SHA }, t.value),
		).toEqual({
			loaded: true,
		});
		const [first] = t.loaded;
		expect(first?.bytes).toBe("not really a shared object");
		expect(first?.mode).toBe(0o500);
		expect(dirname(dirname(first?.path ?? ""))).toBe(t.tmp);
		expect(existsSync(first?.path ?? "")).toBe(false);
		expect(readdirSync(t.tmp)).toEqual([]);
	});

	test("bytes that do not match the build's hash are never loaded", () => {
		const t = io();
		expect(() =>
			loadNativeAddon({ file: "x", sha256: "0".repeat(64) }, t.value),
		).toThrow(/does not match the hash recorded at build/);
		expect(t.loaded).toEqual([]);
		expect(readdirSync(t.tmp)).toEqual([]);
	});

	test("an unwritable temp directory is a clear error, with no fallback", () => {
		const t = io({ tmp: () => "/nonexistent/mfw-tmp" });
		expect(() => loadNativeAddon({ file: "x", sha256: SHA }, t.value)).toThrow(
			/no private directory under \/nonexistent\/mfw-tmp.*TMPDIR/,
		);
		expect(t.loaded).toEqual([]);
	});

	test("a load that fails, such as from a noexec TMPDIR, names that cause and the fix", () => {
		const t = io({
			dlopen: () => {
				throw new Error("failed to map segment from shared object");
			},
		});
		expect(() => loadNativeAddon({ file: "x", sha256: SHA }, t.value)).toThrow(
			/failed to map segment.*mounted noexec, point TMPDIR/,
		);
		expect(readdirSync(t.tmp)).toEqual([]);
	});

	test("a failing load still removes the copy", () => {
		const t = io({
			dlopen: () => {
				throw new Error("bad elf");
			},
		});
		expect(() => loadNativeAddon({ file: "x", sha256: SHA }, t.value)).toThrow(
			"bad elf",
		);
		expect(readdirSync(t.tmp)).toEqual([]);
	});
});
