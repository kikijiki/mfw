import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolSkipReason } from "./support/dev-env-fixture.ts";
import { liveGate } from "./support/live-gate.ts";

/**
 * The dev environment's live suites need direnv and mise on PATH. A host
 * without them must get a precise reason (a skip, or a failure under
 * MFW_REQUIRE_LIVE_NIX=1), never a cryptic assertion about a refused resolve.
 */

/** A fake root with `names` in its /usr/bin, a system toolchain root. */
const withBin = (
	names: string[],
	run: (path: string, fixture: { root: string; home: string }) => void,
) => {
	const dir = mkdtempSync(join(tmpdir(), "mfw-tools-"));
	try {
		const bin = join(dir, "usr/bin");
		mkdirSync(bin, { recursive: true });
		mkdirSync(join(dir, "home/u"), { recursive: true });
		for (const n of names) {
			writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n");
			chmodSync(join(bin, n), 0o755);
		}
		run("/usr/bin", { root: dir, home: "/home/u" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("toolSkipReason", () => {
	test("names the missing tool and how to get it", () => {
		withBin(["direnv"], (path, fx) => {
			expect(toolSkipReason(["direnv", "mise"], path, fx)).toBe(
				"mise is not on PATH: add it to your environment (nix shell nixpkgs#mise nixpkgs#direnv, or the repo dev shell) or unset MFW_REQUIRE_LIVE_NIX",
			);
		});
	});

	test("is null when every tool resolves", () => {
		withBin(["direnv", "mise"], (path, fx) => {
			expect(toolSkipReason(["direnv", "mise"], path, fx)).toBeNull();
		});
	});

	test("a binary outside the trusted roots is refused with its reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "mfw-tools-"));
		try {
			mkdirSync(join(dir, "opt/bin"), { recursive: true });
			mkdirSync(join(dir, "home/u"), { recursive: true });
			writeFileSync(join(dir, "opt/bin/mise"), "#!/bin/sh\n");
			chmodSync(join(dir, "opt/bin/mise"), 0o755);
			const reason = toolSkipReason(["mise"], "/opt/bin", {
				root: dir,
				home: "/home/u",
			});
			expect(reason).toStartWith("mise on PATH is not a trusted binary (");
			expect(reason).toContain("outside the system, Nix and HOME");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("lists every missing tool", () => {
		withBin([], (path, fx) => {
			expect(toolSkipReason(["direnv", "mise"], path, fx)).toStartWith(
				"direnv and mise are not on PATH:",
			);
		});
	});

	test("under MFW_REQUIRE_LIVE_NIX=1 a missing tool fails with that reason", () => {
		const saved = process.env.MFW_REQUIRE_LIVE_NIX;
		process.env.MFW_REQUIRE_LIVE_NIX = "1";
		try {
			withBin([], (path, fx) => {
				expect(() =>
					liveGate("t", toolSkipReason(["mise"], path, fx), "nix"),
				).toThrow(
					"MFW_REQUIRE_LIVE_NIX is set, but mise is not on PATH: add it",
				);
			});
		} finally {
			if (saved === undefined) delete process.env.MFW_REQUIRE_LIVE_NIX;
			else process.env.MFW_REQUIRE_LIVE_NIX = saved;
		}
	});

	test("without the flag the same reason is returned for a skip", () => {
		const saved = process.env.MFW_REQUIRE_LIVE_NIX;
		delete process.env.MFW_REQUIRE_LIVE_NIX;
		try {
			withBin([], (path, fx) => {
				const reason = toolSkipReason(["mise"], path, fx);
				expect(liveGate("t", reason, "nix")).toBe(reason);
			});
		} finally {
			if (saved !== undefined) process.env.MFW_REQUIRE_LIVE_NIX = saved;
		}
	});
});
