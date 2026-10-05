import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { dispatchAdmissions, events, resourceSlots } from "@mfw/db/schema";
import { boot, type ProjectConfig } from "../../src/boot.ts";
import { acquireDaemonLock } from "../../src/host-resources/daemon-lock.ts";
import {
	type ImmutableHostRequest,
	openHostResourceStore,
} from "../../src/host-resources/index.ts";
import { silentLogger } from "../../src/log.ts";
import type { AdmissionTransition } from "../../src/project-dispatch-admission.ts";
import type { ProjectServices } from "../../src/services.ts";

type Common = {
	readyPath: string;
	resultPath: string;
};

type GrantConfig = Common & {
	mode: "grant";
	home: string;
	barrierPath: string;
	processBootId: string;
	kernelBootId: string | null;
	request: Omit<ImmutableHostRequest, "requirements"> & {
		requirements: Array<{
			resourceId: string;
			amount: string;
			bindingId?: string | null;
		}>;
	};
};

type HoldWriteConfig = Common & {
	mode: "hold-write";
	home: string;
	releasePath: string;
};

type HoldLockConfig = Common & {
	mode: "hold-lock";
	home: string;
	releasePath: string;
};

type DaemonConfig = Common & {
	mode: "crash-daemon" | "recover-daemon";
	home: string;
	projects: ProjectConfig[];
	driverPath: string;
	taskId: string;
	crashAt?: AdmissionTransition;
	kernelBootId?: string | null;
	nowMs?: number;
};

type ChildConfig =
	| GrantConfig
	| HoldWriteConfig
	| HoldLockConfig
	| DaemonConfig;

const stringify = (value: unknown) =>
	`${JSON.stringify(value, (_key, nested) =>
		typeof nested === "bigint" ? nested.toString() : nested,
	)}\n`;

async function publish(path: string, value: unknown): Promise<void> {
	await writeFile(path, stringify(value), { mode: 0o600 });
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try {
			await readFile(path);
			return;
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		}
		if (performance.now() >= deadline) {
			throw new Error(`child timed out waiting for ${path}`);
		}
		await Bun.sleep(5);
	}
}

function useDriver(service: ProjectServices, path: string): void {
	const adapters = (
		service.engine as unknown as {
			deps: {
				adapters: {
					driverOverride: string | null;
					buildArgv: (() => string[]) | null;
				};
			};
		}
	).deps.adapters;
	adapters.driverOverride = path;
	adapters.buildArgv = () => ["true"];
}

async function ownerFor(
	services: ProjectServices[],
	taskId: string,
): Promise<ProjectServices | null> {
	for (const service of services) {
		if (await service.tasks.get(taskId)) return service;
	}
	return null;
}

async function grant(config: GrantConfig): Promise<void> {
	const store = await openHostResourceStore(config.home, {
		processBootId: config.processBootId,
		kernelBootId: config.kernelBootId,
		busyTimeoutMs: 2_000,
	});
	try {
		const waiter = await store.putWaiter({
			...config.request,
			requirements: config.request.requirements.map((requirement) => ({
				...requirement,
				amount: BigInt(requirement.amount),
			})),
		});
		await publish(config.readyPath, { waiter });
		await waitForFile(config.barrierPath);
		let generation = waiter.generation;
		let result = await store.tryGrant(waiter.id, generation);
		for (
			let retries = 0;
			"kind" in result && result.reason === "generation";
			retries++
		) {
			if (retries >= 8) throw new Error("generation retry bound exhausted");
			generation = result.generation;
			result = await store.tryGrant(waiter.id, generation);
		}
		await publish(config.resultPath, { waiter, result });
	} finally {
		store.close();
	}
}

async function holdWrite(config: HoldWriteConfig): Promise<void> {
	const client = createClient({
		url: `file:${config.home}/host/host.db`,
		intMode: "bigint",
		timeout: 25,
	});
	const tx = await client.transaction("write");
	try {
		await tx.execute(
			"UPDATE host_meta SET updated_at=updated_at WHERE singleton=1",
		);
		await publish(config.readyPath, { state: "write-lock-held" });
		await waitForFile(config.releasePath);
		await tx.commit();
		await publish(config.resultPath, { state: "released" });
	} finally {
		if (!tx.closed) await tx.rollback().catch(() => {});
		tx.close();
		client.close();
	}
}

