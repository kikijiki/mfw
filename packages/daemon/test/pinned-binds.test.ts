import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openPinnedBinds,
	type PinnedBind,
	PinnedBindError,
} from "../src/containment/pinned-binds.ts";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pinned-binds-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const bind = (source: string, fd = 5): PinnedBind => ({
	fd,
	source,
	dest: "/work",
	writable: true,
	label: "workspace",
});

const openFds = () => readdirSync("/proc/self/fd").length;

describe("openPinnedBinds", () => {
	test("pins a real directory, in bind order", () => {
		const a = join(root, "a");
		const b = join(root, "b");
		mkdirSync(a);
		mkdirSync(b);
		const pins = openPinnedBinds([bind(a, 5), bind(b, 6)]);
		try {
			expect(
				pins.parentFds.map((fd) => readlinkSync(`/proc/self/fd/${fd}`)),
			).toEqual([a, b]);
		} finally {
			pins.close();
		}
	});

	test("the pin follows the directory through a rename", () => {
		const a = join(root, "a");
		mkdirSync(a);
		const pins = openPinnedBinds([bind(a)]);
		try {
			renameSync(a, join(root, "moved"));
			const fd = pins.parentFds[0] as number;
			expect(readlinkSync(`/proc/self/fd/${fd}`)).toBe(join(root, "moved"));
		} finally {
			pins.close();
		}
	});

	test("refuses a final symlink", () => {
		const real = join(root, "real");
		mkdirSync(real);
		symlinkSync(real, join(root, "link"));
		expect(() => openPinnedBinds([bind(join(root, "link"))])).toThrow(
			PinnedBindError,
		);
	});

	test("refuses a swapped parent, which O_NOFOLLOW alone would miss", () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(join(elsewhere, "child"), { recursive: true });
		symlinkSync(elsewhere, join(root, "parent"));
		expect(() => openPinnedBinds([bind(join(root, "parent/child"))])).toThrow(
			"resolved to",
		);
	});

	test("refuses a file and a missing path", () => {
		writeFileSync(join(root, "file"), "x");
		expect(() => openPinnedBinds([bind(join(root, "file"))])).toThrow(
			PinnedBindError,
		);
		expect(() => openPinnedBinds([bind(join(root, "missing"))])).toThrow(
			PinnedBindError,
		);
	});

	test("a failure part way through leaves no descriptor open", () => {
		const good = join(root, "good");
		mkdirSync(good);
		const before = openFds();
		expect(() =>
			openPinnedBinds([bind(good, 5), bind(join(root, "missing"), 6)]),
		).toThrow(PinnedBindError);
		expect(openFds()).toBe(before);
	});

	test("close releases every descriptor and is safe to repeat", () => {
		const a = join(root, "a");
		mkdirSync(a);
		const before = openFds();
		const pins = openPinnedBinds([bind(a)]);
		expect(openFds()).toBe(before + 1);
		pins.close();
		pins.close();
		expect(openFds()).toBe(before);
	});
});
