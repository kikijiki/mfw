import { describe, expect, test } from "bun:test";
import { BoardConfigError, parseBoardConfig } from "../src/config.ts";

/** A tk-shaped config: no mfw vocabulary anywhere, matching board-tool-design.md's draft. */
const TK_CONFIG = {
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "TK" },
			fields: {
				status: {
					values: ["planned", "doing", "done", "deferred", "dropped"],
					default: "planned",
				},
				priority: { values: ["P0", "P1", "P2"], optional: true },
				parent: { ref: "task", optional: true },
				dependencies: {
					ref: "task",
					list: true,
					acyclic: true,
					optional: true,
				},
			},
		},
		spec: {
			layout: "flat",
			dir: "specs",
			id: { strategy: "inherit", from: "task" },
			fields: {
				status: { values: ["active", "archived"], default: "active" },
			},
		},
	},
};

describe("parseBoardConfig: generic, tk-shaped config", () => {
	test("accepts a config with no mfw-specific vocabulary", () => {
		const cfg = parseBoardConfig(TK_CONFIG);
		expect(cfg.types.task?.id).toEqual({
			strategy: "own-sequence",
			key: "TK",
		});
		expect(cfg.types.spec?.id).toEqual({ strategy: "inherit", from: "task" });
		expect(cfg.types.task?.fields.dependencies).toMatchObject({
			kind: "ref",
			ref: ["task"],
			list: true,
			acyclic: true,
		});
	});

	test("an own-sequence id must declare a key: ids are never bare numbers", () => {
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					task: {
						layout: "flat",
						dir: "tasks",
						id: { strategy: "own-sequence", pad: 3 },
						fields: { title: {} },
					},
				},
			}),
		).toThrow(BoardConfigError);
	});

	test("accepts id.pad on an own-sequence id", () => {
		const cfg = structuredClone(TK_CONFIG);
		(cfg.types.task.id as { pad?: number }).pad = 4;
		expect(parseBoardConfig(cfg).types.task?.id).toEqual({
			strategy: "own-sequence",
			key: "TK",
			pad: 4,
		});
	});

	test("rejects an out-of-range id.pad", () => {
		const bad = structuredClone(TK_CONFIG);
		(bad.types.task.id as { pad?: number }).pad = 0;
		expect(() => parseBoardConfig(bad)).toThrow(BoardConfigError);
		(bad.types.task.id as { pad?: number }).pad = 11;
		expect(() => parseBoardConfig(bad)).toThrow(BoardConfigError);
	});

	test("rejects a reserved field name", () => {
		const bad = structuredClone(TK_CONFIG);
		// biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
		(bad.types.task.fields as any).id = { values: ["x"] };
		expect(() => parseBoardConfig(bad)).toThrow(BoardConfigError);
	});

	test("rejects a ref field pointing at an undeclared type", () => {
		const bad = structuredClone(TK_CONFIG);
		bad.types.task.fields.parent = { ref: "nonexistent", optional: true };
		expect(() => parseBoardConfig(bad)).toThrow(/not a declared type/);
	});

	test("rejects acyclic on a field that is not a self-referential list", () => {
		const bad = structuredClone(TK_CONFIG);
		// biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
		(bad.types.task.fields as any).parent = {
			ref: "task",
			acyclic: true,
			optional: true,
		};
		expect(() => parseBoardConfig(bad)).toThrow(/self-referential list ref/);
	});

	test("rejects an inherit strategy whose source type does not exist", () => {
		const bad = structuredClone(TK_CONFIG);
		// biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
		(bad.types.spec as any).id = { strategy: "inherit", from: "ghost" };
		expect(() => parseBoardConfig(bad)).toThrow(/not a declared type/);
	});

	test("rejects directory layout without a primary file", () => {
		const bad = structuredClone(TK_CONFIG) as Record<string, unknown>;
		(bad.types as Record<string, unknown>).task = {
			...TK_CONFIG.types.task,
			layout: "directory",
		};
		expect(() => parseBoardConfig(bad)).toThrow(/requires 'primary'/);
	});

	test("rejects an unsupported mfw config version", () => {
		expect(() => parseBoardConfig({ ...TK_CONFIG, mfw: 2 })).toThrow();
	});
});

