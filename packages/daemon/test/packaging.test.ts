import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("packaged listener safety", () => {
	test("plain systemd binds loopback and documented host controls are real", async () => {
		const [service, homeManager, readme] = await Promise.all([
			readFile(resolve(root, "packaging/mfw.service"), "utf8"),
			readFile(resolve(root, "packaging/mfw.home-manager.nix"), "utf8"),
			readFile(resolve(root, "README.md"), "utf8"),
		]);

		expect(service).toContain("Environment=HOST=127.0.0.1");
		expect(service).not.toContain("MFW_HOST");
		expect(homeManager).not.toContain("MFW_HOST");
		expect(readme).not.toContain("MFW_HOST");
		expect(readme).toContain('HOST="$(tailscale ip -4 | head -n1)"');
	});
});
