import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	canStartFleet,
	type DispatchStatusLike,
	dispatchAction,
	dispatchExplain,
	dispatchLabel,
	dispatchTone,
	type FleetLike,
	fleetFailures,
	fleetLabel,
	fleetTone,
	globalAction,
} from "./state";

const dispatchControlsSource = readFileSync(
	join(import.meta.dir, "DispatchControls.tsx"),
	"utf8",
);

/**
 * Pins the wording (a rate-limited project must not read "stopped", a stopped
 * one must not read "waiting"; every non-dispatching sentence says who stopped
 * it) and the placement: desktop has a control per sidebar project row plus a
 * global row above Settings; phones use the project-route header and a compact
 * global switch. No DOM here, so placement is asserted on source shape.
 */

const status = (over: Partial<DispatchStatusLike>): DispatchStatusLike => ({
	playing: false,
	globalPlaying: true,
	running: false,
	enabled: true,
	state: "stopped",
	reason: "the dispatch loop is not running",
	selfStopped: false,
	hold: null,
	...over,
	// Defaults to `playing`; without a master stop they are the same.
	projectPlaying: over.projectPlaying ?? over.playing ?? false,
});

describe("what the chip says", () => {
	test("the live daemon's state reads as stopped, not as enabled", () => {
		// Live case: `enabled: true` with `schedulerAutostart: false`.
		const s = status({ enabled: true, running: false, playing: false });
		expect(dispatchLabel(s)).toBe("Stopped");
		expect(dispatchTone(s)).toBe("neutral");
		expect(dispatchAction(s)).toBe("play");
		expect(dispatchExplain(s)).toContain("You stopped this project");
		expect(dispatchExplain(s)).toContain("until you press play");
	});

	test("dispatching says so and offers the stop", () => {
		const s = status({
			playing: true,
			running: true,
			state: "dispatching",
			reason: null,
		});
		expect(dispatchLabel(s)).toBe("Dispatching");
		expect(dispatchTone(s)).toBe("ok");
		expect(dispatchAction(s)).toBe("stop");
		expect(dispatchExplain(s)).toContain("brain chooses safe waves");
		expect(dispatchExplain(s)).toContain("maximum");
		expect(dispatchExplain(s)).toContain("resource locks");
	});

	test("a hold is 'it stopped itself', and says it resumes on its own", () => {
		const s = status({
			playing: true,
			running: true,
			state: "held",
			selfStopped: true,
			reason: "rate-limited",
			hold: { until: 1_000, reason: "rate-limited" },
		});
		expect(dispatchLabel(s)).toBe("Rate-limited");
		expect(dispatchTone(s)).toBe("warn");
		// Still playing, so the button offers stop.
		expect(dispatchAction(s)).toBe("stop");
		const words = dispatchExplain(s);
		expect(words).toContain("mfw is holding dispatch itself");
		expect(words).toContain("resumes on its own");
		expect(words).not.toContain("You stopped");
	});

	test("a red main is the breaker, and never reads as a manual stop", () => {
		const s = status({
			playing: true,
			running: true,
			state: "main_red",
			selfStopped: true,
			reason: "main is red (MFW-1)",
		});
		expect(dispatchLabel(s)).toBe("Main is red");
		expect(dispatchTone(s)).toBe("critical");
		expect(dispatchExplain(s)).toContain("mfw stopped itself");
		expect(dispatchExplain(s)).toContain("MFW-1");
		expect(dispatchExplain(s)).not.toContain("You stopped");
	});

	test("a suspended board says which, too", () => {
		const s = status({
			playing: true,
			running: true,
			state: "board_suspended",
			selfStopped: true,
			reason: "the board is suspended (see board.suspended)",
		});
		expect(dispatchLabel(s)).toBe("Board suspended");
		expect(dispatchExplain(s)).toContain("does not trust the board on disk");
	});
});

