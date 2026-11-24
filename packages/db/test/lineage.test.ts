import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { relationOf } from "../src/lineage.ts";
import { type RunKind, runs } from "../src/schema.ts";

async function _withDb(
	fn: (h: ProjectDbHandle, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-lineage-"));
	const h = await openProjectDb(dir);
	try {
		await fn(h, dir);
	} finally {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
}

let seq = 0;
/** A pre-lineage row: relation/chain_root_id/origin_ref are NULL. */
async function _oldRun(
	h: ProjectDbHandle,
	id: string,
	kind: RunKind,
	label: string,
	over: { taskId?: string; parentRunId?: string } = {},
) {
	await h.db.insert(runs).values({
		id,
		kind,
		label,
		model: "m",
		cwd: "/tmp",
		startedAt: new Date(1_000_000 + seq++),
		...over,
	});
}

describe("relationOf", () => {
	test("maps kind, label suffix and parent to a relation", () => {
		const r = (kind: RunKind, label: string, parent?: string) =>
			relationOf({ kind, label, parentRunId: parent });
		expect(r("task", "T-1")).toBe("fresh");
		expect(r("task", "T-1", "p")).toBe("continue");
		expect(r("task", "T-1#repair", "p")).toBe("repair");
		expect(r("task", "T-1#resume", "p")).toBe("resume");
		expect(r("task", "T-1#answer", "p")).toBe("answer");
		expect(r("task", "T-1#unblock", "p")).toBe("unblock");
		expect(r("plan", "plan")).toBe("fresh");
		expect(r("plan", "plan#expand")).toBe("fresh");
		expect(r("plan", "plan#replan", "p")).toBe("replan");
		expect(r("brain", "critic:abc", "p")).toBe("judge");
		expect(r("repair", "recovery:inc-1")).toBe("recovery");
		expect(r("action", "session")).toBe("session");
		expect(r("action", "action")).toBe("fresh");
		expect(r("import", "import")).toBe("fresh");
	});
});
