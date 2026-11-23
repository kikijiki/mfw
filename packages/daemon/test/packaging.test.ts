import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("packaged listener safety", () => {
	test("plain systemd binds loopback and documented host controls are real", async () => {
		const [service, homeManager, readme] = await Promise.all([
			readFile(resolve(root, "packaging/mfw-server.service"), "utf8"),
			readFile(resolve(root, "packaging/mfw.home-manager.nix"), "utf8"),
			readFile(resolve(root, "README.md"), "utf8"),
		]);

		expect(service).toContain("Environment=HOST=127.0.0.1");
		expect(service).not.toContain("MFW_HOST");
		expect(homeManager).not.toContain("MFW_HOST");
		expect(readme).not.toContain("MFW_HOST");
		expect(homeManager).toContain('"HOST=127.0.0.1"');
		expect(homeManager).not.toContain("tailscale ip");
		expect(readme).not.toContain("tailscale ip");
	});

	test("trusted-proxy settings stay opt-in and name an exact port", async () => {
		const [service, homeManager, exposure] = await Promise.all([
			readFile(resolve(root, "packaging/mfw-server.service"), "utf8"),
			readFile(resolve(root, "packaging/mfw.home-manager.nix"), "utf8"),
			readFile(resolve(root, "docs/exposure.md"), "utf8"),
		]);
		expect(service).toContain("#Environment=MFW_TRUSTED_PROXIES=127.0.0.1");
		expect(homeManager).toContain('# "MFW_TRUSTED_PROXIES=127.0.0.1"');
		for (const text of [service, homeManager, exposure])
			expect(text).toContain("--https=8443 --set-path /mfw");
	});
});
