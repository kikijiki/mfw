import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(
	join(import.meta.dir, "RunPodSettingsPanel.tsx"),
	"utf8",
);
const settings = readFileSync(
	join(import.meta.dir, "SettingsPage.tsx"),
	"utf8",
);
const providers = readFileSync(
	join(import.meta.dir, "ProvidersPanel.tsx"),
	"utf8",
);
const controls = readFileSync(join(import.meta.dir, "controls.tsx"), "utf8");

describe("global RunPod settings", () => {
	test("lives in a dedicated global Settings tab", () => {
		expect(settings).toContain('"runpod"');
		expect(settings).toContain('active === "runpod"');
		expect(settings).toContain("<RunPodSettingsPanel />");
		expect(providers).toContain('row.id !== "runpod"');
		expect(controls).toContain('option === "runpod"');
		expect(controls).toContain('? "RunPod"');
	});

	test("offers a write-only API key set, replace, and remove flow", () => {
		expect(panel).toContain('type="password"');
		expect(panel).toContain('id: "runpod"');
		expect(panel).toContain("Replace key");
		expect(panel).toContain("Remove key");
		expect(panel).toContain("write-only");
		expect(panel).toContain('"Needs validation"');
		expect(panel).toContain("model.credential.validatedAt");
		expect(panel).not.toContain("credential.apiKey");
	});

	test("shows only simple spend safety in the ordinary workflow", () => {
		for (const label of [
			"Maximum per Pod ($/hr)",
			"Maximum total ($/hr)",
			"Maximum runtime (minutes)",
			"Maximum spend per run ($)",
		])
			expect(panel).toContain(label);
		for (const hidden of [
			"maxConcurrentPods",
			"maxGpuCount",
			"allowedGpuTypes",
			"allowedCpuFlavors",
			"allowedImages",
			"ownershipNamespace",
			"sshProxyAccountSuffix",
			"sshHostPublicKey",
			"Audit reason",
		])
			expect(panel).not.toContain(hidden);
		expect(panel).toContain("Provider choices are unrestricted globally");
		expect(panel).toContain("Changes to these machine-wide");
		expect(panel).not.toContain("can only be lowered");
		expect(panel).not.toContain("Save safer limits");
		expect(panel).toContain("Review limit changes");
		expect(panel).toContain("prepareSafetyReview");
		expect(panel).toContain("runPodSafetyReview");
		expect(panel).toContain("safetyReview?.description");
		expect(panel).toContain("Reload latest limits");
	});
});
