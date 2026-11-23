import { describe, expect, test } from "bun:test";
import { runDoctorCommand } from "../src/doctor/cli.ts";
import {
	DoctorReportSchema,
	redactReport,
	redactText,
	sanitizeText,
} from "../src/doctor/report.ts";
import { runDoctor } from "../src/doctor/run.ts";
import { fixture, healthyProject } from "./support/doctor-fixture.ts";

// Assembled so this file holds nothing a secret scanner would flag.
const GHP = `ghp_${"a1B2".repeat(9)}`;
const PAT = `github_pat_${"x9Y8".repeat(10)}`;
const AWS = `AKIA${"ABCDEFGH23456789"}`;
const SLACK = `xoxb-${"1234567890"}-${"abcdefghij"}`;
const JWT = `eyJ${"hbGciOiJI"}.eyJ${"zdWIiOiIx"}.${"c2lnbmF0dXJl"}`;

describe("sanitizeText removes credentials wherever they appear", () => {
	for (const [label, secret] of [
		["ghp_", GHP],
		["github_pat_", PAT],
		["AKIA", AWS],
		["xoxb-", SLACK],
		["a JWT", JWT],
	] as const) {
		test(`the reviewer's case: bare ${label}`, () => {
			expect(sanitizeText(`value ${secret} here`)).not.toContain(secret);
		});
	}

	test("?access_token= in a URL", () => {
		const out = sanitizeText("https://h.example/r.git?access_token=s3cret&x=1");
		expect(out).not.toContain("s3cret");
	});

	test("a URL password containing a slash", () => {
		const out = sanitizeText("https://bot:pa/ss@github.com/o/r.git");
		expect(out).not.toContain("pa/ss");
		expect(out).toContain("github.com");
	});

	test("L5: bidi controls cannot spoof a file name", () => {
		expect(sanitizeText("a‮gnp.exe⁦b‏c")).toBe("agnp.exebc");
	});
});

const CTX = {
	home: "/home/alice",
	mfwHome: "/home/alice/.local/share/mfw",
	user: "alice",
};

describe("redactText", () => {
	test("the home directory becomes ~", () => {
		expect(redactText("at /home/alice/dev/x", CTX)).toBe("at ~/dev/x");
	});

	test("MFW_HOME is named, not spelled out", () => {
		expect(redactText("/home/alice/.local/share/mfw/auth.db", CTX)).toBe(
			"$MFW_HOME/auth.db",
		);
	});

	test("a longer name is not cut by a shorter home", () => {
		expect(redactText("/srv/x /home/alice2/y", { home: "/home/alice" })).toBe(
			"/srv/x ~/y",
		);
	});

	test("another user's home is hidden too", () => {
		expect(redactText("/home/bob/a and /Users/carol/b", CTX)).toBe(
			"~/a and ~/b",
		);
	});

	test("the user name is removed as a word only", () => {
		expect(redactText("owner alice, malice stays", CTX)).toBe(
			"owner <user>, malice stays",
		);
	});

	test("URLs are reduced to their host", () => {
		expect(
			redactText("remote https://bot:x@github.com/acme/secret-repo.git", CTX),
		).toBe("remote https://github.com");
		expect(redactText("remote git@github.com:acme/secret-repo.git", CTX)).toBe(
			"remote github.com",
		);
	});

	test("project names are removed only when asked", () => {
		expect(redactText("project acme failed", CTX)).toContain("acme");
		expect(
			redactText("project acme failed", { ...CTX, projects: ["acme"] }),
		).toBe("project <project> failed");
	});
});

const leaky = () =>
	fixture({
		home: "/home/alice/.local/share/mfw",
		env: { HOST: "127.0.0.1", HOME: "/home/alice", USER: "alice" },
		config: async () => ({
			ok: true,
			config: {
				projects: [
					{ name: "acme", root: "/home/alice/acme", runWorkspace: "clone" },
				],
			},
		}),
		project: async () =>
			healthyProject({
				remotes: [{ name: "origin", url: "git@github.com:acme/repo.git" }],
				untracked: {
					count: 1,
					sample: ["private-plan.md"],
					truncated: false,
				},
			}),
	});

function cli(args: string[]) {
	const out: string[] = [];
	return runDoctorCommand(args, {
		env: { HOST: "127.0.0.1", HOME: "/home/alice", USER: "alice" },
		home: "/home/alice/.local/share/mfw",
		out: (l) => out.push(l),
		err: () => {},
		probes: leaky(),
	}).then(() => out.join("\n"));
}

describe("the redacted report", () => {
	test("redactReport keeps the schema", async () => {
		const report = await runDoctor(leaky());
		expect(DoctorReportSchema.parse(redactReport(report, CTX)).ok).toBe(
			report.ok,
		);
	});

	test("--json is redacted by default", async () => {
		const text = await cli(["--json"]);
		expect(text).not.toContain("/home/alice");
		expect(text).not.toContain("private-plan.md");
		DoctorReportSchema.parse(JSON.parse(text));
	});

	test("--json --no-redact keeps the local detail", async () => {
		const text = await cli(["--json", "--no-redact"]);
		expect(text).toContain("/home/alice");
		expect(text).toContain("private-plan.md");
	});

	test("human output is unredacted unless asked", async () => {
		expect(await cli([])).toContain("/home/alice");
		const text = await cli(["--redact"]);
		expect(text).not.toContain("/home/alice");
		expect(text).not.toContain("private-plan.md");
	});

	test("--redact-projects also hides project names", async () => {
		const shown = await cli(["--json"]);
		expect(shown).toContain("acme");
		const text = await cli(["--json", "--redact-projects"]);
		expect(text).not.toContain("acme");
	});

	test("--redact and --no-redact together are a usage error", async () => {
		const code = await runDoctorCommand(["--redact", "--no-redact"], {
			env: {},
			home: "/srv/h",
			out: () => {},
			err: () => {},
			probes: fixture(),
		});
		expect(code).toBe(2);
	});
});