describe("parseBoardConfig: split ids are gone", () => {
	test("id.split is no longer a recognized key", () => {
		const bad = structuredClone(TK_CONFIG);
		(bad.types.task.id as Record<string, unknown>).split = "lower";
		expect(() => parseBoardConfig(bad)).toThrow(BoardConfigError);
	});
});

const typeOf = (extra: Record<string, unknown>) => ({
	layout: "flat",
	dir: "x",
	id: { strategy: "own-sequence", key: "TK" },
	fields: { title: {}, ...extra },
});

describe("parseBoardConfig: ref unions", () => {
	test("a ref normalizes to a list of types, or the string any", () => {
		const cfg = parseBoardConfig({
			mfw: 1,
			types: {
				epic: typeOf({ up: { ref: ["epic", "task"], optional: true } }),
				task: typeOf({
					one: { ref: "epic", optional: true },
					all: { ref: "any", optional: true },
				}),
			},
		});
		expect(cfg.types.epic?.fields.up).toMatchObject({ ref: ["epic", "task"] });
		expect(cfg.types.task?.fields.one).toMatchObject({ ref: ["epic"] });
		expect(cfg.types.task?.fields.all).toMatchObject({ ref: "any" });
	});

	test("every named type must exist, and any cannot join a list", () => {
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: { a: typeOf({ r: { ref: ["a", "ghost"], optional: true } }) },
			}),
		).toThrow(/'ghost' is not a declared type/);
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: { a: typeOf({ r: { ref: ["a", "any"], optional: true } }) },
			}),
		).toThrow(/"any" cannot be mixed/);
	});

	test("acyclic still needs a self-referential list ref", () => {
		const ok = {
			mfw: 1,
			types: {
				a: typeOf({ d: { ref: ["a"], list: true, acyclic: true } }),
			},
		};
		expect(() => parseBoardConfig(ok)).not.toThrow();
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					a: typeOf({ d: { ref: ["a", "b"], list: true, acyclic: true } }),
					b: typeOf({}),
				},
			}),
		).toThrow(/self-referential list ref/);
	});
});

