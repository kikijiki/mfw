import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	brainTranscriptStore,
	commitBrainTranscript,
	removeBrainTranscripts,
	restoreBrainTranscript,
} from "../src/containment/brain-transcript.ts";
import { parseSandboxProfile } from "../src/containment/profile.ts";
import { buildReadOnlyAgentProfile } from "../src/containment/role-profiles.ts";

/**
 * Security review P7, M4: a brain's session state was writable and survived
 * between turns, including Codex's `shell_snapshots`, `cache` and `tmp`, and
 * nothing removed it when a session retired.
 */

let root: string;
let turn: string;
let store: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-transcript-")));
	turn = join(root, "turn");
	mkdirSync(join(turn, "projects/mfw-brain-S1"), { recursive: true });
	store = brainTranscriptStore(join(root, "home"), "S1", "claude");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const transcript = () => join(turn, "projects/mfw-brain-S1/abc.jsonl");

describe("what survives a brain turn", () => {
	test("the transcript is restored into the next turn", async () => {
		writeFileSync(transcript(), '{"turn":1}\n');
		expect(await commitBrainTranscript(turn, store, "claude")).toBe(true);
		const next = join(root, "next");
		expect(await restoreBrainTranscript(store, next)).toBe("restored");
		expect(
			readFileSync(join(next, "projects/mfw-brain-S1/abc.jsonl"), "utf8"),
		).toBe('{"turn":1}\n');
	});

	test("nothing but the transcript is persisted", async () => {
		writeFileSync(transcript(), "{}\n");
		writeFileSync(join(turn, "projects/mfw-brain-S1/planted.sh"), "evil");
		mkdirSync(join(turn, "shell_snapshots"));
		writeFileSync(join(turn, "shell_snapshots/s.sh"), "evil");
		await commitBrainTranscript(turn, store, "claude");
		const next = join(root, "next");
		await restoreBrainTranscript(store, next);
		expect(existsSync(join(next, "projects/mfw-brain-S1/planted.sh"))).toBe(
			false,
		);
		expect(existsSync(join(next, "shell_snapshots"))).toBe(false);
	});

	test("a transcript changed since turn end is not restored", async () => {
		writeFileSync(transcript(), '{"turn":1}\n');
		await commitBrainTranscript(turn, store, "claude");
		writeFileSync(join(store, "transcript.jsonl"), '{"forged":true}\n');
		const next = join(root, "next");
		expect(await restoreBrainTranscript(store, next)).toBe("tampered");
		expect(existsSync(join(next, "projects"))).toBe(false);
	});

	test("a link planted as the transcript is not followed", async () => {
		const secret = join(root, "secret");
		writeFileSync(secret, "host secret\n");
		symlinkSync(secret, transcript());
		expect(await commitBrainTranscript(turn, store, "claude")).toBe(false);
		expect(existsSync(join(store, "transcript.jsonl"))).toBe(false);
	});

	test("a linked directory is not walked", async () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "x.jsonl"), "host data\n");
		symlinkSync(outside, join(turn, "projects/linked"));
		expect(await commitBrainTranscript(turn, store, "claude")).toBe(false);
	});

	test("the newest transcript is the one kept", async () => {
		const old = join(turn, "projects/mfw-brain-S1/old.jsonl");
		writeFileSync(old, "old\n");
		utimesSync(old, new Date(1000), new Date(1000));
		writeFileSync(transcript(), "new\n");
		await commitBrainTranscript(turn, store, "claude");
		expect(readFileSync(join(store, "transcript.jsonl"), "utf8")).toBe("new\n");
	});

	test("a planted relative path cannot escape the turn on restore", async () => {
		writeFileSync(transcript(), "{}\n");
		await commitBrainTranscript(turn, store, "claude");
		const meta = JSON.parse(readFileSync(join(store, "meta.json"), "utf8"));
		writeFileSync(
			join(store, "meta.json"),
			JSON.stringify({ ...meta, rel: "../../escaped.jsonl" }),
		);
		const next = join(root, "a/next");
		expect(await restoreBrainTranscript(store, next)).toBe("tampered");
		expect(existsSync(join(root, "escaped.jsonl"))).toBe(false);
	});

	test("retiring a session removes its state", async () => {
		writeFileSync(transcript(), "{}\n");
		await commitBrainTranscript(turn, store, "claude");
		expect(existsSync(store)).toBe(true);
		await removeBrainTranscripts(join(root, "home"), "S1");
		expect(existsSync(store)).toBe(false);
		expect(await restoreBrainTranscript(store, join(root, "n"))).toBe("none");
	});
});

describe("the brain's profile", () => {
	const profile = (cli: "claude" | "codex") => {
		const tree = join(root, "clone/tree");
		mkdirSync(tree, { recursive: true });
		mkdirSync(join(root, "clone/git"), { recursive: true });
		writeFileSync(join(root, "clone/mfw-workspace.json"), "{}");
		return buildReadOnlyAgentProfile({
			role: "brain",
			tree,
			runDir: join(root, "run"),
			cli,
			fleetDir: join(root, "fleet"),
			binaries: [cli],
			env: {},
		});
	};

	test("claude persists only its transcript directory", () => {
		const fleet = profile("claude").filesystem?.fleetConfig;
		expect(fleet?.writable).toEqual(["projects"]);
		expect([...(fleet?.tmpfs ?? [])].sort()).toEqual(["backups", "sessions"]);
	});

	test("codex's other directories are tmpfs", () => {
		const fleet = profile("codex").filesystem?.fleetConfig;
		expect(fleet?.writable).toEqual(["sessions"]);
		expect([...(fleet?.tmpfs ?? [])].sort()).toEqual([
			"cache",
			"shell_snapshots",
			"thread-writer-locks",
			"tmp",
		]);
	});

	test("a directory cannot be both persisted and tmpfs", () => {
		expect(() =>
			parseSandboxProfile({
				version: 1,
				role: "brain",
				filesystem: {
					fleetConfig: {
						cli: "claude",
						source: "/r/fleet",
						privateState: "/r/state",
						writable: ["projects"],
						tmpfs: ["projects"],
					},
				},
			}),
		).toThrow();
	});
});
