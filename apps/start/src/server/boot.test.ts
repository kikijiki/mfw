import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("eager orchestrator startup", () => {
	test("a fatal boot rejection fails server startup", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "fixtures/boot-failure-child.ts"),
			],
			{ stderr: "pipe" },
		);
		const exitCode = await Promise.race([
			child.exited,
			Bun.sleep(5_000).then(() => null),
		]);
		if (exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		const stderr = await new Response(child.stderr).text();

		expect(exitCode).toBe(1);
		expect(stderr).toContain("orchestrator boot failed");
		expect(stderr).toContain("fatal eager boot failure");
	});
});
