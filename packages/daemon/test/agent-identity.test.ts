import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURSOR_AGENT_IDENTITY,
	checkIdentity,
	identityShell,
	PI_IDENTITY,
	resolvedPath,
} from "../src/agents/agent-identity.ts";

/** Cursor's installer layout: `bin/agent` -> `.../versions/<v>/cursor-agent`. */
async function layout(target: string) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-identity-"));
	const versions = join(
		dir,
		"share",
		"cursor-agent",
		"versions",
		"2026.11.13-eacade1",
	);
	await mkdir(versions, { recursive: true });
	await mkdir(join(dir, "bin"));
	const real = join(versions, target);
	await writeFile(real, "#!/bin/sh\necho 2026.11.13-eacade1\n");
	await chmod(real, 0o755);
	await symlink(real, join(dir, "bin", "agent"));
	return dir;
}

async function sh(script: string, path: string): Promise<number> {
	const proc = Bun.spawn(["sh", "-c", script], {
		env: { ...process.env, PATH: `${path}:${process.env.PATH}` },
		stdout: "ignore",
		stderr: "ignore",
	});
	return proc.exited;
}

describe("binary identity", () => {
	test("Cursor: the agent link must resolve to cursor-agent", async () => {
		const genuine = await layout("cursor-agent");
		const impostor = await layout("other-tool");
		try {
			const check = (dir: string) =>
				checkIdentity(CURSOR_AGENT_IDENTITY, "agent", {
					resolvedPath: resolvedPath(join(dir, "bin", "agent")),
				});
			expect(check(genuine)).toEqual({ ok: true });
			const refused = check(impostor);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.reason).toContain("other-tool");
			// The host probe's shell check agrees.
			const script = identityShell(CURSOR_AGENT_IDENTITY, "agent");
			expect(await sh(script, join(genuine, "bin"))).toBe(0);
			expect(await sh(script, join(impostor, "bin"))).not.toBe(0);
		} finally {
			await rm(genuine, { recursive: true, force: true });
			await rm(impostor, { recursive: true, force: true });
		}
	});

	test("pi: --help must name the pi coding agent", async () => {
		const ok = checkIdentity(PI_IDENTITY, "pi", {
			helpText: "pi - AI coding assistant with read, bash, edit, write tools\n",
		});
		expect(ok).toEqual({ ok: true });
		const no = checkIdentity(PI_IDENTITY, "pi", {
			helpText: "pi: compute digits of pi\n",
		});
		expect(no.ok).toBe(false);
		expect(checkIdentity(PI_IDENTITY, "pi", { helpText: null }).ok).toBe(false);

		const dir = await mkdtemp(join(tmpdir(), "mfw-identity-pi-"));
		try {
			const fake = join(dir, "pi");
			await writeFile(
				fake,
				"#!/bin/sh\necho 'pi - AI coding assistant with read, bash, edit, write tools'\n",
			);
			await chmod(fake, 0o755);
			expect(await sh(identityShell(PI_IDENTITY, "pi"), dir)).toBe(0);
			await writeFile(fake, "#!/bin/sh\necho 'digits of pi'\n");
			expect(await sh(identityShell(PI_IDENTITY, "pi"), dir)).not.toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
