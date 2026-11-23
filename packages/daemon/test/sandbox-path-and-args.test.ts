import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { trustedPathEntries } from "../src/sandbox.ts";
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
		expect(
			trustedPathEntries(`${planted}:${a}:relative:${b}:${a}`, [
				realpathSync(home),
			]),
		).toEqual([a, b]);
		expect(a.startsWith(realpathSync(base))).toBe(true);
	});
});
