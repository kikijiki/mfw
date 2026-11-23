import { FakeClock } from "../../../plugin-api/src/fakes/fake-host.ts";
import type { HostObservationServiceOptions } from "../../src/host-observation-service.ts";
import { silentLogger } from "../../src/log.ts";
import { ProviderHoldStore } from "../../src/provider-holds.ts";
import { BudgetWindows } from "../../src/resources/budget-windows.ts";
import { builtinPluginHost } from "../../src/resources/builtin/plugin-host.ts";
import {
	type LeaseLiveness,
	ResourceCoordinator,
} from "../../src/resources/coordinator.ts";
import { HostLedger } from "../../src/resources/host-ledger.ts";
import { openResourceStore } from "../../src/resources/store.ts";
import type { LeaseEvidence } from "../../src/resources/types.ts";

export interface LedgerFixture {
	ledger: HostLedger;
	clock: FakeClock;
	liveness: { evidence: LeaseEvidence };
	close(): void;
}

/** A real ledger over a private `host.db`, with an injectable clock and liveness. */
export async function openTestLedger(
	home: string,
	options: {
		now?: () => number;
		processBootId?: string;
		kernelBootId?: string | null;
		liveness?: LeaseLiveness;
		leaseMs?: number;
		livenessMaxAgeMs?: number;
		observations?: HostObservationServiceOptions;
	} = {},
): Promise<LedgerFixture> {
	const clock = new FakeClock();
	const now = options.now ?? (() => clock.now());
	const store = await openResourceStore(home, {
		now,
		...(options.processBootId ? { processBootId: options.processBootId } : {}),
		kernelBootId: options.kernelBootId ?? null,
	});
	const host = builtinPluginHost(silentLogger(), now);
	const liveness = { evidence: "live" as LeaseEvidence };
	const coordinator = new ResourceCoordinator(store, {
		host,
		liveness: options.liveness ?? { inspect: async () => liveness.evidence },
		...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
		...(options.livenessMaxAgeMs
			? { livenessMaxAgeMs: options.livenessMaxAgeMs }
			: {}),
	});
	const ledger = new HostLedger({
		store,
		coordinator,
		host,
		...(options.observations ? { observations: options.observations } : {}),
	});
	await ledger.load();
	return { ledger, clock, liveness, close: () => coordinator.close() };
}

/** Budget holds and windows over one private store. */
export async function openTestBudgetStores(
	home: string,
	now: () => number = Date.now,
): Promise<{ holds: ProviderHoldStore; windows: BudgetWindows }> {
	const store = await openResourceStore(home, { now });
	return {
		holds: new ProviderHoldStore(store, now),
		windows: new BudgetWindows(store),
	};
}

/** Provider holds over a private store, for tests of their consumers. */
export async function openTestHolds(
	home: string,
	now: () => number = Date.now,
): Promise<ProviderHoldStore> {
	const store = await openResourceStore(home, { now });
	return new ProviderHoldStore(store, now);
}
