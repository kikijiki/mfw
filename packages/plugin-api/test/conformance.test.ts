import { describe, expect, test } from "bun:test";
import { bindContract, type ContractSpec } from "../src/common.ts";
import {
	type CheckResult,
	failures,
	runConformance,
} from "../src/conformance/kit.ts";
import { connectorContract } from "../src/connector.ts";
import { factsContract } from "../src/facts.ts";
import { FakeHost } from "../src/fakes/fake-host.ts";
import { FakeCloud, FakeMachine } from "../src/fakes/fake-machine.ts";
import {
	FakeAction,
	FakeConnector,
	FakeFacts,
	FakeProvider,
	FakeSink,
} from "../src/fakes/fake-others.ts";
import { FakeResource } from "../src/fakes/fake-resource.ts";
import { machineContract } from "../src/machine.ts";
import { actionContract, notifyContract } from "../src/notify.ts";
import { providerContract } from "../src/provider.ts";
import { type PoolProposal, resourceContract } from "../src/resource.ts";

const gpuPool: PoolProposal = {
	poolId: "local.gpu.0",
	title: "GPU 0",
	dimensions: [{ kind: "slot", name: "gpu", total: 1 }],
	providerHardLimit: false,
};
const machinePool: PoolProposal = {
	poolId: "fake.machines",
	title: "Fake machines",
	dimensions: [{ kind: "quantity", name: "pods", unit: "pod", total: 2 }],
	providerHardLimit: false,
};

const bound = <T extends object>(spec: ContractSpec, impl: T) =>
	bindContract(spec, impl);
const byName = (r: CheckResult[], name: string) =>
	r.find((c) => c.name === name);
const expectClean = (results: CheckResult[]) => {
	expect(failures(results)).toEqual([]);
	expect(results.some((c) => c.status === "pass")).toBe(true);
};

