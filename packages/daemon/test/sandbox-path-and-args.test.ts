import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { liveTrustIo, trustedPathEntries } from "../src/sandbox.ts";
import { fakeHome, installCleanup } from "./support/review-fixes.ts";

/** Security review X7: a host tool is never resolved from a run-writable PATH entry. */

installCleanup();

describe("X7: trusted PATH entries", () => {
	test("an entry in a writable root is dropped, and the rest keep their order", async () => {
		const { base, home, mk } = await fakeHome();
		const planted = join(home, "bin");
		mkdirSync(planted, { recursive: true });
		const a = realpathSync(mk("a"));
		const b = realpathSync(mk("b"));
		// The fixture tree is the test user's, so it is presented as root-owned to
		// isolate the writable-root rule.
		const real = liveTrustIo();
		const io = {
			...real,
			lstat: (p: string) => {
				const st = real.lstat(p);
				return st && { ...st, uid: 0, mode: st.mode & ~0o1022 };
			},
			rootUids: new Set([0]),
		};
		expect(
			trustedPathEntries(
				`${planted}:${a}:relative:${b}:${a}`,
				[realpathSync(home)],
				io,
			),
		).toEqual([a, b]);
		expect(a.startsWith(realpathSync(base))).toBe(true);
	});
});
