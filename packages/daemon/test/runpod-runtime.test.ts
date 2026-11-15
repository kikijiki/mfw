import { describe, expect, test } from "bun:test";
import {
	MFW_RUNPOD_CPU_READY_PATH,
	mfwRunPodCpuBootstrapCommand,
} from "../src/runpod-runtime.ts";

describe("MFW RunPod CPU runtime", () => {
	test("uses a locked, checksummed and version-pinned bootstrap", () => {
		const command = mfwRunPodCpuBootstrapCommand();
		expect(command.slice(0, 5)).toEqual([
			"flock",
			"-x",
			"/run/mfw-bootstrap.lock",
			"/bin/bash",
			"-lc",
		]);
		const script = command[5] ?? "";
		expect(script).toContain("node-v24.19.0-linux-x64.tar.xz");
		expect(script).toContain(
			"14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
		);
		expect(script).toContain("bun@1.3.13");
		expect(script).toContain("@openai/codex@0.149.0");
		expect(script).toContain("@anthropic-ai/claude-code@2.1.238");
		// ACP agents with pinned npm releases.
		expect(script).toContain("opencode-ai@1.19.5");
		expect(script).toContain("@google/gemini-cli@0.68.0");
		expect(script).toContain("opencode --version >/dev/null");
		expect(script).toContain("gemini --version >/dev/null");
		expect(script).toContain("@earendil-works/pi-coding-agent@1.5.2");
		expect(script).toContain("pi-acp@0.0.34");
		expect(script).toContain("pi --version >/dev/null");
		expect(script).toContain(`touch ${MFW_RUNPOD_CPU_READY_PATH}`);
	});
});
