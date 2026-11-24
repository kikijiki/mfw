import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	installRuntime,
	type RuntimePin,
	readPin,
	zipMember,
} from "../../../tools/fetch-bun-runtime.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "mfw-runtime-pin-"));
	dirs.push(d);
	return d;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A zip like bun's release asset, made by Python's zipfile (no zip tool needed). */
function makeZip(
	dir: string,
	members: Record<string, string>,
): Uint8Array | null {
	const python = Bun.which("python3");
	if (!python) return null;
	const out = join(dir, "bun.zip");
	const script = [
		"import sys, zipfile, json",
		"members = json.loads(sys.argv[2])",
		"with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
		"    [z.writestr(n, d) for n, d in members.items()]",
	].join("\n");
	const r = Bun.spawnSync([
		python,
		"-I",
		"-c",
		script,
		out,
		JSON.stringify(members),
	]);
	return r.exitCode === 0 ? readFileSync(out) : null;
}

describe("the pinned bun runtime", () => {
	test("the pin names the bun CI runs, with a checked hash for linux-x64", () => {
		const pin = readPin(join(ROOT, "packaging/bun-runtime.json"));
		const ci = readFileSync(
			join(ROOT, ".github/workflows/ci-check.yml"),
			"utf8",
		);
		expect(ci).toContain(`bun-version: ${pin.version}`);
		expect(pin.releaseUrl).toBe(
			`https://github.com/oven-sh/bun/releases/download/bun-v${pin.version}`,
		);
		expect(pin.targets["bun-linux-x64"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	const python = Bun.which("python3");
	test.skipIf(!python)(
		"a zip that matches the pin is unpacked read-only",
		() => {
			const dir = tmp();
			const zip = makeZip(dir, {
				"bun-x/bun": "#!fake bun\n".repeat(500),
				"bun-x/LICENSE": "l",
			});
			expect(zip).not.toBeNull();
			const pin: RuntimePin = {
				version: "9.9.9",
				releaseUrl: "https://example.invalid",
				targets: {
					t: {
						asset: "bun.zip",
						member: "bun-x/bun",
						sha256: sha(zip as Uint8Array),
					},
				},
			};
			const out = join(dir, "bun");
			const bunSha = installRuntime(zip as Uint8Array, pin, "t", out);
			expect(readFileSync(out, "utf8")).toBe("#!fake bun\n".repeat(500));
			expect(bunSha).toBe(sha(readFileSync(out)));
			expect(statSync(out).mode & 0o777).toBe(0o555);
			expect(
				new TextDecoder().decode(zipMember(zip as Uint8Array, "bun-x/LICENSE")),
			).toBe("l");
		},
	);

	test.skipIf(!python)(
		"a zip that does not match is refused before anything is written",
		() => {
			const dir = tmp();
			const zip = makeZip(dir, { "bun-x/bun": "other" }) as Uint8Array;
			const pin: RuntimePin = {
				version: "9.9.9",
				releaseUrl: "https://example.invalid",
				targets: {
					t: { asset: "bun.zip", member: "bun-x/bun", sha256: "0".repeat(64) },
				},
			};
			const out = join(dir, "bun");
			expect(() => installRuntime(zip, pin, "t", out)).toThrow(
				/refusing: bun.zip has sha256/,
			);
			expect(() => statSync(out)).toThrow();
			expect(() => installRuntime(zip, pin, "other", out)).toThrow(
				/no pinned bun/,
			);
			expect(() => zipMember(zip, "missing")).toThrow(/has no missing/);
			writeFileSync(join(dir, "x"), "not a zip");
			expect(() => zipMember(readFileSync(join(dir, "x")), "a")).toThrow(
				/not a zip/,
			);
		},
	);
});
