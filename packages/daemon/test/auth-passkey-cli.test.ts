import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "../src/auth/cli.ts";
import { AuthService, authDbPath } from "../src/auth/service.ts";
import { SoftAuthenticator } from "./support/soft-authenticator.ts";

const PASSWORD = "correct horse battery";
const RP = { rpId: "localhost", origin: "http://localhost:7777" };

let home: string;
let out: string[];
let err: string[];

const run = (...args: string[]) =>
	runAuthCommand(args, {
		home,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mfw-passkey-cli-"));
	out = [];
	err = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

/** An owner with one passkey and a session signed in with it. */
async function seed() {
	const auth = await AuthService.open(authDbPath(home), {
		passwordCheckIntervalMs: 0,
	});
	const owner = await auth.setup(
		(await auth.beginFirstRun()) as string,
		PASSWORD,
	);
	const soft = new SoftAuthenticator(RP.origin);
	const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
		password: PASSWORD,
	});
	const { json } = soft.create(begun.publicKey);
	const info = await auth.finishPasskeyRegistration(
		owner.sessionId,
		RP,
		begun.ceremonyId,
		json,
		"yubi",
	);
	const login = await auth.beginPasskeyLogin(RP);
	const viaPasskey = await auth.passkeyLogin(
		login.ceremonyId,
		soft.get(login.publicKey),
		RP,
	);
	auth.close();
	return { info, owner, viaPasskey };
}

describe("mfw auth passkey", () => {
	test("list shows name, created and last used, never a key", async () => {
		const { info } = await seed();
		expect(await run("passkey", "list")).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain(info.id);
		expect(out[0]).toContain("'yubi'");
		expect(out[0]).toContain("from unknown");
		expect(out[0]).toContain("last used 20");
		expect(out[0]).not.toMatch(/never/);
	});

	test("revoke removes it and ends its sessions only", async () => {
		const { info, owner, viaPasskey } = await seed();
		expect(await run("passkey", "revoke", info.id)).toBe(0);
		expect(out.at(-1)).toContain("the API tokens they created are revoked");
		const notices = await (async () => {
			const a = await AuthService.open(authDbPath(home));
			try {
				return await a.passkeyNotices(owner.sessionId);
			} finally {
				a.close();
			}
		})();
		expect(notices.map((n) => [n.kind, n.source])).toEqual([
			["revoked", "the host CLI"],
		]);
		expect(await run("passkey", "revoke", info.id)).toBe(1);
		const auth = await AuthService.open(authDbPath(home));
		expect(await auth.listPasskeys()).toEqual([]);
		expect(await auth.authenticate(viaPasskey.token)).toBeNull();
		expect(await auth.authenticate(owner.token)).not.toBeNull();
		auth.close();
	});

	test("bad usage exits 2; no database (inside a sandbox) refuses", async () => {
		expect(await run("passkey")).toBe(2);
		expect(await run("passkey", "revoke")).toBe(2);
		expect(await run("passkey", "list", "extra")).toBe(2);
		expect(await run("passkey", "list")).toBe(1);
		expect(err.join("\n")).toContain("no auth database");
	});
});

describe("mfw auth sign-out-everywhere and passkeys", () => {
	test("deletes passkeys by default; --keep-passkeys keeps them", async () => {
		await seed();
		expect(await run("sign-out-everywhere", "--keep-passkeys")).toBe(0);
		let auth = await AuthService.open(authDbPath(home));
		expect(await auth.listPasskeys()).toHaveLength(1);
		auth.close();
		expect(await run("sign-out-everywhere")).toBe(0);
		expect(out.at(-1)).toContain("every passkey was deleted");
		auth = await AuthService.open(authDbPath(home));
		expect(await auth.listPasskeys()).toEqual([]);
		auth.close();
		expect(await run("sign-out-everywhere", "--bogus")).toBe(2);
	});
});
