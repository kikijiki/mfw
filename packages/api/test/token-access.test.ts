import { describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "@mfw/daemon/auth/service";
import { TOKEN_SCOPES, type TokenScope } from "@mfw/daemon/auth/tokens";
import type { Orchestrator } from "@mfw/daemon/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { appRouter } from "../src/root.ts";
import {
	OWNER_ONLY_PROCEDURES,
	TOKEN_PROCEDURES,
	tokenRefusal,
} from "../src/token-access.ts";
import type { TokenAuditSink } from "../src/trpc.ts";

const procedures = Object.entries(
	(
		appRouter as unknown as {
			_def: { procedures: Record<string, { _def: { type: string } }> };
		}
	)._def.procedures,
).map(([path, p]) => ({ path, type: p._def.type }));

const token = (
	scopes: readonly TokenScope[],
	project: string | null = null,
): TokenPrincipal => ({
	kind: "token",
	id: "token:t1",
	tokenId: "t1",
	name: "test",
	scopes,
	project,
});

/** Inputs a rule accepts, so an in-scope call gets past the rule. */
const VALID: Record<string, Record<string, unknown>> = {
	"tasks.create": { title: "x" },
	"tasks.update": { id: "T1", patch: { title: "y" } },
	"tasks.criteria": { id: "T1", op: { op: "add", text: "z" } },
	"tasks.move": { id: "T1", to: "backlog" },
	"runs.startTask": { taskId: "T1" },
	"runs.stop": { runId: "R1" },
};

const orchestrator = {
	list: () => [],
	get: (name: string) => {
		throw new Error(`no project ${name}`);
	},
} as unknown as Orchestrator;

function sink(): TokenAuditSink & { rows: string[] } {
	const rows: string[] = [];
	return {
		rows,
		begin: async (e) => {
			rows.push(`${e.path}:${e.outcome ?? "started"}`);
			return rows.length;
		},
		finish: async (id, outcome) => {
			rows[id - 1] = `${rows[id - 1]?.split(":")[0]}:${outcome}`;
		},
	};
}

async function call(
	principal: TokenPrincipal,
	path: string,
	type: string,
	input: unknown,
	tokenAudit: TokenAuditSink | undefined = sink(),
	rawBody?: string,
): Promise<string> {
	const encoded = rawBody ?? JSON.stringify(superjson.serialize(input));
	const url = `http://localhost/trpc/${path}`;
	const req =
		type === "mutation"
			? new Request(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: encoded,
				})
			: new Request(`${url}?input=${encodeURIComponent(encoded)}`);
	const res = await fetchRequestHandler({
		endpoint: "/trpc",
		router: appRouter,
		req,
		createContext: () => ({ orchestrator, principal, tokenAudit }),
		onError() {},
	});
	const text = await res.text();
	return /"code":"([A-Z_]+)"/.exec(text)?.[1] ?? `HTTP_${res.status}`;
}

describe("every procedure is declared", () => {
	test("the enumeration is real", () => {
		expect(procedures.length).toBeGreaterThan(200);
	});

	for (const { path } of procedures)
		test(`${path} declares a scope or is owner-only, not both`, () => {
			expect(
				Number(TOKEN_PROCEDURES.has(path)) +
					Number(OWNER_ONLY_PROCEDURES.has(path)),
			).toBe(1);
		});

	test("the manifest names no procedure that does not exist", () => {
		const real = new Set(procedures.map((p) => p.path));
		expect([...TOKEN_PROCEDURES.keys()].filter((p) => !real.has(p))).toEqual(
			[],
		);
		expect([...OWNER_ONLY_PROCEDURES].filter((p) => !real.has(p))).toEqual([]);
	});

	test("an undeclared procedure is refused", () => {
		expect(
			tokenRefusal(token(TOKEN_SCOPES), "new.procedure", {}),
		).not.toBeNull();
		expect(tokenRefusal(token(TOKEN_SCOPES), "__proto__", {})).not.toBeNull();
	});

	test("administrative and approval surfaces stay owner-only", () => {
		const reachable = [...TOKEN_PROCEDURES.keys()];
		const forbidden =
			/^(settings|hosts|hostResources|triggers|runpod|openrouter|boardConfig|budgets|holds|resources)\.|^system\.(addProject|removeProject|scheduler\.(set|setGlobal|kick|hold))$|^tasks\.(approve|reject|discard|remove|wipe|promoteReady|setSpec|captureQuick|moveMany)$|^runs\.(respondApproval|startAction|startPlan|startImport|steer|reroute|discard)$|^review\.mergeJob|^brain\.|^sessions\./;
		expect(reachable.filter((p) => forbidden.test(p))).toEqual([]);
	});

	test("no write is reachable without a field rule, except stopping a run", () => {
		const writes = procedures.filter(
			(p) => p.type === "mutation" && TOKEN_PROCEDURES.has(p.path),
		);
		expect(writes.length).toBeGreaterThan(0);
		for (const w of writes)
			expect(TOKEN_PROCEDURES.get(w.path)?.check).toBeDefined();
	});
});