describe("parseBoardConfig: hierarchy", () => {
	const types = (over: Record<string, unknown> = {}) => ({
		epic: typeOf({
			parent: { ref: ["epic"], optional: true },
			children: { ref: ["epic", "task"], list: true },
		}),
		task: typeOf({
			parent: { ref: ["epic", "task"], optional: true },
			children: { ref: ["task"], list: true },
		}),
		...over,
	});
	const cfg = (hierarchy: unknown, t = types()) => ({
		mfw: 1,
		types: t,
		hierarchy,
	});
	const base = { parent: "parent", children: "children" };

	test("accepts a valid hierarchy and exposes it", () => {
		const parsed = parseBoardConfig(
			cfg({
				...base,
				maxDepth: 3,
				rules: [
					{ child: "task", parents: ["epic", "task"] },
					{ child: "epic", parents: ["epic"] },
				],
			}),
		);
		expect(parsed.hierarchy).toEqual({
			...base,
			maxDepth: 3,
			rules: [
				{
					child: { type: "task" },
					parents: [{ type: "epic" }, { type: "task" }],
				},
				{ child: { type: "epic" }, parents: [{ type: "epic" }] },
			],
		});
		expect(
			parseBoardConfig({ mfw: 1, types: types() }).hierarchy,
		).toBeUndefined();
	});

	test("an empty parents list is accepted and means the type may not have a parent", () => {
		const parsed = parseBoardConfig(
			cfg({
				...base,
				rules: [
					{ child: "task", parents: ["epic"] },
					{ child: "epic", parents: [] },
				],
			}),
		);
		expect(parsed.hierarchy?.rules).toEqual([
			{ child: { type: "task" }, parents: [{ type: "epic" }] },
			{ child: { type: "epic" }, parents: [] },
		]);
	});

	test("rejects a non-ref, list parent, or non-list children field", () => {
		const t1 = types({
			task: typeOf({ parent: {}, children: { ref: "task", list: true } }),
		});
		expect(() => parseBoardConfig(cfg(base, t1))).toThrow(
			/single \(non-list\) ref/,
		);
		const t2 = types({
			task: typeOf({
				parent: { ref: "task", list: true },
				children: { ref: "task", list: true },
			}),
		});
		expect(() => parseBoardConfig(cfg(base, t2))).toThrow(
			/single \(non-list\) ref/,
		);
		const t3 = types({
			task: typeOf({
				parent: { ref: "task", optional: true },
				children: { ref: "task" },
			}),
		});
		expect(() => parseBoardConfig(cfg(base, t3))).toThrow(/must be a list ref/);
	});

	test("a type declaring only one of the two fields is rejected", () => {
		const t = types({
			task: typeOf({ parent: { ref: "task", optional: true } }),
		});
		expect(() => parseBoardConfig(cfg(base, t))).toThrow(
			/declares 'parent' but not 'children'/,
		);
	});

	test("no participating type, unknown rule types, and duplicate rules are rejected", () => {
		expect(() => parseBoardConfig(cfg({ parent: "p", children: "c" }))).toThrow(
			/no type declares/,
		);
		expect(() =>
			parseBoardConfig(
				cfg({ ...base, rules: [{ child: "ghost", parents: ["epic"] }] }),
			),
		).toThrow(/'ghost' is not a declared type/);
		expect(() =>
			parseBoardConfig(
				cfg({
					...base,
					rules: [
						{ child: "task", parents: ["epic"] },
						{ child: "task", parents: ["task"] },
					],
				}),
			),
		).toThrow(/more than one rule/);
		expect(() => parseBoardConfig(cfg({ ...base, maxDepth: 0 }))).toThrow();
	});

	test("the parent and children fields must cover the rule's types", () => {
		const narrow = types({
			task: typeOf({
				parent: { ref: ["task"], optional: true },
				children: { ref: ["task"], list: true },
			}),
		});
		expect(() =>
			parseBoardConfig(
				cfg({ ...base, rules: [{ child: "task", parents: ["epic"] }] }, narrow),
			),
		).toThrow(/field 'parent' does not accept 'epic'/);
		const noKids = types({
			epic: typeOf({
				parent: { ref: ["epic"], optional: true },
				children: { ref: ["epic"], list: true },
			}),
		});
		expect(() =>
			parseBoardConfig(
				cfg({ ...base, rules: [{ child: "task", parents: ["epic"] }] }, noKids),
			),
		).toThrow(/field 'children' does not accept 'task'/);
	});
});

describe("parseBoardConfig: required_when and rows", () => {
	test("required_when normalizes to value lists and must name a sibling field", () => {
		const parsed = parseBoardConfig({
			mfw: 1,
			types: {
				a: typeOf({
					status: { values: ["x", "y"], default: "x" },
					why: { required_when: { status: "y" }, optional: true },
					who: { required_when: { status: ["x", "y"] } },
				}),
			},
		});
		expect(parsed.types.a?.fields.why).toMatchObject({
			requiredWhen: { status: ["y"] },
		});
		expect(parsed.types.a?.fields.who).toMatchObject({
			requiredWhen: { status: ["x", "y"] },
		});
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: { a: typeOf({ why: { required_when: { nope: "y" } } }) },
			}),
		).toThrow(/'nope', which is not another declared field/);
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: { a: typeOf({ why: { required_when: { why: "y" } } }) },
			}),
		).toThrow(/not another declared field/);
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					a: typeOf({
						status: { values: ["x", "y"], default: "x" },
						why: { required_when: { status: "y" }, default: "d" },
					}),
				},
			}),
		).toThrow(/cannot be combined with a default/);
	});

	test("rows only applies to a type: json list", () => {
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					a: typeOf({
						r: { type: "json", list: true, rows: { required: ["id"] } },
					}),
				},
			}),
		).not.toThrow();
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					a: typeOf({ r: { type: "json", rows: { required: ["id"] } } }),
				},
			}),
		).toThrow(/'rows' only applies/);
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: { a: typeOf({ r: { list: true, rows: { required: ["id"] } } }) },
			}),
		).toThrow(/'rows' only applies/);
	});
});
