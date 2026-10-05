import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import { stableProjectIdentity } from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	paths.push(path);
	return path;
}

async function repo(name: string): Promise<string> {
	const root = await temp(`mfw-project-id-${name}-`);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "project@test"], root);
	await git(["config", "user.name", "project-test"], root);
	await writeFile(
		join(root, "app.ts"),
		`export const name = ${JSON.stringify(name)};\n`,
	);
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

describe("stable global project registry", () => {
	test("corrupt project identity metadata fails closed instead of re-identifying", async () => {
		const root = await repo("corrupt-identity");
		const state = join(root, ".mfw", "state");
		await mkdir(state, { recursive: true });
		const path = join(state, "project.json");
		await writeFile(path, "{ definitely not an identity\n");
		await expect(stableProjectIdentity(join(root, ".mfw"))).rejects.toThrow(
			"identity metadata is corrupt",
		);
		expect(await readFile(path, "utf8")).toBe("{ definitely not an identity\n");
	});

	test("all projects receive the same narrow coordinator and distinct stable identities", async () => {
		const home = await temp("mfw-project-registry-home-");
		const a = await repo("a");
		const b = await repo("b");
		const orchestrator = await boot({
			projects: [
				{ name: "alpha", root: a },
				{ name: "beta", root: b },
			],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		const alpha = orchestrator.get("alpha");
		const beta = orchestrator.get("beta");
		expect(alpha.projectId).not.toBe(beta.projectId);
		expect(alpha.hostResources).toBe(beta.hostResources);
		expect(alpha.hostResources).toBe(orchestrator.hostResources);
		// Projects get only the typed port, not scheduler callbacks/backrefs.
		expect("scheduler" in alpha.hostResources).toBe(false);

		const rows = await orchestrator.hostResources.store.client.execute(
			"SELECT id,root,display_name,attached FROM projects ORDER BY display_name",
		);
		expect(rows.rows.map((r) => r.id)).toEqual([
			alpha.projectId,
			beta.projectId,
		]);
		expect(rows.rows.every((r) => r.attached === 1n)).toBe(true);
		await orchestrator.shutdown();
	});

	test("detach preserves leases and moving/renaming a project does not re-identify it", async () => {
		const home = await temp("mfw-project-detach-home-");
		const original = await repo("move");
		const moved = `${original}-moved`;
		paths.push(moved);
		const orchestrator = await boot({
			projects: [],
			mfwHome: home,
			autostart: false,
			log: silentLogger(),
		});
		const first = await orchestrator.attach({ name: "before", root: original });
		const stableId = first.projectId;
		await orchestrator.hostResources.putDefinition({
			id: "gpu",
			accounting: "slot",
			provisioning: "static",
			capacity: 1n,
			enabled: true,
			draining: false,
			version: 1n,
		});
		const waiter = await first.hostResources.putWaiter({
			requestKey: "detached-run",
			projectId: stableId,
			requirements: [{ resourceId: "gpu", amount: 1n }],
		});
		const granted = await first.hostResources.tryGrant(
			waiter.id,
			waiter.generation,
		);
		if ("kind" in granted) throw new Error("unexpected hold");
		await orchestrator.detach("before");
		expect(
			(await orchestrator.hostResources.store.lease(granted.id))?.state,
		).toBe("provisional");

		await rename(original, moved);
		const again = await orchestrator.attach({ name: "after", root: moved });
		expect(again.projectId).toBe(stableId);
		expect(
			(await orchestrator.hostResources.store.lease(granted.id))?.projectId,
		).toBe(stableId);
		const row = await orchestrator.hostResources.store.client.execute({
			sql: "SELECT root,display_name FROM projects WHERE id=?",
			args: [stableId],
		});
		expect(row.rows[0]?.root).toBe(moved);
		expect(row.rows[0]?.display_name).toBe("after");
		await orchestrator.shutdown();
	});
});