describe("conformance kit", () => {
	test("FakeResource passes the resource suite", async () => {
		const results = await runConformance("resource", {
			create: () => bound(resourceContract, new FakeResource([gpuPool])),
		});
		expectClean(results);
		expect(byName(results, "deadline and cancel behaviour")?.status).toBe(
			"skip",
		);
	});

	test("a resource that raises capacity fails", async () => {
		const liar = new FakeResource([gpuPool]);
		liar.observed.set("local.gpu.0", [
			{ kind: "slot", name: "gpu", total: 8, occupied: [] },
		]);
		const results = await runConformance("resource", {
			create: () => bound(resourceContract, liar),
		});
		expect(byName(results, "observations never raise capacity")?.status).toBe(
			"fail",
		);
	});

	test("a resource that answers for the wrong pool or skips validation fails", async () => {
		const sloppy = {
			discover: async () => [gpuPool],
			observe: async () => ({
				poolId: "local.cpu",
				observedAt: 1,
				health: "ok",
				dimensions: [],
			}),
		};
		const results = await runConformance("resource", { create: () => sloppy });
		expect(
			byName(results, "observe returns valid observations for every pool")
				?.status,
		).toBe("fail");
		expect(byName(results, "observe rejects a malformed pool id")?.status).toBe(
			"fail",
		);
	});

	test("a plugin missing a required method fails the method check", async () => {
		const results = await runConformance("resource", {
			create: () => ({ discover: async () => [] }),
		});
		expect(byName(results, "implements the required methods")?.status).toBe(
			"fail",
		);
	});

	test("FakeMachine passes the machine suite, crash check included", async () => {
		const cloud = new FakeCloud();
		const make = () =>
			bound(machineContract, new FakeMachine(cloud, [machinePool]));
		const results = await runConformance("machine", {
			create: make,
			restart: make,
		});
		expectClean(results);
		expect(
			byName(results, "after a crash, inventory finds the object by its token")
				?.status,
		).toBe("pass");
	});

	test("the crash check is skipped without restart()", async () => {
		const cloud = new FakeCloud();
		const results = await runConformance("machine", {
			create: () =>
				bound(machineContract, new FakeMachine(cloud, [machinePool])),
		});
		expect(
			byName(results, "after a crash, inventory finds the object by its token")
				?.status,
		).toBe("skip");
	});

	test("a machine that lies on teardown fails", async () => {
		const cloud = new FakeCloud();
		const make = () => {
			const m = new FakeMachine(cloud, [machinePool]);
			m.lieOnTeardown = true;
			return bound(machineContract, m);
		};
		const results = await runConformance("machine", {
			create: make,
			restart: make,
		});
		expect(
			byName(
				results,
				"teardown is proven by a later inventory, not by its own reply",
			)?.status,
		).toBe("fail");
	});

	test("a machine whose create is not idempotent fails", async () => {
		class NotIdempotent extends FakeMachine {
			override async provision(...args: Parameters<FakeMachine["provision"]>) {
				this.cloud.created.clear();
				return super.provision(...args);
			}
		}
		const cloud = new FakeCloud();
		const make = () =>
			bound(machineContract, new NotIdempotent(cloud, [machinePool]));
		const results = await runConformance("machine", {
			create: make,
			restart: make,
		});
		expect(
			byName(results, "provision is idempotent under a repeated operationId")
				?.status,
		).toBe("fail");
	});

	test("the ambiguous-created fake is found by inventory", async () => {
		const cloud = new FakeCloud();
		const m = new FakeMachine(cloud, [machinePool]);
		m.mode = "ambiguous-created";
		const host = new FakeHost();
		const res = await m.provision(
			{
				leaseId: "l",
				poolId: "fake.machines",
				shape: { units: 1, attributes: {} },
				ownershipToken: "mfw-token-0123456789",
				sshPublicKey: "ssh-ed25519 AAAA",
			},
			host.context("p1"),
		);
		expect(res.status).toBe("ambiguous");
		const inv = await m.inventory(
			{ poolId: "fake.machines" },
			host.context("i1"),
		);
		expect(inv.map((o) => o.ownershipToken)).toEqual(["mfw-token-0123456789"]);
	});

	test("the other fakes pass their suites", async () => {
		expectClean(
			await runConformance("provider", {
				create: () => bound(providerContract, new FakeProvider()),
			}),
		);
		expectClean(
			await runConformance("connector", {
				create: () => bound(connectorContract, new FakeConnector()),
			}),
		);
		expectClean(
			await runConformance("notify", {
				create: () => bound(notifyContract, new FakeSink()),
			}),
		);
		expectClean(
			await runConformance("action", {
				create: () => bound(actionContract, new FakeAction()),
			}),
		);
		expectClean(
			await runConformance("facts", {
				create: () => bound(factsContract, new FakeFacts()),
			}),
		);
	});

	test("an action plugin that accepts host state fails", async () => {
		const permissive = {
			run: async () => ({ status: "ok", retryable: false }),
		};
		const results = await runConformance("action", {
			create: () => permissive,
		});
		expect(
			byName(results, "run rejects a view carrying extra host state")?.status,
		).toBe("fail");
	});

	test("a connector whose map is impure fails", async () => {
		let n = 0;
		const impure = {
			identity: async () => ({ system: "s", project: "p" }),
			map: async () => ({ docId: "D", hash: `hash-${++n}-xxxx`, payload: {} }),
			push: async () => ({ results: [] }),
			pull: async () => ({ changes: [], cursor: null }),
		};
		const results = await runConformance("connector", { create: () => impure });
		expect(byName(results, "map is pure")?.status).toBe("fail");
	});

	test("the harness kind has no runtime suite", async () => {
		const results = await runConformance("harness", { create: () => ({}) });
		expect(results.map((r) => r.status)).toEqual(["skip"]);
	});
});

describe("fake host", () => {
	test("records broker calls, logs and events, and caps state", async () => {
		const host = new FakeHost(64);
		host.respond = () => ({ status: 201, headers: {}, body: "ok" });
		const res = await host.http({
			grant: "g",
			method: "GET",
			url: "https://x.example.com",
		});
		expect(res.status).toBe(201);
		expect(host.httpCalls).toHaveLength(1);
		host.log("info", "hello");
		host.emit("resource.changed", { a: 1 });
		expect(host.logs[0]?.message).toBe("hello");
		expect(host.events[0]?.type).toBe("resource.changed");
		await host.state.set("k", "v");
		expect(await host.state.get("k")).toBe("v");
		await expect(host.state.set("big", "x".repeat(200))).rejects.toThrow(/cap/);
		expect(await host.state.get("big")).toBeUndefined();
		host.clock.advance(1000);
		expect(host.context().deadline).toBe(host.clock.now() + 30_000);
	});
});
