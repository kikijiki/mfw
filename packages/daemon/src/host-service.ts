import {
	type HostCandidate,
	type HostConfig,
	type HostConfigInput,
	type HostObservation,
	type HostRegistry,
	hostCandidate,
	hostEndpoint,
	hostSlotResourceId,
	type RegisteredHost,
	registryPinnedPolicy,
} from "./host-registry.ts";
import { type ProbeTransport, probeHost } from "./host-registry-probe.ts";
import type {
	HostResourceDefinition,
	HostResourceReadModel,
} from "./host-resources/index.ts";
import type { Logger } from "./log.ts";
import { SshTransport } from "./ssh-transport.ts";

/**
 * Process-global owner of the SSH host registry: declared hosts, probes on a
 * cadence, and each host's capacity as the slot resource
 * `remote.<id>.slots` in the host-resource coordinator, so remote runs wait
 * FIFO in the same ledger as local GPUs (no second ledger).
 */

/** The coordinator surface this service needs. */
export interface HostSlotLedger {
	readModel(): HostResourceReadModel;
	putDefinition(
		definition: HostResourceDefinition,
		options?: { actor?: string; reason?: string },
	): Promise<HostResourceDefinition>;
}

export interface HostView {
	config: HostConfig;
	observed: HostObservation | null;
	schedulable: boolean;
	reason: string | null;
	harnesses: readonly string[];
	slots: { resourceId: string; capacity: number; inUse: number };
}

export type HostTransportFactory = (
	host: RegisteredHost,
	pinned: readonly HostConfig[],
) => ProbeTransport;

export interface HostServiceDeps {
	registry: HostRegistry;
	ledger?: HostSlotLedger;
	log?: Logger;
	now?: () => number;
	/** Test seam: replaces the strict SshTransport. */
	transport?: HostTransportFactory;
	probeIntervalMs?: number;
}

/** A strict SSH transport to a registry host, pinned to the current registry. */
export function registryTransport(
	host: RegisteredHost,
	pinned: readonly HostConfig[],
	opts: { commandTimeoutMs?: number; maxOutputBytes?: number } = {},
): SshTransport {
	return new SshTransport({
		endpoint: hostEndpoint(host.config, host.keyPath),
		policy: registryPinnedPolicy(pinned),
		...opts,
	});
}

export class HostService {
	private timer: ReturnType<typeof setInterval> | null = null;
	private probing: Promise<void> | null = null;

