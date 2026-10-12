import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { executionTargetOptions } from "../tasks/TaskPage";
import { HostChip, RouteBadge } from "./RouteBadge";

describe("SSH host on run rows and the dock", () => {
	test("a run on a registry host shows the host chip next to its route", () => {
		const html = renderToStaticMarkup(
			<RouteBadge
				providerId="claude-cli"
				route={{
					key: "claude-cli",
					reason: "project-model",
					detail: "the project default, on host box-a",
					endpoint: null,
					hostId: "box-a",
				}}
			/>,
		);
		expect(html).toContain("ssh:box-a");
		expect(html).toContain("claude-cli");
	});

	test("a local or pre-host run shows no host chip", () => {
		expect(renderToStaticMarkup(<HostChip hostId={null} />)).toBe("");
		const html = renderToStaticMarkup(
			<RouteBadge
				providerId="claude-cli"
				route={{
					key: "claude-cli",
					reason: "task",
					detail: "",
					endpoint: null,
				}}
			/>,
		);
		expect(html).not.toContain("ssh:");
	});

	test("a task can pick local, any SSH host, one host or RunPod, and keeps an unknown pin", () => {
		expect(executionTargetOptions("local", ["box-a", "box-b"])).toEqual([
			"local",
			"ssh",
			"ssh:box-a",
			"ssh:box-b",
			"runpod",
		]);
		expect(executionTargetOptions("ssh:gone", [])).toContain("ssh:gone");
	});
});