describe("scope matrix over the real router", () => {
	for (const { path, type } of procedures) {
		const rule = TOKEN_PROCEDURES.get(path);
		const input = { project: "alpha", ...VALID[path] };

		if (!rule) {
			test(`${path}: refused to a token with every scope`, async () => {
				expect(await call(token(TOKEN_SCOPES), path, type, input)).toBe(
					"FORBIDDEN",
				);
			});
			continue;
		}

		for (const scope of TOKEN_SCOPES) {
			const allowed = scope === rule.scope;
			test(`${path}: ${scope} is ${allowed ? "allowed" : "refused"}`, async () => {
				const code = await call(token([scope]), path, type, input);
				if (allowed) expect(code).not.toBe("FORBIDDEN");
				else expect(code).toBe("FORBIDDEN");
			});
		}

		if (rule.binding === "project") {
			test(`${path}: a token for another project is refused`, async () => {
				expect(await call(token(TOKEN_SCOPES, "beta"), path, type, input)).toBe(
					"FORBIDDEN",
				);
			});
			test(`${path}: a token for this project passes the binding`, async () => {
				expect(
					await call(token(TOKEN_SCOPES, "alpha"), path, type, input),
				).not.toBe("FORBIDDEN");
			});
		} else {
			test(`${path}: spans projects, so a project token is refused`, async () => {
				expect(await call(token(TOKEN_SCOPES, "alpha"), path, type, {})).toBe(
					"FORBIDDEN",
				);
			});
		}
	}
});

