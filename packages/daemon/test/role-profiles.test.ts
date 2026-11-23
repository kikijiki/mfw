import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ProfileRejectedError,
	parseSandboxProfile,
	READ_ONLY_ROLES,
	VERIFY_ROLES,
} from "../src/containment/profile.ts";
import {
	buildReadOnlyAgentProfile,
	buildVerifierProfile,
	type ReadOnlyAgentRole,
} from "../src/containment/role-profiles.ts";

let root: string;
let tree: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-roles-")));
	tree = join(root, "clone/tree");
	mkdirSync(tree, { recursive: true });
	mkdirSync(join(root, "clone/git"));
	writeFileSync(join(root, "clone/mfw-workspace.json"), "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const AGENT_ROLES: ReadOnlyAgentRole[] = [
	"reviewer",
	"plan",
	"import",
	"brain",
	"trigger",
];

const agent = (role: ReadOnlyAgentRole) =>
	buildReadOnlyAgentProfile({
		role,
		tree,
		runDir: join(root, "run"),
		cli: "claude",
		fleetDir: join(root, "fleet"),
		binaries: ["claude"],
		env: {},
		egressSocketDir: join(root, "egress"),
	});

describe("the builders stay within their role's ceiling", () => {
	test.each(["verifier", "merge-verify"] as const)("%s", (role) => {
		const p = buildVerifierProfile({ role, tree, binaries: ["sh"] });
		expect(VERIFY_ROLES.has(p.role)).toBe(true);
		expect(p.network).toEqual({ mode: "none" });
		expect(p.filesystem?.workspace?.access).toBe("rw");
		expect(p.filesystem?.workspace?.gitAccess).toBe("ro");
		expect(p.filesystem?.fleetConfig).toBeUndefined();
		expect(p.filesystem?.runDir).toBeUndefined();
	});

	test.each(AGENT_ROLES)("%s", (role) => {
		const p = agent(role);
		expect(READ_ONLY_ROLES.has(p.role)).toBe(true);
		expect(p.filesystem?.workspace?.access).toBe("ro");
		expect(p.filesystem?.runDir?.outbox).toBe("rw");
		expect(p.filesystem?.fleetConfig?.privateState).toBeDefined();
	});
});

describe("the ceilings refuse", () => {
	const verifier = () =>
		structuredClone(
			buildVerifierProfile({ role: "verifier", tree, binaries: [] }),
		);
	const rejects = (input: unknown) =>
		expect(() => parseSandboxProfile(input)).toThrow(ProfileRejectedError);

	test("a verifier with a network", () => {
		rejects({ ...verifier(), network: { mode: "proxy", socketDir: "/r/e" } });
	});

	test("a verifier with a writable gitdir", () => {
		const p = verifier();
		delete p.filesystem?.workspace?.gitAccess;
		rejects(p);
	});

	test("a verifier with a credential", () => {
		const p = verifier();
		(p.process as { env: Record<string, string> }).env = {
			ANTHROPIC_API_KEY: "x",
		};
		rejects(p);
	});

	test("a verifier with a run directory", () => {
		const p = verifier();
		(p.filesystem as Record<string, unknown>).runDir = {
			source: "/r/run",
			outbox: "rw",
		};
		rejects(p);
	});

	test("a verifier with agent config", () => {
		const p = verifier();
		(p.filesystem as Record<string, unknown>).fleetConfig = {
			cli: "claude",
			source: "/r/fleet",
			writable: [],
		};
		rejects(p);
	});

	test.each(AGENT_ROLES)("%s with a writable workspace", (role) => {
		const p = structuredClone(agent(role));
		(p.filesystem?.workspace as { access: string }).access = "rw";
		rejects(p);
	});

	test.each(AGENT_ROLES)("%s writing the shared fleet config", (role) => {
		const p = structuredClone(agent(role));
		delete p.filesystem?.fleetConfig?.privateState;
		rejects(p);
	});

	test.each([
		"task",
		"repair",
		"verifier",
		"reviewer",
		"plan",
		"import",
		"trigger",
	])("%s with the brain socket", (role) => {
		rejects({
			version: 1,
			role,
			filesystem: { brainSocket: { source: "/r/brain" } },
		});
	});

	test("the brain may hold its socket", () => {
		expect(
			parseSandboxProfile({
				version: 1,
				role: "brain",
				filesystem: { brainSocket: { source: "/r/brain" } },
			}).filesystem?.brainSocket,
		).toEqual({ source: "/r/brain" });
	});
});
