import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "ResourcesPage.tsx"), "utf8");
const format = readFileSync(join(import.meta.dir, "resourceFormat.ts"), "utf8");
const route = readFileSync(
	join(import.meta.dir, "..", "..", "routes", "resources.tsx"),
	"utf8",
);
const projectSettings = readFileSync(
	join(import.meta.dir, "..", "settings", "ProjectSettingsPage.tsx"),
	"utf8",
);
const projectSemaphores = readFileSync(
	join(import.meta.dir, "..", "settings", "ResourcesPanel.tsx"),
	"utf8",
);

describe("the process-global Resources route", () => {
	test("is a top-level route backed only by hostResources procedures", () => {
		expect(route).toContain('createFileRoute("/resources")');
		expect(route).toContain("component: ResourcesPage");
		expect(source).toContain("trpc.hostResources.read.queryOptions()");
		expect(source).toContain("trpc.hostResources.audit.queryOptions");
		expect(source).not.toContain("trpc.resources.");
		expect(source).not.toContain("project:");
	});

	test("keeps configured, reserved, host-free and task-available capacity distinct", () => {
		for (const label of [
			"Configured",
			"Reserved",
			"Free on host",
			"Available to tasks",
		]) {
			expect(source).toContain(`"${label}"`);
		}
		expect(source).toContain("capacity.observedCapacity");
		expect(format).toContain('return "Not observed"');
		expect(source).toContain("MFW admission limits");
		expect(source).toContain("Whole-host values refresh every five seconds");
	});

	test("refreshes the global read model on a bounded cadence and shows its age", () => {
		expect(source).toContain("refetchInterval: HOST_RESOURCES_REFETCH_MS");
		expect(source).toContain("HOST_RESOURCES_REFETCH_MS = 5_000");
		expect(source).toContain("LiveMetricChart");
		expect(source).toContain("Charts are bounded to this page session");
		expect(source).toContain("observationFreshness(");
		expect(source).toContain("<RelativeTime");
		expect(source).toContain("Hardware check");
		expect(source).toContain("observed <RelativeTime");
	});

	test("covers loading, empty, disabled, stale, error, contention and uncertain recovery states", () => {
		expect(source).toContain("resources.isLoading");
		expect(source).toContain("Could not read host resources");
		expect(source).toContain("No host resources configured");
		expect(source).toContain("disabled");
		expect(source).toContain("observation is stale");
		expect(source).toContain("Probe health");
		expect(source).toContain("Ordered waiters");
		expect(source).toContain("Uncertain leases continue to hold capacity");
		expect(source).toContain("Check lease recovery");
		expect(source).toContain("crash cleanup, not hardware detection");
		expect(source).toContain(': "Enabled"');
		expect(source).not.toContain(': "Ready"');
	});

	test("shows external and unknown occupants without offering them a force action", () => {
		const occupants = source.slice(
			source.indexOf("function ObservationsPanel"),
			source.indexOf("function AuditPanel"),
		);
		expect(occupants).toContain("External and unknown GPU occupants");
		expect(occupants).toContain('item.attribution !== "managed"');
		expect(occupants).toMatch(
			/never\s+signals or force-releases this occupant/,
		);
		expect(occupants).not.toContain("onForce");
		expect(occupants).not.toContain("forceRelease.mutate");
	});

	test("requires typed confirmation, reason, and current fence for force", () => {
		expect(source).toContain("confirmText={force?.id}");
		expect(source).not.toContain('aria-label="Audit actor"');
		expect(source).toContain('const AUDIT_ACTOR = "local-operator"');
		expect(source).toContain('aria-label="Force release reason"');
		expect(source).toContain("confirmDisabled={!forceReason.trim()}");
		expect(source).toContain("expectedFence: force.fence");
		expect(source).toContain("confirmed: true");
		expect(source).toContain("The run is never signalled");
	});

	test("detects host resources for explicit human review before applying them", () => {
		expect(source).toContain("trpc.hostResources.detect.queryOptions()");
		expect(source).toContain(
			"trpc.hostResources.applyDetected.mutationOptions",
		);
		expect(source).toContain("Detection never changes capacity by itself");
		expect(source).toContain("Confirm resource setup");
		expect(source).toContain(
			"CPU, RAM, and each detected GPU will be configured together",
		);
		expect(source).toContain("expectedGeneration: detection.data.generation");
		expect(source).toContain("fingerprint: item.fingerprint");
		expect(source).toContain('recommendation.definitionState !== "conflict"');
		expect(source).toContain("Running a fresh hardware check");
		expect(source).toContain("Previous recommendations are hidden");
		expect(source).toContain("Fresh hardware check completed");
		expect(source).toContain("Detection fails closed");
		const applyCall = source.slice(
			source.indexOf("applyDetected.mutate({"),
			source.indexOf("applyDetected.mutate({") + 350,
		);
		expect(applyCall).not.toContain("actor:");
	});

	test("keeps storage identities and authoring machinery out of the human page", () => {
		expect(source).not.toContain("model.hostId");
		expect(source).not.toContain("model.coordinatorId");
		expect(source).not.toContain("model.generation");
		expect(source).not.toContain("DefinitionEditor");
		expect(source).not.toContain("BindingEditor");
		expect(source).not.toContain("DefinitionsPanel");
		expect(source).not.toContain("Stable device key");
		expect(source).not.toContain("Add binding");
		expect(source).not.toContain("definition.accounting");
		expect(source).not.toContain("device binding");
		expect(source).not.toContain("bindings manually");
	});

	test("keeps maintenance controls in collapsed advanced diagnostics", () => {
		const header = source.slice(
			source.indexOf("<PageHeader"),
			source.indexOf("<Scroller"),
		);
		expect(header).toContain("Detect resources");
		expect(header).not.toContain("Refresh hardware check");
		const cards = source.slice(
			source.indexOf("function ResourceCards"),
			source.indexOf("function ResourceControlsPanel"),
		);
		expect(cards).not.toContain("Finish current work");
		expect(cards).not.toContain("Make unavailable");
		expect(source).toContain('title="Advanced diagnostics and recovery"');
		expect(source).toContain("Refresh hardware check");
		expect(source).toContain("Finish current work");
	});

	test("renders version conflicts inline after reloading server truth", () => {
		expect(source).toContain('error.data?.code === "CONFLICT"');
		expect(source).toContain('role="alert"');
		expect(source).toContain("Host resource state changed before this action");
		expect(source).toContain("expectedVersion: definition.version");
	});

	test("keeps host activity collapsed and explains typed audit details without raw JSON", () => {
		expect(source).toContain("enabled: auditOpen");
		expect(source).toContain('title="Host activity"');
		expect(source).toContain("aria-expanded={open}");
		expect(source).toContain(
			"No configured resource bindings required a per-binding sample",
		);
		expect(source).toContain('"local-operator": "Local operator"');
		expect(source).not.toContain("JSON.stringify(entry.detail, null, 2)");
		expect(source).toContain("occupancy.memoryUsedBytes");
		expect(source).toContain("occupancy.state");
	});
});

describe("project resource scope", () => {
	test("labels the existing project panel Project Semaphores and keeps it on project settings", () => {
		expect(projectSettings).toContain("<ProjectSemaphoresPanel");
		expect(projectSemaphores).toContain('title="Project Semaphores"');
		expect(projectSemaphores).toContain("serialize work only inside");
		expect(projectSemaphores).toMatch(/cannot\s+change/);
		expect(projectSemaphores).toContain("href.resources()");
		expect(projectSettings).not.toContain("Host Resources");
		expect(projectSettings).not.toContain("hostResources");
	});
});