describe("write rules", () => {
	const write = token(["board:write"]);
	const both = token(["board:write", "runs:act"]);
	const refused = (p: TokenPrincipal, path: string, input: unknown) =>
		expect(tokenRefusal(p, path, input)).not.toBeNull();
	const allowed = (p: TokenPrincipal, path: string, input: unknown) =>
		expect(tokenRefusal(p, path, input)).toBeNull();

	for (const field of [
		"verification",
		"dod",
		"provider",
		"model",
		"modelTier",
		"executionTarget",
		"requiresResources",
		"localStagingResources",
		"owns",
		"reopenWhen",
		"requireReview",
		"__proto__",
	]) {
		test(`create refuses '${field}', even with every scope`, () => {
			refused(
				token(TOKEN_SCOPES),
				"tasks.create",
				JSON.parse(`{"project":"a","title":"t","${field}":null}`),
			);
		});
		test(`update refuses patch '${field}', even with every scope`, () => {
			refused(
				token(TOKEN_SCOPES),
				"tasks.update",
				JSON.parse(`{"project":"a","id":"T","patch":{"${field}":null}}`),
			);
		});
	}

	test("a shell command cannot enter through a task", () => {
		refused(write, "tasks.create", {
			project: "a",
			title: "t",
			verification: {
				verifier: "deterministic",
				checks: [{ run: "touch /tmp/owned", expect_exit: 0 }],
			},
		});
	});

	test("create stays in backlog, unchecked", () => {
		allowed(write, "tasks.create", { project: "a", title: "t" });
		allowed(write, "tasks.create", {
			project: "a",
			title: "t",
			status: "backlog",
		});
		refused(write, "tasks.create", {
			project: "a",
			title: "t",
			status: "ready",
		});
		refused(write, "tasks.create", {
			project: "a",
			title: "t",
			criteria: [{ text: "c", checked: true }],
		});
	});

	test("moving to ready needs runs:act; other columns are closed", () => {
		const move = (to: string) => ({ project: "a", id: "T", to });
		allowed(write, "tasks.move", move("backlog"));
		refused(write, "tasks.move", move("ready"));
		allowed(both, "tasks.move", move("ready"));
		for (const to of ["in_progress", "review", "done", "archived", "blocked"])
			refused(both, "tasks.move", move(to));
	});

	test("a move cannot kill a run or discard work", () => {
		for (const flag of ["cancelRun", "discard"])
			refused(both, "tasks.move", {
				project: "a",
				id: "T",
				to: "backlog",
				[flag]: true,
			});
	});

	test("dependencies change only with runs:act", () => {
		const patch = { project: "a", id: "T", patch: { dependsOn: [] } };
		refused(write, "tasks.update", patch);
		allowed(both, "tasks.update", patch);
	});

	test("checking a criterion needs runs:act", () => {
		const op = (o: Record<string, unknown>) => ({
			project: "a",
			id: "T",
			op: o,
		});
		allowed(write, "tasks.criteria", op({ op: "add", text: "x" }));
		allowed(
			write,
			"tasks.criteria",
			op({ op: "edit", selector: "c1", text: "x" }),
		);
		refused(
			write,
			"tasks.criteria",
			op({ op: "add", text: "x", checked: true }),
		);
		for (const o of ["toggle", "set", "remove"]) {
			refused(write, "tasks.criteria", op({ op: o, selector: "c1" }));
			allowed(both, "tasks.criteria", op({ op: o, selector: "c1" }));
		}
	});

	test("starting a run cannot choose the model", () => {
		const act = token(["runs:act"]);
		allowed(act, "runs.startTask", { project: "a", taskId: "T" });
		refused(act, "runs.startTask", { project: "a", taskId: "T", model: "x" });
	});

	test("run lists cannot include the brain's internal runs", () => {
		refused(token(["runs:act"]), "runs.list", {
			project: "a",
			includeInternal: true,
		});
	});

	test("the rules read the input after the transformer", async () => {
		// superjson metadata rewrites `status` to the value of `title`.
		const body = JSON.stringify({
			json: { project: "alpha", title: "ready", status: "backlog" },
			meta: { referentialEqualities: { title: ["status"] } },
		});
		expect(
			await call(
				token(["board:write"]),
				"tasks.create",
				"mutation",
				null,
				sink(),
				body,
			),
		).toBe("FORBIDDEN");
	});

	test("superjson metadata cannot swap the project past the binding", async () => {
		const body = JSON.stringify({
			json: { project: "alpha", title: "beta" },
			meta: { referentialEqualities: { title: ["project"] } },
		});
		expect(
			await call(
				token(["board:write"], "alpha"),
				"tasks.create",
				"mutation",
				null,
				sink(),
				body,
			),
		).toBe("FORBIDDEN");
	});
});

describe("audit", () => {
	test("a mutation is recorded before it runs, with its outcome", async () => {
		const audit = sink();
		await call(
			token(["board:write"]),
			"tasks.create",
			"mutation",
			{ project: "alpha", title: "x" },
			audit,
		);
		expect(audit.rows).toEqual(["tasks.create:error"]);
	});

	test("a refused call is recorded", async () => {
		const audit = sink();
		await call(
			token(["status:read"]),
			"settings.update",
			"mutation",
			{ project: "alpha" },
			audit,
		);
		expect(audit.rows).toEqual(["settings.update:refused"]);
	});

	test("a mutation that cannot be audited does not run", async () => {
		const audit: TokenAuditSink = {
			begin: async () => {
				throw new Error("disk full");
			},
			finish: async () => {},
		};
		expect(
			await call(
				token(["board:write"]),
				"tasks.create",
				"mutation",
				{ project: "alpha", title: "x" },
				audit,
			),
		).toBe("INTERNAL_SERVER_ERROR");
	});

	test("a token call with no audit sink is refused", async () => {
		const res = await fetchRequestHandler({
			endpoint: "/trpc",
			router: appRouter,
			req: new Request(
				`http://localhost/trpc/system.health?input=${encodeURIComponent(JSON.stringify(superjson.serialize({})))}`,
			),
			createContext: () => ({
				orchestrator,
				principal: token(TOKEN_SCOPES),
			}),
			onError() {},
		});
		expect(res.status).toBe(403);
	});
});
