import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { runs } from "@mfw/db/schema";
import { git, gitOk } from "../src/git.ts";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import { MergeQueue, type PushSettings } from "../src/merge-queue.ts";
import {
	type TriggerActionHandler,
	TriggerActionRegistry,
} from "../src/triggers/actions.ts";
import { ArmingStore } from "../src/triggers/arming.ts";
import {
	createScriptAction,
	Semaphore,
} from "../src/triggers/script-action.ts";
import { TriggerService } from "../src/triggers/service.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

/** The whole gate with the real script action: canaries prove what did not run. */

let base: string;
let root: string;
let home: string;
let ran: string;
let evil: string;
let handle: ProjectDbHandle;
let bus: EventBus;
let svc: TriggerService;
let arming: ArmingStore;
/** Runs just before the real handler, inside the delivery. */
let beforeAction: (() => Promise<void>) | null;

const DEF = `---
id: deploy
on: merge.completed
action: script
run: ./deploy.sh
---
`;

const script = (marker: string) => `#!/bin/sh\ntouch "${marker}"\n`;

async function fire(): Promise<void> {
	const sha = await gitOk(["rev-parse", "HEAD"], root);
	const stored = await handle.withTx((tx) =>
		appendEvent(tx, {
			type: "merge.completed",
			runId: "r1",
			payload: { sha, target: "main" },
		} as never),
	);
	bus.publish([stored]);
	await svc.dispatch();
}

const stateOf = async () => (await svc.list()).find((v) => v.id === "deploy");

async function commit(message: string): Promise<void> {
	await gitOk(["add", "-A"], root);
	await gitOk(["commit", "-q", "-m", message], root);
}

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-hxg-")));
	root = join(base, "repo");
	home = join(base, "home");
	ran = join(base, "ran");
	evil = join(base, "evil");
	beforeAction = null;
	await mkdir(join(root, ".mfw", "triggers"), { recursive: true });
	await mkdir(home);
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.email", "t@t"], root);
	await gitOk(["config", "user.name", "t"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	await writeFile(join(root, "deploy.sh"), script(ran), { mode: 0o755 });
	await writeFile(join(root, "other.txt"), "x\n");
	await writeFile(join(root, ".mfw/triggers/deploy.md"), DEF);
	await gitOk(["add", "-A"], root);
	await gitOk(["add", "-f", ".mfw/triggers/deploy.md"], root);
	await gitOk(["commit", "-q", "-m", "init"], root);
	handle = await openProjectDb(join(root, ".mfw"));
	bus = new EventBus();
	const real = createScriptAction({
		log: silentLogger(),
		secrets: { getSecret: async () => undefined },
		semaphore: new Semaphore(2),
	});
	const wrapped: TriggerActionHandler = async (d) => {
		await beforeAction?.();
		return real(d);
	};
	svc = new TriggerService({
		handle,
		bus,
		log: silentLogger(),
		projectRoot: root,
		projectName: "demo",
		mfwHome: home,
		actions: new TriggerActionRegistry().register("script", wrapped),
	});
	arming = ArmingStore.at(home, "demo");
});

afterEach(async () => {
	handle.close();
	await rm(base, { recursive: true, force: true });
});

describe("arming and executing", () => {
	test("an armed script runs", async () => {
		await svc.arm("deploy");
		await fire();
		expect(existsSync(ran)).toBe(true);
	});

	test("arming records what the trigger executes", async () => {
		await svc.arm("deploy");
		const pin = (await arming.load()).deploy?.execPin;
		expect(pin?.files.map((f) => f.path)).toEqual(["deploy.sh"]);
		expect(pin?.commit).toBe(await gitOk(["rev-parse", "HEAD"], root));
	});

	test("arming an untracked script is refused with a fix", async () => {
		await writeFile(
			join(root, ".mfw/triggers/deploy.md"),
			DEF.replace("./deploy.sh", "./new.sh"),
		);
		await writeFile(join(root, "new.sh"), script(ran), { mode: 0o755 });
		await expect(svc.arm("deploy")).rejects.toMatchObject({
			name: "TriggerPinRefusedError",
			fix: expect.stringContaining("Commit"),
		});
		expect((await arming.load()).deploy).toBeUndefined();
	});

	test("a record from before exec pins does not run", async () => {
		const hash = (await stateOf())?.hash ?? "";
		await arming.arm("deploy", hash);
		await fire();
		expect(existsSync(ran)).toBe(false);
		expect((await stateOf())?.state).toBe("drifted");
		expect((await arming.load()).deploy?.disarmed?.reason).toBe(
			"re-arm-needed",
		);
	});
});

