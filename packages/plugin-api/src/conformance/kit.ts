import type { ContractSpec, PluginKind } from "../common.ts";
import { connectorContract } from "../connector.ts";
import { factsContract } from "../facts.ts";
import { FakeHost } from "../fakes/fake-host.ts";
import { machineContract } from "../machine.ts";
import { actionContract, notifyContract } from "../notify.ts";
import { providerContract } from "../provider.ts";
import { capacityRaised, resourceContract } from "../resource.ts";

/**
 * Conformance kit skeleton (`mfw.<kind>/v1`). Each check returns pass, fail or
 * skip with a reason. Checks that need the real plugin host (deadlines,
 * cancel, "no network outside the broker under the real profile") report
 * `skip` here; R6 supplies the host and flips them on. Built-ins and
 * external plugins run the same suites.
 */

export type CheckStatus = "pass" | "fail" | "skip";
export interface CheckResult {
	kind: PluginKind;
	name: string;
	status: CheckStatus;
	detail?: string;
}

export interface Subject {
	/** A fresh plugin instance. */
	create(): object | Promise<object>;
	/**
	 * A new instance over the same persistent world, simulating a crash. Needed
	 * for the crash-after-provision check; skipped without it.
	 */
	restart?(): object | Promise<object>;
	host?: FakeHost;
	/** Pool and shape the machine suite provisions; defaults suit the fakes. */
	machine?: { poolId: string; shape: Record<string, unknown> };
}

type AnyFn = (params: unknown, ctx: unknown) => Promise<unknown>;

const SPECS: Record<PluginKind, ContractSpec> = {
	resource: resourceContract,
	machine: machineContract,
	provider: providerContract,
	connector: connectorContract,
	notify: notifyContract,
	action: actionContract,
	facts: factsContract,
	harness: { kind: "harness", methods: {} },
};

class Runner {
	readonly results: CheckResult[] = [];
	constructor(
		private readonly kind: PluginKind,
		readonly host: FakeHost,
	) {}

