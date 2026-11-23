import { describe, expect, test } from "bun:test";
import { HarnessManifestSchema } from "@mfw/plugin-api/harness";
import { BUILTIN_HARNESS_MANIFESTS } from "@mfw/plugin-api/harness-builtins";
import {
	builtinHarnessRegistry,
	harnessCeilingViolations,
} from "@mfw/plugin-api/harness-registry";
import { fleetCliOf } from "../src/agent-host.ts";
import { profileFor } from "../src/agents/acp-translate.ts";
import { adapterFor } from "../src/agents/adapter.ts";
import { harnessBinaryIdentity } from "../src/agents/agent-identity.ts";
import { findProvider } from "../src/agents/catalogue.ts";
import { HARNESS_CONFIG_PATHS } from "../src/brain-runtime/decision-rights.ts";
import { REMOTE_HARNESSES } from "../src/host-registry.ts";

/** Security review m4: an id is data and must not resolve on Object.prototype. */
const HOSTILE_IDS = [
	"constructor",
	"__proto__",
	"prototype",
	"toString",
	"valueOf",
	"hasOwnProperty",
];

describe.each(HOSTILE_IDS)("the id %s resolves to nothing", (id) => {
	test("the ACP profile is the generic, ineligible one", () => {
		expect(profileFor(id)).toEqual({
			id: "acp",
			label: "ACP agent",
			brainEligible: false,
		});
	});

	test("it has no fleet dir", () => {
		expect(fleetCliOf(id)).toBeUndefined();
	});

	test("the exported id maps have no such entry", () => {
		const remote: Readonly<Record<string, unknown>> = REMOTE_HARNESSES;
		expect(remote[id]).toBeUndefined();
		expect(HARNESS_CONFIG_PATHS[id]).toBeUndefined();
	});

	test("the registry, catalogue, adapters and identities miss", () => {
		expect(builtinHarnessRegistry().get(id)).toBeUndefined();
		expect(findProvider(id)).toBeUndefined();
		expect(adapterFor(id)).toBeUndefined();
		expect(harnessBinaryIdentity(id)).toBeUndefined();
	});

	test("it cannot name a fleet dir in a manifest", () => {
		const claude = BUILTIN_HARNESS_MANIFESTS[0];
		const m = HarnessManifestSchema.safeParse({
			...claude,
			fleet: { cli: id, env: "CLAUDE_CONFIG_DIR", writable: ["sessions"] },
		});
		// The fleet name's grammar may refuse it first; either way it never loads.
		if (m.success)
			expect(harnessCeilingViolations(m.data, "builtin").join()).toContain(
				"no such fleet dir",
			);
	});
});

test("real ids still resolve", () => {
	expect(profileFor("pi").id).toBe("pi");
	expect(fleetCliOf("claude-cli")).toBe("claude");
	expect(fleetCliOf("codex-cli")).toBe("codex");
	expect(fleetCliOf("gemini-cli")).toBeUndefined();
	expect(REMOTE_HARNESSES["claude-cli"].binary).toBe("claude");
	expect(HARNESS_CONFIG_PATHS["codex-cli"]).toContain("AGENTS.md");
});