describe("tampering", () => {
	const inbox = async () => {
		const tasks = await makeTasks(handle, bus, join(root, ".mfw"));
		return new InboxService({ handle, project: "demo", tasks, triggers: svc });
	};

	test("a content change does not run and raises an inbox card", async () => {
		await svc.arm("deploy");
		await writeFile(join(root, "deploy.sh"), script(evil));
		await fire();
		expect(existsSync(evil)).toBe(false);
		expect((await stateOf())?.state).toBe("drifted");
		const card = (await (await inbox()).list()).find(
			(i) => i.kind === "trigger_disarmed",
		);
		expect(card?.detail).toContain("content_changed:deploy.sh");
		expect(card?.detail).toContain("arm it again");
	});

	test("a symlink swap does not run", async () => {
		await svc.arm("deploy");
		await writeFile(join(base, "other.sh"), script(evil), { mode: 0o755 });
		await rm(join(root, "deploy.sh"));
		await symlink(join(base, "other.sh"), join(root, "deploy.sh"));
		await fire();
		expect(existsSync(evil)).toBe(false);
		expect((await arming.load()).deploy?.disarmed?.foundHash).toStartWith(
			"symlink:",
		);
	});

	test("a permission change does not run", async () => {
		await svc.arm("deploy");
		await chmod(join(root, "deploy.sh"), 0o775);
		await fire();
		expect(existsSync(ran)).toBe(false);
		expect((await arming.load()).deploy?.disarmed?.foundHash).toStartWith(
			"mode_changed:",
		);
	});

	test("a change after the pass began never runs: the sealed armed bytes do", async () => {
		await svc.arm("deploy");
		beforeAction = async () => {
			await writeFile(join(root, "deploy.sh"), script(evil));
		};
		await fire();
		expect(existsSync(evil)).toBe(false);
		expect(existsSync(ran)).toBe(true);
		// The next reconcile sees the edit and disarms.
		await svc.list();
		expect((await arming.load()).deploy?.disarmed?.reason).toBe(
			"exec-pin-drift",
		);
	});

	test("a commit after arming refuses at execution", async () => {
		await svc.arm("deploy");
		const sha = await gitOk(["rev-parse", "HEAD"], root);
		await writeFile(join(root, "planted.ts"), "evil\n");
		await commit("agent commit");
		const moved = await gitOk(["rev-parse", "HEAD"], root);
		expect(moved).not.toBe(sha);
		await fire();
		expect(existsSync(ran)).toBe(false);
		expect((await arming.load()).deploy?.disarmed).toBeDefined();
	});

	test("an operator retry of a disarmed trigger does not run", async () => {
		await svc.arm("deploy");
		await fire();
		const [delivery] = await svc.deliveries("deploy");
		await rm(ran);
		await writeFile(join(root, "deploy.sh"), script(evil));
		await svc.list();
		await svc.retry(delivery?.id ?? "");
		expect(existsSync(evil)).toBe(false);
		expect(existsSync(ran)).toBe(false);
	});

	test("re-arming after review runs the new version", async () => {
		await svc.arm("deploy");
		await writeFile(join(root, "deploy.sh"), script(evil));
		await commit("reviewed change");
		await svc.list();
		await svc.arm("deploy");
		expect((await stateOf())?.state).toBe("armed");
		await fire();
		expect(existsSync(evil)).toBe(true);
	});
});

