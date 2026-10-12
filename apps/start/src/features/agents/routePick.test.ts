import { describe, expect, test } from "bun:test";

import {
	buildPick,
	harnessChoices,
	hostChoices,
	initialForm,
} from "./routePick";

const current = {
	harness: "claude-cli",
	model: "opus",
	hostId: null,
};

describe("the routing catalogue as choices", () => {
	test("only harnesses that are drivable and installed can take a rerouted run", () => {
		const choices = harnessChoices([
			{
				id: "claude-cli",
				name: "Claude Code",
				drivable: true,
				installed: true,
				models: [{ id: "opus", label: "Opus" }],
				defaultModel: "opus",
			},
			{
				id: "gemini",
				name: "Gemini",
				drivable: false,
				installed: true,
				models: [],
				defaultModel: "",
			},
			{
				id: "codex-cli",
				name: "Codex",
				drivable: true,
				installed: false,
				models: [],
				defaultModel: "gpt-5.6",
			},
		]);
		expect(choices.map((c) => c.id)).toEqual(["claude-cli"]);
		expect(harnessChoices(undefined)).toEqual([]);
	});

	test("hosts are this machine then each registered host, in execution_target syntax", () => {
		expect(hostChoices([{ config: { id: "build-box" } }])).toEqual([
			{ value: "local", label: "This machine" },
			{ value: "ssh:build-box", label: "build-box" },
		]);
		expect(hostChoices(undefined)).toEqual([
			{ value: "local", label: "This machine" },
		]);
	});
});

describe("what a reroute form asks for", () => {
	test("an untouched form changes nothing and is refused with a reason", () => {
		const built = buildPick(initialForm(current), current, {
			requireChange: true,
		});
		expect(built).toMatchObject({ ok: false });
	});

	test("only what differs from the run's own route is sent", () => {
		const form = {
			...initialForm(current),
			harness: "codex-cli",
			model: "gpt-5.6",
		};
		expect(buildPick(form, current, { requireChange: true })).toEqual({
			ok: true,
			pick: { harness: "codex-cli", model: "gpt-5.6" },
		});
		const sameModelNewHost = {
			...initialForm(current),
			target: "ssh:build-box",
		};
		expect(
			buildPick(sameModelNewHost, current, { requireChange: true }),
		).toEqual({ ok: true, pick: { target: "ssh:build-box" } });
	});

	test("moving back to this machine from a host is a change", () => {
		const onBox = { ...current, hostId: "build-box" };
		const form = { ...initialForm(onBox), target: "local" };
		expect(buildPick(form, onBox, { requireChange: true })).toEqual({
			ok: true,
			pick: { target: "local" },
		});
	});

	test("an effort alone is a change; an unknown one is ignored", () => {
		const base = initialForm(current);
		expect(
			buildPick({ ...base, effort: "high" }, current, { requireChange: true }),
		).toEqual({ ok: true, pick: { effort: "high" } });
		expect(
			buildPick({ ...base, effort: "extreme" }, current, {
				requireChange: true,
			}),
		).toMatchObject({ ok: false });
	});

	test("an added attempt sends what is filled in, even when it matches the original", () => {
		const form = initialForm(current);
		expect(buildPick(form, current, { requireChange: false })).toEqual({
			ok: true,
			pick: { harness: "claude-cli", model: "opus", target: "local" },
		});
	});
});
