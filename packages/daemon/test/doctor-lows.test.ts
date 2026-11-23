import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import {
	installRootFrom,
	liveDoctorProbes,
} from "../src/doctor/live-probes.ts";
import { isPublicForgeUrl, remoteHost, runDoctor } from "../src/doctor/run.ts";
import { loadTriggerDefs } from "../src/triggers/def.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-lows-")));
	dirs.push(d);
	return d;
};

describe("L1: public-forge detection", () => {
	test("the reviewer's case: a password containing @", () => {
		expect(remoteHost("https://bot:p@ss@github.com/o/r.git")).toBe(
			"github.com",
		);
		expect(isPublicForgeUrl("https://bot:p@ss@github.com/o/r.git")).toBe(true);
	});

	test("a password containing a slash", () => {
		expect(remoteHost("https://bot:pa/ss@gitlab.com/o/r.git")).toBe(
			"gitlab.com",
		);
	});

	test("the SSH-over-443 hosts count", () => {
		expect(isPublicForgeUrl("ssh://git@ssh.github.com:443/o/r.git")).toBe(true);
		expect(isPublicForgeUrl("ssh://git@altssh.gitlab.com:443/o/r.git")).toBe(
			true,
		);
	});

	test("a port is not part of the host", () => {
		expect(remoteHost("https://github.com:443/o/r.git")).toBe("github.com");
		expect(remoteHost("https://git.internal:8443/o/r.git")).toBe(
			"git.internal",
		);
	});

	test("a forge name in the path of another host does not count", () => {
		expect(isPublicForgeUrl("https://git.internal/github.com/r.git")).toBe(
			false,
		);
	});
});

describe("L6: the install root", () => {
	test("the production bundle is recognised", () => {
		const url = pathToFileURL(
			"/opt/mfw/apps/start/.output/server/chunks/x.mjs",
		).href;
		expect(installRootFrom(url)).toBe("/opt/mfw");
	});

	test("the source tree is recognised", () => {
		const url = pathToFileURL(
			"/opt/mfw/packages/daemon/src/doctor/live-probes.ts",
		).href;
		expect(installRootFrom(url)).toBe("/opt/mfw");
	});

	test("the reviewer's case: a bundle elsewhere is not called source", () => {
		for (const path of [
			"/opt/mfw/lib/server/index.mjs",
			"/nix/store/abc-mfw/share/server/chunks/x.mjs",
		]) {
			expect(installRootFrom(pathToFileURL(path).href)).toBeNull();
		}
	});

	test("an unrecognised layout is a blocker, not a pass", async () => {
		const d = tmp();
		const report = await runDoctor(
			liveDoctorProbes({ env: { PATH: "" }, home: d, installRoot: null }),
		);
		const c = report.checks.find((x) => x.id === "install.build");
		expect([c?.status, c?.severity]).toEqual(["problem", "blocker"]);
		expect(c?.detail).toContain("not recognised");
	});
});

describe("L7: the doctor's trigger load makes no write attempt", () => {
	test("a missing directory stays missing", async () => {
		const dir = join(tmp(), "triggers");
		const r = await loadTriggerDefs(dir, pino({ level: "silent" }), {
			create: false,
		});
		expect(r.defs).toEqual([]);
		expect(existsSync(dir)).toBe(false);
	});

	test("the daemon's default still creates it", async () => {
		const dir = join(tmp(), "triggers");
		await loadTriggerDefs(dir, pino({ level: "silent" }));
		expect(existsSync(dir)).toBe(true);
	});

	test("the doctor passes create: false", () => {
		const source = readFileSync(
			join(import.meta.dir, "../src/doctor/live-probes.ts"),
			"utf8",
		);
		expect(source).toMatch(/loadTriggerDefs\([\s\S]{0,80}create: false/);
	});
});