describe("the master stop, and the fleet underneath it", () => {
	const fleet = (
		playing: number,
		total: number,
		globalPlaying = true,
	): FleetLike => ({
		playing,
		total,
		globalPlaying,
		summary:
			total === 0
				? "empty"
				: playing === 0
					? "none"
					: playing === total
						? "all"
						: "some",
		projects: Array.from({ length: total }, (_, i) => ({
			project: `p${i}`,
			error: null,
		})),
	});

	test("the master switch is one boolean, so the control is one toggle", () => {
		expect(globalAction(fleet(2, 3, true))).toBe("stop");
		expect(globalAction(fleet(2, 3, false))).toBe("play");
		// Independent of per-project state.
		expect(globalAction(fleet(0, 3, true))).toBe("stop");
		expect(globalAction(fleet(3, 3, false))).toBe("play");
	});

	test("a stopped mfw still reports what each project is set to", () => {
		// Regression: collapsing to "all stopped" hides that armed projects start
		// as soon as the master goes back on.
		const f = fleet(2, 3, false);
		expect(fleetLabel(f)).toBe("mfw stopped (2/3 armed)");
		expect(fleetTone(f)).toBe("warn");
	});

	test("a running mfw reports how many projects are playing", () => {
		expect(fleetLabel(fleet(0, 3))).toBe("Running (0/3 playing)");
		expect(fleetLabel(fleet(2, 3))).toBe("Running (2/3 playing)");
		expect(fleetLabel(fleet(3, 3))).toBe("Running (3/3 playing)");
		expect(fleetTone(fleet(0, 3))).toBe("neutral");
		expect(fleetTone(fleet(3, 3))).toBe("ok");
	});

	test("with nothing attached there is nothing to say", () => {
		expect(fleetLabel(fleet(0, 0))).toBe("No projects");
		expect(fleetTone(fleet(0, 0))).toBe("neutral");
	});

	test("projects whose status could not be read are named", () => {
		const f = fleet(1, 2);
		f.projects[1] = { project: "broken", error: "disk full" };
		expect(fleetFailures(f)).toEqual(["broken"]);
		expect(canStartFleet(f)).toBe(false);
		expect(fleetTone(f)).toBe("warn");
		expect(canStartFleet(fleet(1, 2))).toBe(true);
	});

	test("keeps the global control rendered and blocks only unsafe starts", () => {
		expect(dispatchControlsSource).not.toContain(
			"if (!data || data.total === 0) return null",
		);
		expect(dispatchControlsSource).toContain("Cannot verify ${failures.join");
		expect(dispatchControlsSource).toContain("startBlocked");
		expect(dispatchControlsSource).toContain(
			"pending || unavailable || startBlocked",
		);
	});

	test("renders unreadable global state as unknown or error instead of Play", () => {
		expect(dispatchControlsSource).toContain("CircleAlert");
		expect(dispatchControlsSource).toContain("CircleHelp");
		expect(dispatchControlsSource).toContain("const statusIcon = unavailable");
		expect(dispatchControlsSource).toContain("{statusIcon}");
		expect(dispatchControlsSource).toContain(
			"aria-pressed={unavailable ? undefined : playing}",
		);
	});
});

describe("the per-project button owns only the project's own switch", () => {
	test("a switched-on project still offers STOP while mfw is stopped", () => {
		// `playing` is false (the AND), but "play" would flip an already-on switch
		// and do nothing.
		const s = status({
			playing: false,
			projectPlaying: true,
			globalPlaying: false,
			running: true,
			state: "stopped_global",
			reason: "mfw is stopped everywhere",
		});
		expect(dispatchAction(s)).toBe("stop");
		expect(dispatchLabel(s)).toBe("mfw stopped");
		expect(dispatchTone(s)).toBe("warn");
		expect(dispatchExplain(s)).toContain("switched ON");
		// Points at the control that fixes it.
		expect(dispatchExplain(s)).toContain("start mfw");
		expect(dispatchExplain(s)).toContain("will not do it");
	});

	test("a self-stop is still distinguished from a master stop", () => {
		const s = status({
			playing: false,
			projectPlaying: true,
			globalPlaying: false,
			state: "stopped_global",
		});
		// A master stop is manual: nothing clears it on its own.
		expect(s.selfStopped).toBe(false);
	});
});

