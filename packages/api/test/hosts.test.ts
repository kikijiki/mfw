import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRegistry } from "@mfw/daemon/host-registry";
import { HostService } from "@mfw/daemon/host-service";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

function answer(sudo: "allowed" | "refused"): string {
	return [
		"MFW_HOST_PROBE_V1",
		"uid=1001",
		"user=agent",
		"home=/home/agent",
		"path=/usr/bin:/bin",
		`sudo=${sudo}`,
		"bwrap.path=/usr/bin/bwrap",
		"bwrap=yes",
		"setsid=/usr/bin/setsid",
		"bun=/home/agent/.bun/bin/bun",
		"git=/usr/bin/git",
		"harness.claude-cli=2.1.0 (Claude Code)",
		"auth.claude-cli=yes",
		"harness.codex-cli=",
		"auth.codex-cli=no",
		"gpus=0",
		"",
	].join("\n");
}

async function caller(sudo: "allowed" | "refused") {
	const home = await mkdtemp(join(tmpdir(), "mfw-api-hosts-"));
	homes.push(home);
	const hosts = new HostService({
		registry: HostRegistry.at(home, {
			keygenPath: Bun.which("ssh-keygen") as string,
		}),
		transport: () => ({ run: async () => ({ stdout: answer(sudo) }) }),
	});
	return createCaller({ orchestrator: { hosts } as unknown as Orchestrator });
}

const box = {
	id: "box-a",
	address: "box-a.example.invalid",
	user: "agent",
	hostKey: `ssh-ed25519 ${Buffer.alloc(32, 6).toString("base64")}`,
	trust: "shared" as const,
	labels: ["gpu"],
};

describe("hosts router", () => {
	test("add returns the per-host public key; probe gates schedulability", async () => {
		const api = await caller("refused");
		const added = await api.hosts.add(box);
		expect(added.publicKey).toStartWith("ssh-ed25519 ");
		expect(added.publicKey).not.toContain("PRIVATE");
		expect(added.host).toMatchObject({
			schedulable: false,
			reason: "has never been probed",
		});
		expect(await api.hosts.publicKey({ id: "box-a" })).toBe(added.publicKey);

		const probed = await api.hosts.probe({ id: "box-a" });
		expect(probed.health).toBe("ok");
		const [listed] = await api.hosts.list();
		expect(listed).toMatchObject({
			schedulable: true,
			harnesses: ["claude-cli"],
			config: { id: "box-a", trust: "shared", sandbox: "bwrap" },
		});

		await api.hosts.remove({ id: "box-a" });
		expect(await api.hosts.list()).toEqual([]);
		await expect(api.hosts.remove({ id: "box-a" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("a box with passwordless sudo is refused; a shared host cannot drop bwrap", async () => {
		const api = await caller("allowed");
		await api.hosts.add(box);
		const probed = await api.hosts.probe({ id: "box-a" });
		expect(probed.health).toBe("refused");
		expect((await api.hosts.list())[0]?.schedulable).toBe(false);
		await expect(
			api.hosts.add({ ...box, id: "box-b", sandbox: "none" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