async function holdLock(config: HoldLockConfig): Promise<void> {
	const lock = await acquireDaemonLock(config.home, {
		processBootId: `lock-holder-${process.pid}`,
		timeoutMs: 1_000,
	});
	try {
		await publish(config.readyPath, { state: "daemon-lock-held" });
		await waitForFile(config.releasePath);
	} finally {
		await lock.release();
	}
	await publish(config.resultPath, { state: "released" });
}

async function crashDaemon(config: DaemonConfig): Promise<void> {
	const target = config.crashAt;
	if (!target) throw new Error("crash-daemon requires crashAt");
	const nowMs = config.nowMs;
	const orchestrator = await boot({
		projects: config.projects,
		mfwHome: config.home,
		autostart: false,
		log: silentLogger(),
		kernelBootId: config.kernelBootId,
		hostNow: nowMs === undefined ? undefined : () => nowMs,
		afterAdmissionTransition: async (transition, row) => {
			if (transition !== target) return;
			await publish(config.readyPath, { transition, row, pid: process.pid });
			await new Promise<never>(() => {});
		},
	});
	try {
		for (const service of orchestrator.list())
			useDriver(service, config.driverPath);
		const service = await ownerFor(orchestrator.list(), config.taskId);
		const owner = service ?? orchestrator.list()[0];
		if (!owner) throw new Error("no project attached in crash child");
		await owner.engine.startTask(config.taskId, { actor: "human" });
		await publish(config.resultPath, {
			error: `transition '${target}' was not reached`,
		});
	} finally {
		await orchestrator.shutdown();
	}
}

async function recoverDaemon(config: DaemonConfig): Promise<void> {
	const nowMs = config.nowMs;
	const orchestrator = await boot({
		projects: config.projects,
		mfwHome: config.home,
		autostart: false,
		log: silentLogger(),
		kernelBootId: config.kernelBootId,
		hostNow: nowMs === undefined ? undefined : () => nowMs,
	});
	try {
		for (const service of orchestrator.list())
			useDriver(service, config.driverPath);
		const owner = await ownerFor(orchestrator.list(), config.taskId);
		if (!owner) throw new Error("task project was unavailable after restart");
		const auditBeforeRun = await orchestrator.hostResources.auditEntries({
			limit: 1_000,
		});
		const started = await owner.engine.startTask(config.taskId, {
			actor: "human",
		});
		const recovered = {
			bootId: orchestrator.bootId,
			started,
			host: orchestrator.hostResources.readModel(),
			admissions: await owner.handle.db.select().from(dispatchAdmissions),
			events: await owner.handle.db.select().from(events),
			slots: await owner.handle.db.select().from(resourceSlots),
			runs: await owner.registry.list({ taskId: config.taskId }),
			auditBeforeRun,
		};

		for (const run of await owner.registry.list({ taskId: config.taskId })) {
			if (run.state !== "running") continue;
			await owner.host.kill(
				owner.registry.runDir(run.id),
				run.id,
				"process harness cleanup",
			);
			await owner.registry.recordExit(run.id, { outcome: "interrupted" });
			await owner.admission.releaseRun(run.id, "process harness cleanup");
		}
		await publish(config.resultPath, {
			recovered,
			finalHost: orchestrator.hostResources.readModel(),
			finalAudit: await orchestrator.hostResources.auditEntries({
				limit: 1_000,
			}),
		});
		await publish(config.readyPath, { state: "recovered" });
	} finally {
		await orchestrator.shutdown();
	}
}

async function main(): Promise<void> {
	const configPath = Bun.argv[2];
	if (!configPath) throw new Error("child config path is required");
	const config = JSON.parse(await readFile(configPath, "utf8")) as ChildConfig;
	switch (config.mode) {
		case "grant":
			await grant(config);
			break;
		case "hold-write":
			await holdWrite(config);
			break;
		case "hold-lock":
			await holdLock(config);
			break;
		case "crash-daemon":
			await crashDaemon(config);
			break;
		case "recover-daemon":
			await recoverDaemon(config);
			break;
	}
}

main().catch(async (error) => {
	const configPath = Bun.argv[2];
	try {
		if (configPath) {
			const config = JSON.parse(
				await readFile(configPath, "utf8"),
			) as ChildConfig;
			await publish(config.resultPath, {
				error:
					error instanceof Error
						? (error.stack ?? error.message)
						: String(error),
			});
		}
	} finally {
		process.exitCode = 1;
	}
});
