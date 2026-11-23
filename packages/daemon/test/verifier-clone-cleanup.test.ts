import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../src/git.ts";
import { removeTree } from "../src/run-workspace/remove-tree.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";

/**
 * Security review P7, M1 (X2): `chmod 000` inside a clone made it undeletable,
 * kept its pin, and stopped the startup sweep on every later boot.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) {
		await removeTree(d);
		await rm(d, { recursive: true, force: true });
	}
});

async function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-m1-")));
	dirs.push(root);
	const primary = join(root, "primary");
	mkdirSync(primary);
	await git(["init", "-q", "-b", "main"], primary);
	await git(["config", "user.email", "t@t"], primary);
	await git(["config", "user.name", "t"], primary);
	writeFileSync(join(primary, "a.txt"), "a\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "init"], primary);
	const sha = (await git(["rev-parse", "HEAD"], primary)).stdout.trim();
	const workspaces = join(root, "home", "workspaces");
	const clones = new VerifierClones({
		workspaceRoot: workspaces,
		primaryRoot: primary,
	});
	return { root, primary, sha, workspaces, clones };
}

const pins = async (primary: string) =>
	(await git(["for-each-ref", "refs/mfw/verify/"], primary)).stdout.trim();

/** What a hostile check leaves behind. */
function poison(tree: string): void {
	mkdirSync(join(tree, "locked/deep/deeper"), { recursive: true });
	writeFileSync(join(tree, "locked/deep/deeper/f"), "x");
	chmodSync(join(tree, "locked/deep/deeper"), 0o000);
	chmodSync(join(tree, "locked/deep"), 0o000);
	chmodSync(join(tree, "locked"), 0o000);
}

describe("removing a clone a check tampered with", () => {
	test("dispose removes it and always deletes its pin", async () => {
		const t = await setup();
		const c = await t.clones.create(t.sha, "poisoned");
		poison(c.path);
		await c.dispose();
		expect(existsSync(dirname(c.path))).toBe(false);
		expect(await pins(t.primary)).toBe("");
	});

	test("the pin goes even when the directory cannot be removed", async () => {
		const t = await setup();
		const c = await t.clones.create(t.sha, "stuck");
		// A parent the owner cannot write stops the removal itself.
		chmodSync(t.workspaces, 0o500);
		try {
			await c.dispose().catch(() => undefined);
			expect(await pins(t.primary)).toBe("");
		} finally {
			chmodSync(t.workspaces, 0o700);
		}
	});

	test("one poisoned clone does not stop the startup sweep", async () => {
		const t = await setup();
		const first = await t.clones.create(t.sha, "a-poisoned");
		const second = await t.clones.create(t.sha, "b-plain");
		poison(first.path);
		const removed = await t.clones.sweep();
		expect(removed).toBe(2);
		expect(existsSync(dirname(first.path))).toBe(false);
		expect(existsSync(dirname(second.path))).toBe(false);
		expect(await pins(t.primary)).toBe("");
	});

	test("the walk never follows a link out of the tree", async () => {
		const t = await setup();
		const outside = join(t.root, "outside");
		mkdirSync(join(outside, "sub"), { recursive: true });
		writeFileSync(join(outside, "sub/keep"), "keep\n");
		chmodSync(join(outside, "sub"), 0o500);
		const c = await t.clones.create(t.sha, "linked");
		symlinkSync(outside, join(c.path, "out"));
		symlinkSync(join(outside, "sub"), join(c.path, "sub-link"));
		await c.dispose();
		expect(existsSync(dirname(c.path))).toBe(false);
		expect(statSync(join(outside, "sub")).mode & 0o777).toBe(0o500);
		expect(existsSync(join(outside, "sub/keep"))).toBe(true);
		chmodSync(join(outside, "sub"), 0o700);
	});

	test("removeTree reports what it could not remove and keeps going", async () => {
		const t = await setup();
		const parent = join(t.root, "held");
		mkdirSync(join(parent, "x"), { recursive: true });
		chmodSync(parent, 0o500);
		const failed = await removeTree(join(parent, "x"));
		expect(failed.length).toBeGreaterThan(0);
		chmodSync(parent, 0o700);
		expect(await removeTree(join(parent, "x"))).toEqual([]);
		expect(existsSync(join(parent, "x"))).toBe(false);
	});
});
