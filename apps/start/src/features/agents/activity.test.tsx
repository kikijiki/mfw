import { describe, expect, test } from "bun:test";
import { RUN_ACTIVITIES } from "@mfw/core/activity";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityChip, ScopeMeter } from "./ActivityChip";
import {
	ACTIVITY_LABEL,
	ACTIVITY_TONE,
	activityExplanation,
	killReasonLabel,
	scopeCounts,
	shownActivity,
} from "./activity";

describe("activity presentation", () => {
	test("every vocabulary value has a label and a tone", () => {
		for (const a of RUN_ACTIVITIES) {
			expect(ACTIVITY_LABEL[a]).toBeTruthy();
			expect(ACTIVITY_TONE[a]).toBeTruthy();
			expect(activityExplanation(a, null)).toBeTruthy();
		}
	});

	test("only a live run shows its activity; unknown values show nothing", () => {
		expect(shownActivity({ state: "running", activity: "stalled" })).toBe(
			"stalled",
		);
		expect(
			shownActivity({ state: "completed", activity: "needs_answer" }),
		).toBeNull();
		expect(shownActivity({ state: "running", activity: "dancing" })).toBeNull();
		expect(shownActivity({ state: "running", activity: null })).toBeNull();
	});

	test("the explanation names the question, the approval or the background job", () => {
		expect(
			activityExplanation("needs_answer", {
				question: "Keep v1?",
				questionSource: "tool",
			}),
		).toBe("It asked: Keep v1?");
		expect(
			activityExplanation("awaiting_approval", {
				pendingApprovals: ["r1"],
				approvalSummary: "rm -rf dist",
			}),
		).toBe("Waiting for an approval: rm -rf dist");
		expect(
			activityExplanation("stalled", {
				stallCause: "background",
				background: [{ tool: "Bash", summary: "bun test" }],
			}),
		).toContain("(bun test)");
	});

	// Without `to`: AppLink needs Vite's import.meta.env, absent under bun test.
	test("the chip renders for a live run, with its explanation as the tooltip", () => {
		const html = renderToStaticMarkup(
			<ActivityChip
				run={{
					state: "running",
					activity: "awaiting_approval",
					activityDetail: { approvalSummary: "push" },
				}}
			/>,
		);
		expect(html).toContain("approval");
		// The explanation is the chip's tooltip (shared Tip, shown on hover).
		const chip = ActivityChip({
			run: {
				state: "running",
				activity: "awaiting_approval",
				activityDetail: { approvalSummary: "push" },
			},
		});
		expect((chip as { props: { title?: string } }).props.title).toBe(
			"Waiting for an approval: push",
		);
		expect(html).not.toContain("title=");
		expect(
			renderToStaticMarkup(
				<ActivityChip run={{ state: "completed", activity: "ended" }} />,
			),
		).toBe("");
	});
});

describe("scope meter (defensive until the scope watchdog writes samples)", () => {
	test("counts or path lists are read; anything else is no sample", () => {
		expect(scopeCounts({ files: 4, outside: 1, foreign: 0 })).toEqual({
			files: 4,
			outside: 1,
			foreign: 0,
			maxFiles: null,
			foreignFiles: [],
		});
		expect(
			scopeCounts({ files: ["a", "b"], outside: ["b"], foreign: [] }),
		).toMatchObject({ files: 2, outside: 1, foreign: 0 });
		expect(scopeCounts(null)).toBeNull();
		expect(scopeCounts({ outside: 2 })).toBeNull();
		expect(scopeCounts("12 files")).toBeNull();
		expect(scopeCounts({ files: -1 })).toBeNull();
	});

	test("renders nothing without a sample", () => {
		expect(renderToStaticMarkup(<ScopeMeter sample={null} />)).toBe("");
		expect(
			renderToStaticMarkup(
				<ScopeMeter sample={{ files: 3, outside: 1, foreign: 1 }} />,
			),
		).toContain("3 / 1 / 1");
	});

	test("the scope watchdog's sample names the other task's files and the limit", () => {
		const html = renderToStaticMarkup(
			<ScopeMeter
				sample={{
					files: 2,
					outside: 1,
					foreign: 1,
					level: "violation",
					maxFiles: 150,
					sampledAt: 1,
					outsideFiles: ["src/other/x.ts"],
					foreignFiles: [{ path: "src/other/x.ts", taskId: "T-2" }],
				}}
			/>,
		);
		const chip = ScopeMeter({
			sample: {
				files: 2,
				outside: 1,
				foreign: 1,
				level: "violation",
				maxFiles: 150,
				sampledAt: 1,
				outsideFiles: ["src/other/x.ts"],
				foreignFiles: [{ path: "src/other/x.ts", taskId: "T-2" }],
			},
		}) as { props: { title?: string } };
		expect(chip.props.title).toContain("limit 150");
		expect(chip.props.title).toContain("src/other/x.ts (T-2)");
		expect(html).not.toContain("title=");
	});

	test("every kill reason reads as words, an unknown one still says why", () => {
		expect(killReasonLabel("watchdog-scope")).toBe(
			"stopped: touched another task's files",
		);
		expect(killReasonLabel("watchdog-files")).toBe(
			"stopped: too many files changed",
		);
		expect(killReasonLabel("watchdog-new")).toBe("stopped: watchdog-new");
		expect(killReasonLabel(null)).toBeNull();
	});
});
