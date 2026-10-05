import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dir, "RunPodGlobalPage.tsx"),
	"utf8",
);
const route = readFileSync(
	join(import.meta.dir, "..", "..", "routes", "runpod.tsx"),
	"utf8",
);
const projectSettings = readFileSync(
	join(import.meta.dir, "..", "settings", "ProjectConfig.tsx"),
	"utf8",
);
const runPage = readFileSync(
	join(import.meta.dir, "..", "transcript", "RunPage.tsx"),
	"utf8",
);
const taskPage = readFileSync(
	join(import.meta.dir, "..", "tasks", "TaskPage.tsx"),
	"utf8",
);

describe("the process-global RunPod operations route", () => {
	test("charts live provider balance, burn, spend, and Pod count", () => {
		expect(source).toContain("Live account telemetry");
		expect(source).toContain("RunPod remaining credits");
		expect(source).toContain("RunPod hourly safety burn");
		expect(source).toContain("Estimated RunPod infrastructure spend");
		expect(source).toContain("Live RunPod Pod count");
		expect(source).toContain("this page is open");
	});

	test("is global, live, and defines its account model", () => {
		expect(route).toContain('createFileRoute("/runpod")');
		expect(route).toContain("component: RunPodGlobalPage");
		expect(source).toContain("trpc.runpod.get.queryOptions()");
		expect(source).toContain("refetchInterval: 15_000");
		expect(source).toContain("const model = account.data");
		expect(source).not.toContain("project:");
	});

	test("is operations-only: inventory, spend, reconciliation, pause, and cleanup", () => {
		for (const evidence of [
			"model.inventory.fresh",
			"pod.ownership",
			"pod.actualShape",
			"pod.hourlyBurn",
			"model.costs.providerInfrastructure.label",
			"trpc.runpod.refresh.mutationOptions",
			"trpc.runpod.setPaused.mutationOptions",
			"trpc.runpod.cleanup.mutationOptions",
		])
			expect(source).toContain(evidence);
		expect(source).not.toContain("trpc.runpod.updatePolicy");
		expect(source).not.toContain("RunPod API key");
		expect(source).not.toContain("Machine safety policy");
		expect(source).not.toContain("Last change reason");
		expect(source).not.toContain('<Field label="Version">');
		expect(source).toContain("Open RunPod settings");
		expect(source).toContain("href.settings()}?tab=runpod");
	});

	test("shows live provider credit and an honest human-readable unavailable state", () => {
		expect(source).toContain("balance.remainingCredits");
		expect(source).toContain("balance.remainingCredits.toFixed(2)");
		expect(source).toContain('<Field label="Last confirmed balance">');
		expect(source).toContain('<Field label="Confirmed at">');
		expect(source).toContain('<Field label="Latest balance check">');
		expect(source).toContain("RunPod account API, not estimated from spend");
		expect(source).toContain("runPodErrorText(model.balance.error)");
		expect(source).toContain("No confirmed balance yet");
		expect(source).not.toContain("estimatedCost -");
	});

	test("uses plain ownership and cleanup language", () => {
		expect(source).toContain("MFW created this Pod");
		expect(source).toContain("terminate it and verify it is gone");
		expect(source).toContain("Terminate and verify");
		expect(source).not.toContain("cryptographically attributable");
		expect(source).not.toContain("prove absent");
		expect(source).not.toContain("proof of absence");
		expect(source).toContain("runPodPhaseText(pod.phase)");
		expect(source).toContain("Provider details");
		expect(source).toContain("disabledReason");
		expect(source).toContain("Latest lifecycle issue:");
		expect(source).toContain("runPodErrorText(pod.cleanup.lastError)");
		expect(source).toContain("runPodComputeText(pod.actualShape)");
	});

	test("uses the effective gate and explains unavailable resume prerequisites", () => {
		expect(source).toContain("runPodDispatchStatus({");
		expect(source).toContain("gateOpen: model.gate.open");
		expect(source).toContain("runPodResumeDisabledReason({");
		expect(source).toContain("Boolean(resumeDisabledReason)");
	});

	test("keeps destructive termination fenced and exceptionally confirmed", () => {
		expect(source).toContain("runPodTerminationDisabledReason({");
		expect(source).toContain("inventoryFresh: model.inventory.fresh");
		expect(source).toContain('pod.ownership.startsWith("owned_")');
		expect(source).toContain("confirmText={cleanupPod?.podId}");
		expect(source).not.toContain('aria-label="Termination reason"');
		expect(source).toContain(
			"Operator terminated owned Pod from live inventory",
		);
		expect(source).not.toContain("cleanupReason");
		expect(source).toContain("confirmed: true");
		expect(source).toContain("expectedObservedAt: model.inventory.observedAt");
		expect(source).toContain("expectedOwnershipFingerprint");
	});

	test("keeps project opt-in and links runs back to operations", () => {
		expect(projectSettings).toContain("Allow RunPod tasks in this project");
		expect(projectSettings).toContain("Project cost guardrails");
		expect(projectSettings).toContain("RunPod is ready for this project");
		expect(projectSettings).toContain("Open global RunPod setup");
		expect(projectSettings).not.toContain("RunPod project policy JSON");
		expect(projectSettings).not.toContain("RunPod placement JSON");
		expect(projectSettings).not.toContain("trpc.runpod.cleanup");
		expect(source).toContain("href.run(pod.projectName, pod.runId)");
		expect(runPage).toContain('run.executionTarget === "runpod"');
		expect(taskPage).toContain('task.executionTarget === "runpod"');
	});

	test("keeps provider activity collapsed and avoids raw JSON", () => {
		expect(source).toContain(
			"const [auditOpen, setAuditOpen] = useState(false)",
		);
		expect(source).toContain('title="RunPod activity"');
		expect(source).toContain(
			"Open this only when investigating account behavior",
		);
		expect(source).not.toContain("JSON.stringify(entry.detail");
	});
});
