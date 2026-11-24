import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

describe("the units' tool path", () => {
	test("the systemd unit sets a PATH, since a user manager's is minimal", async () => {
		const unit = await readFile(
			resolve(root, "packaging/mfw-server.service"),
			"utf8",
		);
		const path = unit.match(/^Environment=PATH=(.+)$/m)?.[1];
		expect(path).toBeDefined();
		expect(path?.split(":")).toContain("/usr/bin");
	});

	test("the home-manager unit puts bun, tmux and bubblewrap on its PATH", async () => {
		const nix = await readFile(
			resolve(root, "packaging/mfw.home-manager.nix"),
			"utf8",
		);
		for (const tool of ["pkgs.bun", "pkgs.tmux", "pkgs.bubblewrap"]) {
			expect(nix).toContain(tool);
		}
		expect(nix).toContain('"PATH=${binPath}');
	});

	test("the home-manager unit rebuilds an output with no host script manifest", async () => {
		const nix = await readFile(
			resolve(root, "packaging/mfw.home-manager.nix"),
			"utf8",
		);
		expect(nix).toContain("host-scripts/manifest.json");
	});

	test("the production build bundles the migrations and the unit rebuilds without them", async () => {
		const [nix, pkg] = await Promise.all([
			readFile(resolve(root, "packaging/mfw.home-manager.nix"), "utf8"),
			readFile(resolve(root, "apps/start/package.json"), "utf8"),
		]);
		expect(nix).toContain("server/migrations/manifest.json");
		expect(JSON.parse(pkg).scripts.build).toContain(
			"tools/build-migrations.ts",
		);
	});
});

describe("the compiled install in packaging", () => {
	test("the home-manager unit runs `mfw server` from a package, and the checkout only without one", async () => {
		const nix = await readFile(
			resolve(root, "packaging/mfw.home-manager.nix"),
			"utf8",
		);
		expect(nix).toContain('cfg.package}/bin/mfw server"');
		expect(nix).toContain("lib.mkIf (!compiled)");
		expect(nix).toContain("lib.types.nullOr lib.types.package");
	});

	test("the flake's module defaults to the flake's compiled package", async () => {
		const flake = await readFile(resolve(root, "flake.nix"), "utf8");
		expect(flake).toContain("homeManagerModules.default");
		expect(flake).toContain("services.mfw-server.package");
		expect(flake).toContain("./packaging/nix/mfw.nix");
	});

	test("the Nix package keeps the compiled executables intact and records its runtime in place", async () => {
		const pkg = await readFile(resolve(root, "packaging/nix/mfw.nix"), "utf8");
		for (const flag of [
			"dontStrip = true",
			"dontPatchELF = true",
			"dontFixup = true",
		]) {
			expect(pkg).toContain(flag);
		}
		expect(pkg).toContain("--runtime-in-place --skip-build");
		expect(pkg).toContain("--frozen-lockfile --ignore-scripts");
	});

	// Security review REL-1 M4: the placeholder hash must fail loudly, never quietly.
	test("a placeholder node_modules hash warns with the command that computes the real one", async () => {
		const [pkg, flake, doc] = await Promise.all([
			readFile(resolve(root, "packaging/nix/mfw.nix"), "utf8"),
			readFile(resolve(root, "flake.nix"), "utf8"),
			readFile(resolve(root, "docs/install.md"), "utf8"),
		]);
		expect(pkg).toContain("nodeModulesHash == lib.fakeHash");
		expect(pkg).toContain("lib.warn");
		expect(pkg).toContain("outputHash = checkedHash;");
		expect(pkg).toContain("passthru = {inherit nodeModules;};");
		const command = "nix build .#mfw.nodeModules 2>&1 | grep 'got:'";
		for (const text of [pkg, flake, doc]) expect(text).toContain(command);
	});

	test("the home-manager unit is hardened without touching its PATH", async () => {
		const nix = await readFile(
			resolve(root, "packaging/mfw.home-manager.nix"),
			"utf8",
		);
		for (const line of [
			'UMask = "0077";',
			"NoNewPrivileges = true;",
			'ProtectSystem = "full";',
			"RestrictSUIDSGID = true;",
		]) {
			expect(nix).toContain(line);
		}
	});

	test("the plain unit documents the compiled ExecStart", async () => {
		const unit = await readFile(
			resolve(root, "packaging/mfw-server.service"),
			"utf8",
		);
		expect(unit).toContain("#   ExecStart=/opt/mfw/bin/mfw server");
	});
});

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
		expect(service).toContain("#Environment=MFW_LISTEN_SOCKET=");
		expect(service).not.toContain("MFW_TRUSTED_PROXIES=127.0.0.1");
		expect(homeManager).toContain('# "MFW_LISTEN_SOCKET=');
		expect(homeManager).not.toContain("MFW_TRUSTED_PROXIES=127.0.0.1");
		for (const text of [service, homeManager, exposure])
			expect(text).toContain("tailscale serve --bg --https=8443 unix:");
	});
});