	async check(name: string, fn: () => Promise<unknown>): Promise<void> {
		try {
			const note = await fn();
			this.results.push({
				kind: this.kind,
				name,
				status: "pass",
				...(typeof note === "string" && note ? { detail: note } : {}),
			});
		} catch (error) {
			this.results.push({
				kind: this.kind,
				name,
				status: "fail",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	skip(name: string, detail: string): void {
		this.results.push({ kind: this.kind, name, status: "skip", detail });
	}
}

function fn(plugin: object, name: string): AnyFn | null {
	const f = (plugin as Record<string, unknown>)[name];
	return typeof f === "function" ? (f.bind(plugin) as AnyFn) : null;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Calls a method and validates the result against the contract schema. */
async function callValid(
	spec: ContractSpec,
	plugin: object,
	host: FakeHost,
	name: string,
	params: unknown,
	operationId = "conf-op",
): Promise<unknown> {
	const m = spec.methods[name];
	assert(m, `contract has no method ${name}`);
	const f = fn(plugin, name);
	assert(f, `plugin does not implement ${name}`);
	const raw = await f(params, host.context(operationId));
	const parsed = m.result.safeParse(raw);
	assert(
		parsed.success,
		`result of ${name} violates the contract: ${parsed.success ? "" : parsed.error.message}`,
	);
	return parsed.data;
}

function requireMethods(spec: ContractSpec, plugin: object) {
	const missing = Object.entries(spec.methods)
		.filter(([name, m]) => !m.optional && !fn(plugin, name))
		.map(([name]) => name);
	assert(
		missing.length === 0,
		`missing required methods: ${missing.join(", ")}`,
	);
}

async function rejectsMalformed(
	plugin: object,
	host: FakeHost,
	name: string,
	bad: unknown,
): Promise<void> {
	const f = fn(plugin, name);
	assert(f, `plugin does not implement ${name}`);
	let threw = false;
	try {
		await f(bad, host.context("conf-bad"));
	} catch {
		threw = true;
	}
	assert(threw, `${name} accepted malformed parameters`);
}

async function resourceSuite(r: Runner, spec: ContractSpec, subject: Subject) {
	const plugin = await subject.create();
	await r.check("implements the required methods", async () =>
		requireMethods(spec, plugin),
	);
	let proposals: {
		poolId: string;
		dimensions: Parameters<typeof capacityRaised>[0];
	}[] = [];
	await r.check("discover returns valid pool proposals", async () => {
		proposals = (await callValid(
			spec,
			plugin,
			r.host,
			"discover",
			{},
		)) as typeof proposals;
		const ids = new Set(proposals.map((p) => p.poolId));
		assert(ids.size === proposals.length, "duplicate pool ids in discover");
	});
	await r.check(
		"observe returns valid observations for every pool",
		async () => {
			for (const p of proposals) {
				const o = (await callValid(spec, plugin, r.host, "observe", {
					poolId: p.poolId,
				})) as {
					poolId: string;
				};
				assert(
					o.poolId === p.poolId,
					`observe(${p.poolId}) answered for ${o.poolId}`,
				);
			}
		},
	);
	await r.check("observations never raise capacity", async () => {
		for (const p of proposals) {
			const o = (await callValid(spec, plugin, r.host, "observe", {
				poolId: p.poolId,
			})) as {
				dimensions: Parameters<typeof capacityRaised>[1];
			};
			const raised = capacityRaised(p.dimensions, o.dimensions);
			assert(
				raised.length === 0,
				`${p.poolId} raised capacity of ${raised.join(", ")}`,
			);
		}
	});
	await r.check("observe rejects a malformed pool id", async () =>
		rejectsMalformed(plugin, r.host, "observe", { poolId: "NOT A POOL" }),
	);
	if (fn(plugin, "quote") && proposals[0]) {
		const first = proposals[0];
		await r.check("quote returns a valid quote", async () => {
			await callValid(spec, plugin, r.host, "quote", {
				poolId: first.poolId,
				shape: subject.machine?.shape ?? { units: 1, attributes: {} },
			});
		});
	}
	if (fn(plugin, "usage") && proposals[0]) {
		const first = proposals[0];
		await r.check("usage returns a valid report", async () => {
			await callValid(spec, plugin, r.host, "usage", {
				target: { poolId: first.poolId, from: 0, to: r.host.clock.now() },
			});
		});
	}
}

async function machineSuite(r: Runner, spec: ContractSpec, subject: Subject) {
	await resourceSuite(r, spec, subject);
	const plugin = await subject.create();
	const pool = subject.machine?.poolId ?? "fake.machines";
	const base = {
		leaseId: "lease-conf",
		poolId: pool,
		shape: subject.machine?.shape ?? { units: 1, attributes: {} },
		ownershipToken: "mfw-conformance-token-1",
		sshPublicKey: "ssh-ed25519 AAAAconformance",
	};
	let externalId = "";
	await r.check(
		"provision is idempotent under a repeated operationId",
		async () => {
			const a = (await callValid(
				spec,
				plugin,
				r.host,
				"provision",
				base,
				"prov-1",
			)) as {
				status: string;
				externalId?: string;
			};
			const b = (await callValid(
				spec,
				plugin,
				r.host,
				"provision",
				base,
				"prov-1",
			)) as {
				status: string;
				externalId?: string;
			};
			assert(
				JSON.stringify(a) === JSON.stringify(b),
				"a repeated operationId changed the result",
			);
			if (a.status === "created" && a.externalId) externalId = a.externalId;
			const inv = (await callValid(spec, plugin, r.host, "inventory", {
				poolId: pool,
			})) as {
				ownershipToken: string | null;
			}[];
			const mine = inv.filter((o) => o.ownershipToken === base.ownershipToken);
			assert(mine.length <= 1, "a repeated operationId created two machines");
		},
	);
	if (subject.restart) {
		await r.check(
			"after a crash, inventory finds the object by its token",
			async () => {
				const again = await (subject.restart as () => Promise<object>)();
				const inv = (await callValid(spec, again, r.host, "inventory", {
					poolId: pool,
				})) as {
					ownershipToken: string | null;
					externalId: string;
				}[];
				const found = inv.find((o) => o.ownershipToken === base.ownershipToken);
				assert(found, "inventory lost an object the core had created");
				externalId = found.externalId;
			},
		);
	} else
		r.skip(
			"after a crash, inventory finds the object by its token",
			"subject has no restart()",
		);
	await r.check(
		"teardown is proven by a later inventory, not by its own reply",
		async () => {
			assert(externalId, "no machine was created to tear down");
			await callValid(
				spec,
				plugin,
				r.host,
				"teardown",
				{
					externalId,
					ownershipToken: base.ownershipToken,
				},
				"tear-1",
			);
			const inv = (await callValid(spec, plugin, r.host, "inventory", {
				poolId: pool,
			})) as {
				externalId: string;
			}[];
			assert(
				!inv.some((o) => o.externalId === externalId),
				"inventory still lists a torn-down machine",
			);
		},
	);
	await r.check("teardown refuses a foreign ownership token", async () => {
		const f = fn(plugin, "provision") as AnyFn;
		const made = (await f(
			{ ...base, ownershipToken: "mfw-conformance-token-2" },
			r.host.context("prov-2"),
		)) as {
			externalId?: string;
		};
		if (!made.externalId) return "provision did not create; nothing to refuse";
		const res = (await callValid(
			spec,
			plugin,
			r.host,
			"teardown",
			{
				externalId: made.externalId,
				ownershipToken: "mfw-conformance-other-9",
			},
			"tear-foreign",
		)) as { status: string };
		assert(res.status !== "gone", "teardown deleted an object it does not own");
	});
	r.skip("deadline and cancel behaviour", "needs the plugin host (R6)");
	r.skip(
		"no network outside the broker under the real profile",
		"needs the plugin host and sandbox (R6)",
	);
}

async function simpleSuite(
	r: Runner,
	spec: ContractSpec,
	subject: Subject,
	run: (plugin: object) => Promise<void>,
) {
	const plugin = await subject.create();
	await r.check("implements the required methods", async () =>
		requireMethods(spec, plugin),
	);
	await run(plugin);
}

/**
 * Runs the suite for one kind against a subject. The harness kind is a data
 * manifest, not a runtime plugin: its suite is `runHarnessConformance`.
 */
export async function runConformance(
	kind: PluginKind,
	subject: Subject,
): Promise<CheckResult[]> {
	const host = subject.host ?? new FakeHost();
	const r = new Runner(kind, host);
	const spec = SPECS[kind];
	switch (kind) {
		case "resource":
			await resourceSuite(r, spec, subject);
			r.skip("deadline and cancel behaviour", "needs the plugin host (R6)");
			break;
		case "machine":
			await machineSuite(r, spec, subject);
			break;
		case "provider":
			await simpleSuite(r, spec, subject, async (p) => {
				await r.check(
					"catalogue is valid and models reference declared endpoints",
					async () => {
						const c = (await callValid(spec, p, host, "catalogue", {})) as {
							endpoints: { id: string }[];
							models: { endpointId: string }[];
						};
						const ids = new Set(c.endpoints.map((e) => e.id));
						for (const m of c.models)
							assert(
								ids.has(m.endpointId),
								`model names unknown endpoint ${m.endpointId}`,
							);
					},
				);
				await r.check("pricing is valid or null", async () => {
					await callValid(spec, p, host, "pricing", {});
				});
				if (fn(p, "account"))
					await r.check("account is valid", async () => {
						await callValid(spec, p, host, "account", {});
					});
			});
			break;
		case "connector":
			await simpleSuite(r, spec, subject, async (p) => {
				const doc = {
					id: "DOC-1",
					type: "task",
					title: "A task",
					fields: {},
					body: "",
					updatedAt: 1,
				};
				await r.check("map is pure", async () => {
					const a = await callValid(spec, p, host, "map", { doc });
					const b = await callValid(spec, p, host, "map", { doc });
					assert(
						JSON.stringify(a) === JSON.stringify(b),
						"map returned different upserts for one document",
					);
				});
				await r.check(
					"push is idempotent under a repeated operationId",
					async () => {
						const op = (await callValid(spec, p, host, "map", { doc })) as
							| object
							| null;
						if (!op) return "map returned null; nothing to push";
						const a = await callValid(
							spec,
							p,
							host,
							"push",
							{ ops: [op] },
							"push-1",
						);
						const b = await callValid(
							spec,
							p,
							host,
							"push",
							{ ops: [op] },
							"push-1",
						);
						assert(
							JSON.stringify(a) === JSON.stringify(b),
							"a repeated push changed the result",
						);
					},
				);
				await r.check("pull returns valid changes and a cursor", async () => {
					await callValid(spec, p, host, "pull", { cursor: null });
				});
			});
			break;
		case "notify":
			await simpleSuite(r, spec, subject, async (p) => {
				await r.check("send returns a valid delivery result", async () => {
					await callValid(spec, p, host, "send", {
						notification: {
							type: "task.completed",
							attentionClass: "know",
							text: "done",
							at: 1,
						},
					});
				});
				await r.check("send rejects a malformed notification", async () =>
					rejectsMalformed(p, host, "send", {
						notification: { type: "" },
					}),
				);
			});
			break;
		case "action":
			await simpleSuite(r, spec, subject, async (p) => {
				await r.check("run returns a valid result", async () => {
					await callValid(spec, p, host, "run", {
						view: {
							definitionId: "def-1",
							deliveryId: "del-1",
							projectName: "demo",
							event: { type: "merge.completed", at: 1, summary: "merged" },
						},
					});
				});
				await r.check(
					"run rejects a view carrying extra host state",
					async () => {
						await rejectsMalformed(p, host, "run", {
							view: { projectRoot: "/x" },
						});
					},
				);
			});
			break;
		case "facts":
			await simpleSuite(r, spec, subject, async (p) => {
				let tools: { name: string }[] = [];
				await r.check("describe returns valid tools", async () => {
					tools = (await callValid(
						spec,
						p,
						host,
						"describe",
						{},
					)) as typeof tools;
				});
				await r.check(
					"query returns a valid result for each tool",
					async () => {
						for (const t of tools)
							await callValid(spec, p, host, "query", {
								tool: t.name,
								args: {},
							});
					},
				);
			});
			break;
		case "harness":
			r.skip(
				"harness manifests",
				"a manifest is data: use runHarnessConformance (conformance/harness.ts)",
			);
			break;
	}
	return r.results;
}

export function failures(results: readonly CheckResult[]): CheckResult[] {
	return results.filter((x) => x.status === "fail");
}
