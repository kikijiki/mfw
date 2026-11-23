import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentPreflightDeps,
	agentSandboxRefusal,
	resetAgentPreflightCache,
} from "../src/containment/agent-preflight.ts";
import type { SandboxProfile } from "../src/containment/profile.ts";

let base: string;
const isolation = { mode: "bwrap" as const, hidePaths: [] };

beforeEach(() => {
	resetAgentPreflightCache();
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-agent-preflight-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const input = (over = {}) => ({
	approvalMode: "autonomous" as const,
	isolation,
	runWorkspace: "clone" as const,
	projectRoot: base,
	mfwHome: join(base, "mfw"),
	...over,
});

function deps(outcome: "pass" | "fail" = "pass") {
	const seen: { profile?: SandboxProfile; calls: number } = { calls: 0 };
	const value: AgentPreflightDeps = {
		now: () => 1,
		compileHost: (async () => ({ home: join(base, "home") })) as never,
		attest: (async (req: { profile: SandboxProfile }) => {
			seen.calls++;
			seen.profile = req.profile;
			return {
				ok: true,
				attestationId: "a",
				outcome,
				items: [{ id: "home_absent", status: outcome, detail: "" }],
				fingerprint: { profileHash: "", optionsHash: "", seccompHash: "" },
			};
		}) as never,
	};
	return { value, seen };
}

describe("agentSandboxRefusal", () => {
	test("an unsandboxed interactive run needs no probe", async () => {
		const d = deps();
		expect(
			await agentSandboxRefusal(
				input({ approvalMode: "interactive", isolation: undefined }),
				d.value,
			),
		).toBeNull();
		expect(d.seen.calls).toBe(0);
	});

	test("autonomy without isolation is refused", async () => {
		const r = await agentSandboxRefusal(
			input({ isolation: undefined }),
			deps().value,
		);
		expect(r?.code).toBe("sandbox_unavailable");
	});

	test.each([
		"autonomous",
		"interactive",
	] as const)("a %s sandboxed run on a worktree is refused with the fix", async (approvalMode) => {
		const r = await agentSandboxRefusal(
			input({ approvalMode, runWorkspace: "worktree" }),
			deps().value,
		);
		expect(r?.code).toBe("sandbox_unavailable");
		expect(r?.detail).toContain('"runWorkspace": "clone"');
	});

	test("a project with an .envrc is refused and the file is not read", async () => {
		writeFileSync(join(base, ".envrc"), "not evaluated\n", { mode: 0o000 });
		const d = deps();
		const r = await agentSandboxRefusal(input(), d.value);
		expect(r?.detail).toContain(".envrc");
		expect(d.seen.calls).toBe(0);
	});

	test("m6: the .envrc refusal never steers the owner to an unsandboxed run", async () => {
		writeFileSync(join(base, ".envrc"), "use flake\n");
		const r = await agentSandboxRefusal(input(), deps().value);
		expect(r?.detail).toContain(".envrc");
		expect(r?.detail).not.toContain("P8");
		expect(r?.detail).toContain("dev shells");
		expect(r?.detail).not.toContain("agentIsolation");
		expect(r?.detail).not.toContain("none");
	});

	test("probes the split layout a real launch gets, then removes it", async () => {
		const d = deps();
		expect(await agentSandboxRefusal(input(), d.value)).toBeNull();
		const fs = d.seen.profile?.filesystem;
		expect(fs?.runDir?.outbox).toBe("rw");
		expect(fs?.workspace?.gitDir).toBeDefined();
		expect(fs?.fleetConfig?.writable.length).toBeGreaterThan(0);
		expect(d.seen.profile?.network).toEqual({ mode: "none" });
		expect(existsSync(join(base, "mfw"))).toBe(true);
		expect(readdirSync(join(base, "mfw"))).toEqual([]);
	});

	test("a failed probe is a refusal naming the item", async () => {
		const r = await agentSandboxRefusal(input(), deps("fail").value);
		expect(r?.code).toBe("sandbox_probe_failed");
		expect(r?.detail).toContain("home_absent");
	});

	test("a host fact that cannot be read is a refusal", async () => {
		const d = deps();
		d.value.compileHost = (async () => {
			throw new Error("bwrap is not on a trusted PATH");
		}) as never;
		const r = await agentSandboxRefusal(input(), d.value);
		expect(r?.code).toBe("sandbox_unavailable");
		expect(d.seen.calls).toBe(0);
	});
});
