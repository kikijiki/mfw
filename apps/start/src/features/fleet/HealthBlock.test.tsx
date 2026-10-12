import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	HealthBlock,
	type HealthItemView,
	type HealthView,
	healthHeadline,
} from "./HealthBlock";

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);

function item(over: Partial<HealthItemView>): HealthItemView {
	return {
		kind: "linux-cpu",
		label: "CPU probe",
		status: "ok",
		code: null,
		summary: "CPU probe: ok",
		message: null,
		since: null,
		lastOkAt: NOW,
		checkedAt: NOW,
		consecutiveFailures: 0,
		affects: null,
		hint: null,
		transient: false,
		...over,
	};
}

const gpu = item({
	kind: "amd-gpu",
	label: "AMD GPU probe",
	status: "degraded",
	code: "tool-missing",
	summary: "AMD GPU probe: tool not installed",
	message: "amd-smi is not installed; mfw is reading the kernel KFD interface",
	since: NOW - 3 * 3_600_000,
	lastOkAt: null,
	consecutiveFailures: 700,
	affects: "GPU slots are held while the device cannot be proven idle.",
	hint: "Install amd-smi (ROCm).",
});

const degraded: HealthView = {
	state: "degraded",
	detail: "AMD GPU probe: tool not installed",
	checkedAt: NOW,
	items: [gpu, item({})],
};

describe("HealthBlock", () => {
	test("a degraded node says why in words, not 'degraded: amd-gpu: degraded'", () => {
		const html = renderToStaticMarkup(
			<HealthBlock health={degraded} now={NOW} />,
		);
		expect(html).toContain("AMD GPU probe: tool not installed");
		expect(html).not.toContain("amd-gpu: degraded");
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("data-health-detail");
	});

	test("expanded, it shows the message, since, what it affects, what to do and Re-check", () => {
		const html = renderToStaticMarkup(
			<HealthBlock
				health={degraded}
				now={NOW}
				defaultOpen
				onRecheck={() => {}}
			/>,
		);
		expect(html).toContain("data-health-detail");
		expect(html).toContain("amd-smi is not installed");
		expect(html).toContain("3h ago");
		expect(html).toContain("not seen ok since mfw started");
		expect(html).toContain("700 checks in a row");
		expect(html).toContain("GPU slots are held");
		expect(html).toContain("Install amd-smi (ROCm).");
		expect(html).toContain("Re-check now");
		// Healthy checks are listed but carry no detail grid.
		expect(html).toContain('data-health-item="linux-cpu"');
	});

	test("healthy says 'All checks ok'; no Re-check without a handler", () => {
		const ok: HealthView = {
			state: "ok",
			detail: null,
			checkedAt: NOW,
			items: [
				item({}),
				item({ kind: "linux-memory", summary: "Memory probe: ok" }),
			],
		};
		expect(healthHeadline(ok)).toBe("All checks ok");
		const html = renderToStaticMarkup(
			<HealthBlock health={ok} now={NOW} defaultOpen />,
		);
		expect(html).toContain("All checks ok");
		expect(html).not.toContain("Re-check now");
	});

	test("a retrying probe is labelled and does not read as an alarm", () => {
		const html = renderToStaticMarkup(
			<HealthBlock
				health={{
					state: "ok",
					detail: null,
					checkedAt: NOW,
					items: [
						item({
							status: "degraded",
							transient: true,
							summary: "CPU probe: partial observation",
							message: "needs a prior sample",
						}),
					],
				}}
				now={NOW}
				defaultOpen
			/>,
		);
		expect(html).toContain("(retrying)");
		expect(html).toContain("ok");
	});
});