	constructor(private readonly deps: HostServiceDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	get registry(): HostRegistry {
		return this.deps.registry;
	}

	private slotUsage(id: string): { capacity: number; inUse: number } {
		const model = this.deps.ledger?.readModel();
		const capacity = model?.effectiveCapacities.find(
			(c) => c.resourceId === hostSlotResourceId(id),
		);
		if (!capacity) return { capacity: 0, inUse: 0 };
		return {
			capacity: Number(capacity.configuredQuota),
			inUse: Number(capacity.durablePromises),
		};
	}

	/** Free slots now, for placement ordering. */
	free(id: string): number {
		const usage = this.slotUsage(id);
		return Math.max(0, usage.capacity - usage.inUse);
	}

	async candidates(): Promise<HostCandidate[]> {
		return this.deps.registry.candidates(this.now());
	}

	async list(): Promise<HostView[]> {
		const now = this.now();
		return (await this.deps.registry.list()).map((host) => {
			const candidate = hostCandidate(host, now);
			return {
				config: host.config,
				observed: host.observed,
				schedulable: candidate.schedulable,
				reason: candidate.reason,
				harnesses: candidate.harnesses,
				slots: {
					resourceId: hostSlotResourceId(host.config.id),
					...this.slotUsage(host.config.id),
				},
			};
		});
	}

	async put(
		input: HostConfigInput,
	): Promise<{ host: HostView; publicKey: string }> {
		const { host, publicKey } = await this.deps.registry.put(input);
		await this.syncSlots();
		const view = (await this.list()).find(
			(h) => h.config.id === host.config.id,
		);
		return { host: view as HostView, publicKey };
	}

	/** Refused while any run still holds one of the host's slots. */
	async remove(id: string): Promise<void> {
		const usage = this.slotUsage(id);
		if (usage.inUse > 0) {
			throw new Error(
				`SSH host '${id}' still holds ${usage.inUse} run slot(s): stop or finish those runs first`,
			);
		}
		await this.deps.registry.remove(id);
		await this.syncSlots();
	}

	async probe(id: string): Promise<HostObservation> {
		const host = await this.deps.registry.require(id);
		const pinned = (await this.deps.registry.list()).map((h) => h.config);
		const transport = (this.deps.transport ?? registryTransport)(host, pinned);
		const observation = await probeHost(host.config, transport, () =>
			this.now(),
		);
		await this.deps.registry.recordObservation(id, observation);
		this.deps.log?.info(
			{ host: id, health: observation.health, problems: observation.problems },
			"probed SSH host",
		);
		return observation;
	}

	async probeAll(): Promise<void> {
		this.probing ??= (async () => {
			try {
				for (const host of await this.deps.registry.list()) {
					await this.probe(host.config.id).catch((error) =>
						this.deps.log?.warn(
							{ err: error, host: host.config.id },
							"SSH host probe failed",
						),
					);
				}
			} finally {
				this.probing = null;
			}
		})();
		return this.probing;
	}

	/**
	 * Mirror every declared host as `remote.<id>.slots` (capacity = slots).
	 * A removed host's definition drains, then disables once no run holds
	 * it. Writes only on change, so definition versions do not churn.
	 */
	async syncSlots(): Promise<void> {
		const ledger = this.deps.ledger;
		if (!ledger) return;
		const hosts = await this.deps.registry.list();
		const wanted = new Map(
			hosts.map((h) => [hostSlotResourceId(h.config.id), h.config]),
		);
		const model = ledger.readModel();
		for (const [resourceId, config] of wanted) {
			const current = model.definitions.find((d) => d.id === resourceId);
			const capacity = BigInt(config.slots);
			if (
				current &&
				current.capacity === capacity &&
				current.enabled &&
				!current.draining
			)
				continue;
			await ledger.putDefinition(
				{
					id: resourceId,
					accounting: "slot",
					provisioning: "static",
					capacity,
					enabled: true,
					draining: false,
					version: current?.version ?? 1n,
					metadata: { kind: "ssh-host", hostId: config.id },
				},
				{ actor: "host-registry", reason: `SSH host ${config.id} declared` },
			);
		}
		for (const current of model.definitions) {
			if (
				current.metadata?.kind !== "ssh-host" ||
				wanted.has(current.id) ||
				!current.enabled
			)
				continue;
			const inUse =
				model.effectiveCapacities.find((c) => c.resourceId === current.id)
					?.durablePromises ?? 0n;
			if (current.draining && inUse > 0n) continue;
			await ledger.putDefinition(
				// Drain first; disable on a later pass once nothing holds it.
				{ ...current, draining: true, enabled: !current.draining },
				{ actor: "host-registry", reason: "SSH host removed" },
			);
		}
	}

	/** Probe on a cadence (default 10 min; observations go stale at 30). */
	start(): void {
		if (this.timer) return;
		void this.syncSlots()
			.then(() => this.probeAll())
			.catch((error) =>
				this.deps.log?.warn({ err: error }, "SSH host startup failed"),
			);
		this.timer = setInterval(
			() => {
				void this.probeAll()
					.then(() => this.syncSlots())
					.catch((error) =>
						this.deps.log?.warn({ err: error }, "SSH host probe pass failed"),
					);
			},
			this.deps.probeIntervalMs ?? 10 * 60_000,
		);
		this.timer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.probing?.catch(() => {});
	}
}