describe("merges", () => {
	function queue(push?: PushSettings): MergeQueue {
		return new MergeQueue({
			handle,
			bus,
			projectRoot: root,
			log: silentLogger(),
			reverify: async () => ({ passed: true }),
			onMerged: async () => {},
			onParked: async () => {},
			onLandedPaths: (paths) => svc.disarmForMergedPaths(paths),
			landingRoot: join(base, "landing"),
			...(push ? { push } : {}),
		});
	}

	async function landBranch(
		q: MergeQueue,
		name: string,
		file: string,
		content: string,
	): Promise<void> {
		const wt = join(root, "workspaces", name);
		await gitOk(["worktree", "add", "-q", "-b", name, wt, "main"], root);
		await mkdir(join(wt, file, ".."), { recursive: true });
		await writeFile(join(wt, file), content);
		await gitOk(["add", "-f", "--", file], wt);
		await gitOk(["commit", "-q", "-m", `work on ${name}`], wt);
		const runId = ulid();
		await handle.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: name,
			model: "sonnet",
			cwd: wt,
			workspacePath: wt,
			branch: name,
			integrationBranch: "main",
			startedAt: new Date(),
		});
		await q.enqueue({
			runId,
			taskId: null,
			branch: name,
			targetBranch: "main",
		});
		expect(await q.tick()).toBe("merged");
	}

	test("a merge touching an armed file disarms, even with old bytes on disk", async () => {
		await svc.arm("deploy");
		// The primary sits on another branch, so the merge does not change its files.
		await gitOk(["checkout", "-q", "-b", "elsewhere"], root);
		await landBranch(queue(), "mfw/evil", "deploy.sh", script(evil));
		expect(await Bun.file(join(root, "deploy.sh")).text()).toBe(script(ran));
		const record = (await arming.load()).deploy;
		expect(record?.disarmed?.reason).toBe("re-arm-needed");
		expect(record?.disarmed?.foundHash).toBe("merged:deploy.sh");
		await fire();
		expect(existsSync(ran)).toBe(false);
		expect(existsSync(evil)).toBe(false);
	});

	test("a merge changing the trigger definition disarms", async () => {
		await svc.arm("deploy");
		await gitOk(["checkout", "-q", "-b", "elsewhere"], root);
		await landBranch(
			queue(),
			"mfw/def",
			".mfw/triggers/deploy.md",
			DEF.replace("./deploy.sh", "./other.sh"),
		);
		expect((await arming.load()).deploy?.disarmed?.foundHash).toBe(
			"merged:.mfw/triggers/deploy.md",
		);
	});

	test("a merge touching any other file disarms, new files included", async () => {
		await svc.arm("deploy");
		await landBranch(queue(), "mfw/new", "brand-new.ts", "evil\n");
		expect((await arming.load()).deploy?.disarmed?.foundHash).toBe(
			"merged:brand-new.ts",
		);
		await fire();
		expect(existsSync(ran)).toBe(false);
	});

	test("a merge inside the owner's may-change list leaves the trigger armed", async () => {
		await svc.arm("deploy", { mayChange: ["other.txt"] });
		await landBranch(queue(), "mfw/ok", "other.txt", "changed\n");
		expect((await arming.load()).deploy?.disarmed).toBeUndefined();
		expect((await stateOf())?.state).toBe("armed");
		await fire();
		expect(existsSync(ran)).toBe(true);
	});

	test("unknown changed paths disarm every script trigger", async () => {
		await svc.arm("deploy");
		expect(await svc.disarmForMergedPaths(null)).toEqual(["deploy"]);
	});

	test("a refused push raises an inbox card that clears on the next push", async () => {
		const remote = join(base, "remote.git");
		await gitOk(["init", "-q", "--bare", "-b", "main", remote], base);
		await gitOk(["remote", "add", "origin", remote], root);
		const q = queue({
			enabled: false,
			remote: "origin",
			url: remote,
			allowLocalUrl: true,
		});
		const tasks = await makeTasks(handle, bus, join(root, ".mfw"));
		const box = new InboxService({ handle, project: "demo", tasks });

		await landBranch(q, "mfw/one", "one.txt", "1\n");
		q.setPushOnMerge(true);
		await gitOk(["config", "core.sshCommand", join(base, "evil-ssh")], root);
		await q.publishBranch("main");
		const card = (await box.list()).find((i) => i.kind === "push_refused");
		expect(card?.detail).toContain("core.sshcommand");
		expect(card?.detail).toContain("Fix:");
		expect(
			(await git(["rev-parse", "--verify", "-q", "main"], remote)).exitCode,
		).not.toBe(0);

		await gitOk(["config", "--unset", "core.sshCommand"], root);
		await landBranch(q, "mfw/two", "two.txt", "2\n");
		expect((await box.list()).map((i) => i.kind)).not.toContain("push_refused");
		expect(
			(await git(["rev-parse", "--verify", "-q", "main"], remote)).exitCode,
		).toBe(0);
	});
});

describe("the owner approves the pin digest", () => {
	test("the preview names the files and the digest arming will record", async () => {
		const preview = await svc.previewPin("deploy");
		expect(preview?.ok).toBe(true);
		if (!preview?.ok) throw new Error("no preview");
		expect(preview.files.map((f) => f.path)).toEqual(["deploy.sh"]);
		await svc.arm("deploy", {
			expectedPinDigest: preview.digest,
			requirePinDigest: true,
		});
		expect((await stateOf())?.state).toBe("armed");
	});

	test("a script changed after the review is not approved silently", async () => {
		const preview = await svc.previewPin("deploy");
		if (!preview?.ok) throw new Error("no preview");
		await writeFile(join(root, "deploy.sh"), script(evil));
		await commit("changed after review");
		await expect(
			svc.arm("deploy", {
				expectedPinDigest: preview.digest,
				requirePinDigest: true,
			}),
		).rejects.toThrow("reopen the review");
		expect((await arming.load()).deploy).toBeUndefined();
	});

	test("an operator path cannot arm a script without a digest", async () => {
		await expect(svc.arm("deploy", { requirePinDigest: true })).rejects.toThrow(
			"approved pin digest",
		);
	});
});
