import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostNotFoundError, HostRegistry } from "../src/host-registry.ts";
import { unreachableObservation } from "../src/host-registry-probe.ts";

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

async function registry(): Promise<{ home: string; hosts: HostRegistry }> {
	const home = await mkdtemp(join(tmpdir(), "mfw-host-registry-"));
	homes.push(home);
	return {
		home,
		hosts: HostRegistry.at(home, {
			keygenPath: Bun.which("ssh-keygen") as string,
		}),
	};
}

const hostKey = `ssh-ed25519 ${Buffer.alloc(32, 3).toString("base64")} root@box`;

describe("host registry", () => {
	test("a new host gets its own 0600 identity; the file is 0600 and keeps no key material", async () => {
		const { home, hosts } = await registry();
		const { host, publicKey } = await hosts.put({
			id: "gpu-1",
			address: "192.0.2.10",
			user: "agent",
			hostKey,
			trust: "owned",
			labels: ["gpu"],
		});
		expect(publicKey).toStartWith("ssh-ed25519 ");
		// The pinned key is normalized: the comment is dropped.
		expect(host.config.hostKey).toBe(hostKey.split(" ").slice(0, 2).join(" "));
		expect(host.config).toMatchObject({ port: 22, slots: 1, sandbox: "bwrap" });
		expect((await stat(host.keyPath)).mode & 0o777).toBe(0o600);
		const file = await readFile(join(home, "hosts.json"), "utf8");
		expect((await stat(join(home, "hosts.json"))).mode & 0o777).toBe(0o600);
		expect(file).not.toContain("PRIVATE KEY");
		expect(await hosts.publicKey("gpu-1")).toBe(publicKey);

		// Re-put keeps the identity; a changed address forgets the observation.
		await hosts.recordObservation("gpu-1", unreachableObservation(1, "x"));
		const same = await hosts.put({ ...host.config, slots: 2 });
		expect(same.publicKey).toBe(publicKey);
		expect((await hosts.get("gpu-1"))?.observed).not.toBeNull();
		await hosts.put({ ...host.config, address: "192.0.2.11" });
		expect((await hosts.get("gpu-1"))?.observed).toBeNull();

		await hosts.remove("gpu-1");
		await expect(stat(host.keyPath)).rejects.toThrow();
		expect(await hosts.list()).toEqual([]);
		await expect(hosts.remove("gpu-1")).rejects.toBeInstanceOf(
			HostNotFoundError,
		);
	});

	test("a malformed registry is an error, never an empty registry", async () => {
		const { home, hosts } = await registry();
		await writeFile(join(home, "hosts.json"), "{not json");
		await expect(hosts.list()).rejects.toThrow("malformed");
	});

	test("concurrent puts are serialized: no host is lost", async () => {
		const { hosts } = await registry();
		await Promise.all(
			["a", "b", "c", "d"].map((id) =>
				hosts.put({
					id,
					address: `${id}.example.invalid`,
					user: "agent",
					hostKey,
					trust: "owned",
				}),
			),
		);
		expect((await hosts.list()).map((h) => h.config.id)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});
});
