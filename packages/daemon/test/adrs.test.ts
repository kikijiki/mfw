import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskIdRe } from "@mfw/db/ids";
import {
	AdrConflictError,
	AdrImmutableError,
	AdrService,
	AdrTransitionError,
	adrIdRe,
} from "../src/adrs.ts";
import { silentLogger } from "../src/log.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
	const mfwDir = await mkdtemp(join(tmpdir(), "mfw-adrs-"));
	dirs.push(mfwDir);
	const svc = new AdrService({ mfwDir, taskKey: "MFW", log: silentLogger() });
	let touched = 0;
	svc.onBoardChanged = () => touched++;
	return { svc, mfwDir, adrDir: join(mfwDir, "adrs"), touched: () => touched };
}

describe("AdrService", () => {
	test("create numbers by max+1 and writes slugged file", async () => {
		const { svc, adrDir, touched } = await setup();
		const a = await svc.create({ title: "Use SQLite for the index" });
		expect(a.id).toBe("MFW-ADR-1");
		expect(a.status).toBe("proposed");
		expect(await readdir(adrDir)).toEqual([
			"MFW-ADR-1-use-sqlite-for-the-index.md",
		]);
		await writeFile(
			join(adrDir, "0007-x.md"),
			"---\nmfw: 1\nid: MFW-ADR-7\ntitle: X\nstatus: proposed\n---\n",
		);
		const b = await svc.create({ title: "Next" });
		expect(b.id).toBe("MFW-ADR-8");
		expect(touched()).toBe(2);
	});

	test("ids carry the project key and never overlap the task id grammar", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "Keyed" });
		expect(a.id).toBe("MFW-ADR-1");
		expect(adrIdRe("MFW").test(a.id)).toBe(true);
		expect(taskIdRe("MFW").test(a.id)).toBe(false);
		expect(adrIdRe("MFW").test("MFW-7")).toBe(false);
		expect(adrIdRe("MFW").test("OTHER-ADR-1")).toBe(false);
	});

	test("the id is the frontmatter id, same identity rule tasks already use", async () => {
		// Unlike the old filename-derived AdrService, `@mfw/board-core` resolves
		// every document's identity from its frontmatter `id:` (same rule tasks
		// already followed) — one consistent rule across document types now,
		// rather than ADRs being the one type that distrusted its own frontmatter.
		const { svc, adrDir } = await setup();
		await mkdir(adrDir, { recursive: true });
		await writeFile(
			join(adrDir, "0003-liar.md"),
			"---\nmfw: 1\nid: MFW-ADR-99\ntitle: Liar\nstatus: proposed\n---\n",
		);
		expect((await svc.list()).map((r) => r.id)).toEqual(["MFW-ADR-99"]);
		expect(await svc.get("MFW-ADR-99")).not.toBeNull();
	});

	test("edit while proposed, conflict on stale hash", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "One", body: "hi" });
		const b = await svc.update(a.id, { title: "Two", body: "yo" }, a.hash);
		expect(b.title).toBe("Two");
		// The path is frozen at creation (MFW-ADR-22): retitling never renames the file.
		expect((await svc.list()).map((r) => r.fileName)).toEqual([
			"MFW-ADR-1-one.md",
		]);
		expect(svc.update(a.id, { body: "z" }, a.hash)).rejects.toBeInstanceOf(
			AdrConflictError,
		);
	});

	test("external edits are picked up", async () => {
		const { svc, adrDir } = await setup();
		const a = await svc.create({ title: "One", body: "hi" });
		const path = join(adrDir, a.fileName);
		await writeFile(
			path,
			(await readFile(path, "utf8")).replace("hi", "edited"),
		);
		const again = await svc.get(a.id);
		expect(again?.body).toBe("edited");
		expect(again?.hash).not.toBe(a.hash);
	});

	test("accept freezes title and body", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "One" });
		const acc = await svc.setStatus(a.id, "accepted", a.hash);
		expect(acc.status).toBe("accepted");
		expect(svc.update(a.id, { body: "x" }, acc.hash)).rejects.toBeInstanceOf(
			AdrImmutableError,
		);
		expect(svc.setStatus(a.id, "rejected")).rejects.toBeInstanceOf(
			AdrTransitionError,
		);
	});

	test("accept with stale hash conflicts", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "One" });
		await svc.update(a.id, { body: "changed" }, a.hash);
		expect(svc.setStatus(a.id, "accepted", a.hash)).rejects.toBeInstanceOf(
			AdrConflictError,
		);
	});

	test("supersede links both ways and is re-runnable", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "Old" });
		expect(svc.supersede(a.id, { title: "New" })).rejects.toBeInstanceOf(
			AdrTransitionError,
		);
		await svc.setStatus(a.id, "accepted");
		const { old, next } = await svc.supersede(a.id, { title: "New" });
		expect(old.status).toBe("superseded");
		expect(old.supersededBy).toBe(next.id);
		expect(next.supersedes).toBe(a.id);
		expect(next.status).toBe("proposed");
		expect(svc.supersede(a.id, { title: "Again" })).rejects.toBeInstanceOf(
			AdrTransitionError,
		);
		expect(svc.setStatus(a.id, "accepted")).rejects.toBeInstanceOf(
			AdrTransitionError,
		);
	});

	test("supersede resumes after a crash between the two writes", async () => {
		const { svc, adrDir } = await setup();
		const a = await svc.create({ title: "Old" });
		await svc.setStatus(a.id, "accepted");
		// Simulate: new ADR written, old not yet marked.
		await writeFile(
			join(adrDir, "0002-new.md"),
			"---\nmfw: 1\nid: MFW-ADR-2\ntitle: New\nstatus: proposed\ndate: 2026-01-01\nsupersedes: MFW-ADR-1\nsuperseded_by: null\n---\n",
		);
		const { old, next } = await svc.supersede(a.id, { title: "Ignored" });
		expect(next.id).toBe("MFW-ADR-2");
		expect(old.supersededBy).toBe("MFW-ADR-2");
		expect((await svc.list()).length).toBe(2);
	});

	test("delete only proposed or rejected", async () => {
		const { svc } = await setup();
		const a = await svc.create({ title: "A" });
		const b = await svc.create({ title: "B" });
		const c = await svc.create({ title: "C" });
		await svc.setStatus(b.id, "accepted");
		await svc.setStatus(c.id, "rejected");
		await svc.remove(a.id);
		await svc.remove(c.id);
		expect(svc.remove(b.id)).rejects.toBeInstanceOf(AdrTransitionError);
		expect((await svc.list()).map((r) => r.id)).toEqual([b.id]);
	});

	test("malformed file is listed with an error, others survive", async () => {
		// Needs the `mfw:` marker to be visible to `BoardStore` at all (a file
		// with none, like plain prose, isn't an mfw document — see MFW-ADR-22) —
		// broken in a way the marker doesn't save it from: no `title`.
		const { svc, adrDir } = await setup();
		await svc.create({ title: "Good" });
		await writeFile(
			join(adrDir, "MFW-ADR-2-bad.md"),
			"---\nmfw: 1\nid: MFW-ADR-2\nstatus: proposed\n---\n",
		);
		const all = await svc.list();
		expect(all.length).toBe(2);
		expect(all[0]?.error).toBeUndefined();
		expect(all[1]?.error).toBeTruthy();
		expect(all[1]?.id).toBe("MFW-ADR-2");
	});
});
