import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSocketPathFits,
	ensureSocketRoot,
	SocketPathError,
	socketBase,
	socketRoot,
	UNIX_PATH_MAX,
} from "../src/containment/socket-root.ts";

let scratch: string;
beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "mfw-sr-")));
});
afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("socket directory selection", () => {
	test("prefers $XDG_RUNTIME_DIR, then the temp dir, then /tmp", () => {
		const uid = 1234;
		expect(
			socketBase({ env: { XDG_RUNTIME_DIR: "/run/user/1234" }, uid }),
		).toBe("/run/user/1234/mfw");
		expect(socketBase({ env: {}, uid, tmp: "/var/tmp" })).toBe(
			"/var/tmp/mfw-1234",
		);
		const longTmp = `/${"t".repeat(120)}`;
		expect(socketBase({ env: {}, uid, tmp: longTmp })).toBe("/tmp/mfw-1234");
		const longXdg = `/${"x".repeat(120)}`;
		expect(
			socketBase({ env: { XDG_RUNTIME_DIR: longXdg }, uid, tmp: "/var/tmp" }),
		).toBe("/var/tmp/mfw-1234");
	});

	test("ignores a relative $XDG_RUNTIME_DIR", () => {
		expect(
			socketBase({ env: { XDG_RUNTIME_DIR: "run/user" }, uid: 1, tmp: "/t" }),
		).toBe("/t/mfw-1");
	});

	test("the root does not depend on how long $MFW_HOME is", () => {
		const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
		const short = socketRoot("/h", { env });
		const long = socketRoot(`/${"h".repeat(500)}`, { env });
		expect(long.length).toBe(short.length);
		expect(long).not.toBe(short);
		expect(socketRoot("/h", { env })).toBe(short);
	});

	test("an explicit directory is used as given, and a relative one is refused", () => {
		expect(socketBase({ env: { MFW_SOCKET_DIR: "/s/k" } })).toBe("/s/k");
		expect(() => socketBase({ env: { MFW_SOCKET_DIR: "rel" } })).toThrow(
			SocketPathError,
		);
	});
});

describe("the length limit", () => {
	test("refuses a path over the limit, naming the fix", () => {
		assertSocketPathFits("/".padEnd(UNIX_PATH_MAX, "a"));
		let error: unknown;
		try {
			assertSocketPathFits("/".padEnd(UNIX_PATH_MAX + 1, "a"), "egress socket");
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SocketPathError);
		expect((error as SocketPathError).message).toContain("egress socket");
		expect((error as SocketPathError).message).toContain("MFW_SOCKET_DIR");
	});

	test("an explicit directory too long for the longest socket is refused up front", () => {
		const base = join(scratch, "d".repeat(100));
		expect(() =>
			ensureSocketRoot("/home/x", { env: { MFW_SOCKET_DIR: base } }),
		).toThrow(/MFW_SOCKET_DIR/);
	});
});

describe("ownership", () => {
	const options = () => ({ env: { MFW_SOCKET_DIR: join(scratch, "sock") } });

	test("creates private directories", () => {
		const root = ensureSocketRoot("/home/x", options());
		expect(root).toBe(socketRoot("/home/x", options()));
		for (const dir of [join(scratch, "sock"), root]) {
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		}
		// Idempotent.
		expect(ensureSocketRoot("/home/x", options())).toBe(root);
	});

	test("refuses a base that is open to others", () => {
		mkdirSync(join(scratch, "sock"));
		chmodSync(join(scratch, "sock"), 0o755);
		expect(() => ensureSocketRoot("/home/x", options())).toThrow(/not private/);
	});

	test("refuses a planted link in place of the base", () => {
		const elsewhere = join(scratch, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, join(scratch, "sock"));
		expect(() => ensureSocketRoot("/home/x", options())).toThrow(/not private/);
	});
});
