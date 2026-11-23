import { describe, expect, test } from "bun:test";
import { dangerousGitKeys } from "../src/containment/git-config-scan.ts";

describe("dangerousGitKeys", () => {
	test("an ordinary clone's config is clean", () => {
		const config = `[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = /tmp/source.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
[user]
	name = Agent
	email = agent@example.invalid
# a comment
; another
`;
		expect(dangerousGitKeys(config)).toEqual([]);
	});

	for (const [config, key] of [
		["[core]\n\thooksPath = /x\n", "core.hookspath"],
		["[CORE]\n\tFSMonitor = /x\n", "core.fsmonitor"],
		["[core]\n\tsshCommand = /x\n", "core.sshcommand"],
		['[filter "lfs"]\n\tsmudge = /x\n', "filter.<name>.smudge"],
		['[diff "x"]\n\ttextconv = /x\n', "diff.<name>.textconv"],
		['[merge "x"]\n\tdriver = /x\n', "merge.<name>.driver"],
		['[remote "o"]\n\tuploadpack = /x\n', "remote.<name>.uploadpack"],
		["[include]\n\tpath = /x\n", "include.path"],
		['[includeIf "gitdir:/"]\n\tpath = /x\n', "includeif.<name>.path"],
		["[alias]\n\tst = !/x\n", "alias.st"],
		["[credential]\n\thelper = /x\n", "credential.helper"],
		['[submodule "s"]\n\tupdate = !/x\n', "submodule.<name>.update"],
		// The old dotted form, and a key sharing the header's line.
		["[filter.x]\n\tclean = /x\n", "filter.<name>.clean"],
		["[core] hooksPath = /x\n", "core.hookspath"],
		// CRLF and a byte-order mark, both of which git accepts.
		["﻿[core]\r\n\thooksPath = /x\r\n", "core.hookspath"],
		// A key with no value is still set.
		["[core]\n\tfsmonitor\n", "core.fsmonitor"],
	] as const) {
		test(`flags ${key} in ${JSON.stringify(config)}`, () => {
			expect(dangerousGitKeys(config)).toContain(key);
		});
	}

	test("a continued value is not read as a key", () => {
		expect(
			dangerousGitKeys("[user]\n\tname = a \\\n hooksPath = b\n[core]\n"),
		).toEqual([]);
	});

	test("a key after a continued value is still read", () => {
		expect(
			dangerousGitKeys("[core]\n\teol = a\\\nb\n\thooksPath = /x\n"),
		).toEqual(["core.hookspath"]);
	});

	for (const config of [
		"[core\n\thooksPath = /x\n",
		"hooksPath = /x\n",
		"[core]\n\t!bad = 1\n",
		'[user]\n\tname = "open\n',
	]) {
		test(`reports what it cannot read in ${JSON.stringify(config)}`, () => {
			expect(
				dangerousGitKeys(config).some((k) => k.startsWith("unreadable")),
			).toBe(true);
		});
	}
});