describe("where the controls landed", () => {
	const read = (rel: string) =>
		readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
	const shell = read("components/AppShell.tsx");
	const projectLayout = read("features/shell/ProjectLayout.tsx");
	/** `toContain` on a whole source file dumps the file into the failure. */
	const has = (source: string, needle: string) => source.includes(needle);

	test("the sidebar carries a play/stop on every project row", () => {
		// Must be a sibling of the row's NavLink; nested, every click also navigates.
		const rows = shell.slice(
			shell.indexOf("(projects.data ?? []).map"),
			shell.indexOf("projects.data?.length === 0"),
		);
		expect(
			/<NavLink[\s\S]*?\/>\s*<ProjectDispatchButton\s+project=\{p\.name\}/.test(
				rows,
			),
		).toBe(true);
		expect(has(rows, "<GlobalDispatchButton")).toBe(false);
		expect(rows.indexOf("<NavLink")).toBeLessThan(
			rows.indexOf("<ProjectDispatchButton"),
		);
	});

	test("the global mfw control is in the shell, reachable from any route", () => {
		expect(has(shell, "<GlobalDispatchButton")).toBe(true);
	});

	test("the sidebar puts the global mfw action in a full row directly above Settings", () => {
		const sidebar = shell.slice(
			shell.indexOf("function Sidebar"),
			shell.indexOf("function Divider"),
		);
		const header = sidebar.slice(
			sidebar.indexOf("{/* Health belongs to the mfw identity"),
			sidebar.indexOf("{PRIMARY_NAV.map"),
		);
		const bottom = sidebar.slice(
			sidebar.lastIndexOf('<div className="flex-1" />'),
		);
		const control =
			'<GlobalDispatchButton variant="navigation" compact={!expanded} />';
		expect(
			/<div className="flex items-center gap-1">[\s\S]*?>\s*mfw\s*<\/span>\s*<HealthDot \/>\s*<\/div>/.test(
				header,
			),
		).toBe(true);
		expect(header).not.toContain("<GlobalDispatchButton");
		expect(bottom).toContain(control);
		expect(bottom.indexOf(control)).toBeLessThan(
			bottom.indexOf('label: "Settings"'),
		);
		expect(bottom).toContain(`${control}\n\t\t\t<NavLink`);
	});

	test("the phone header carries only the global control, not a redundant per-project one", () => {
		// The sidebar is hidden on phones, so the global control must be here.
		// The per-project control is not duplicated: `ProjectLayout` has it.
		const mobile = shell.slice(shell.indexOf("function MobileHeader"));
		expect(has(mobile, "<ProjectDispatchButton")).toBe(false);
		expect(has(mobile, '<GlobalDispatchButton variant="icon" />')).toBe(true);
	});

	test("the phone header groups health with mfw before the middle switcher and rightmost global control", () => {
		const mobile = shell.slice(
			shell.indexOf("function MobileHeader"),
			shell.indexOf("export function ProjectSwitcher"),
		);
		expect(
			/<div className="flex items-center gap-1">\s*<span className="font-semibold">mfw<\/span>\s*<HealthDot \/>\s*<\/div>/.test(
				mobile,
			),
		).toBe(true);
		expect(mobile.indexOf("<HealthDot")).toBeLessThan(
			mobile.indexOf("<ProjectSwitcher"),
		);
		expect(mobile.indexOf("<ProjectSwitcher")).toBeLessThan(
			mobile.indexOf("<GlobalDispatchButton"),
		);
	});

	test("the project header carries the full control only on phones", () => {
		// Phones lose the sidebar, so the header keeps the full control; on
		// desktop the sidebar row is the only one. Exactly one occurrence also
		// catches a desktop-visible duplicate.
		const controls =
			projectLayout.match(/<ProjectDispatchButton\b[^>]*\/>/g) ?? [];
		expect(controls).toHaveLength(1);
		expect(controls[0]).toMatch(/\bproject=\{project\}/);
		expect(controls[0]).toMatch(/\bclassName="[^"]*\bmd:hidden\b[^"]*"/);
		expect(has(projectLayout, "<GlobalDispatchButton")).toBe(false);
	});
});
