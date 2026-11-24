import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { brainActions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	applyEnvCard,
	describeEnvCard,
	ENV_ALLOW_TOOL,
	envCardArgs,
	raiseEnvCard,
} from "../src/containment/dev-env-card.ts";
import { resolveDevEnv } from "../src/containment/dev-env-resolve.ts";
import { EnvTrustStore } from "../src/containment/dev-env-trust.ts";
import { git } from "../src/git.ts";
import { describeHeld } from "../src/inbox.ts";
import { brainUnit } from "./support/brain-unit.ts";

let base: string;
let root: string;
let mfwHome: string;
let handle: ProjectDbHandle;
const config = { setup: ["bun install"] };

const resolve = () =>
	resolveDevEnv({
		mfwHome,
		project: "p",
		root,
		config,
		rev: "main",
		build: false,
	});

beforeAll(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "dev-env-card-")));
	root = join(base, "p");
	mfwHome = join(base, "mfw");
	mkdirSync(join(root, ".mfw"), { recursive: true });
	mkdirSync(mfwHome);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	writeFileSync(join(root, ".envrc"), "use flake\n");
	writeFileSync(join(root, "package.json"), "{}\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "one"], root);
	handle = await openProjectDb(join(root, ".mfw"));
});
afterAll(() => {
	handle.close();
	rmSync(base, { recursive: true, force: true });
});

describe("the dev environment card", () => {
	test("raised once per commit and content, showing every file and hash", async () => {
		const r = await resolve();
		const args = envCardArgs("p", config, r);
		expect(args?.files.map((f) => f.path)).toEqual([".envrc", "package.json"]);
		if (!args) throw new Error("no card");
		const bus = new EventBus();
		expect(await raiseEnvCard(handle, bus, args)).toBe(true);
		expect(await raiseEnvCard(handle, bus, args)).toBe(false);
		const rows = await handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.tool, ENV_ALLOW_TOOL));
		expect(rows.length).toBe(1);
		expect(rows[0]?.status).toBe("held");
		const text = describeHeld(rows[0] as never);
		expect(text.title).toContain("dev environment of p");
		expect(text.detail).toContain(".envrc (sha256 ");
		expect(text.detail).toContain('"bun install"');
		expect(text.detail).toContain(args.commit);
		expect(describeEnvCard(args as never).detail).toContain(
			"env-build sandbox",
		);
	});

	test("only an answerable refusal makes a card", async () => {
		expect(envCardArgs("p", config, { kind: "none" })).toBeNull();
		expect(
			envCardArgs("p", config, {
				kind: "refused",
				code: "env_build_failed",
				reason: "x",
				fix: "y",
				commit: "c",
			}),
		).toBeNull();
	});

	test("approving records the approval via the card, for that exact content", async () => {
		const args = envCardArgs("p", config, await resolve());
		if (!args) throw new Error("no card");
		const stale = await applyEnvCard(
			{ mfwHome, root, config: { setup: ["npm ci"] } },
			args as never,
			true,
		);
		expect(stale.ok).toBe(false);
		expect(new EnvTrustStore(mfwHome).read(root)).toBeNull();
		expect(
			await applyEnvCard({ mfwHome, root, config }, args as never, true),
		).toEqual({
			ok: true,
		});
		const rec = new EnvTrustStore(mfwHome).read(root);
		expect([rec?.state, rec?.via, rec?.commit]).toEqual([
			"allowed",
			"card",
			args.commit,
		]);
		const after = await resolve();
		expect(after.kind === "refused" && after.code).toBe("env_not_built");
	});

	test("declining denies", async () => {
		const args = envCardArgs("p", config, {
			kind: "refused",
			code: "env_not_approved",
			reason: "",
			fix: "",
			commit: (await git(["rev-parse", "HEAD"], root)).stdout,
			status: {
				state: "not_approved",
				detection: { kind: "direnv", files: [], ignored: [] },
			},
		});
		if (!args) throw new Error("no card");
		await applyEnvCard({ mfwHome, root, config }, args as never, false);
		expect(new EnvTrustStore(mfwHome).read(root)?.state).toBe("denied");
	});
});

describe("deciding the card through the brain's held actions", () => {
	test("approve applies it; a stale answer fails it; it never counts against the breaker", async () => {
		const seen: boolean[] = [];
		let answer: { ok: true } | { ok: false; message: string } = { ok: true };
		const u = await brainUnit({
			envDecision: async (_args, approved) => {
				seen.push(approved);
				return answer;
			},
		});
		const insert = (id: string) =>
			u.handle.db.insert(brainActions).values({
				id,
				idemKey: `env_allow:${id}`,
				sessionId: "dev-env",
				turnRunId: "env-x",
				tool: ENV_ALLOW_TOOL,
				args: {
					project: "unit",
					commit: "c",
					source: "direnv",
					files: [],
					configHash: "h",
				},
				status: "held",
				effects: {
					rights: { actionClass: "host_executed_merge", cause: "default" },
				},
				createdAt: new Date(),
			});
		await insert("env-1");
		expect(
			(
				await u.runtime.actions.resolveHeld({
					actionId: "env-1",
					approve: true,
				})
			).status,
		).toBe("applied");
		answer = { ok: false, message: "the files changed" };
		await insert("env-2");
		const stale = await u.runtime.actions.resolveHeld({
			actionId: "env-2",
			approve: true,
		});
		expect(stale.status).toBe("failed");
		expect(stale.rejection?.message).toContain("the files changed");
		await insert("env-3");
		expect(
			(
				await u.runtime.actions.resolveHeld({
					actionId: "env-3",
					approve: false,
				})
			).status,
		).toBe("rejected");
		expect(seen).toEqual([true, true, false]);
	});
});
