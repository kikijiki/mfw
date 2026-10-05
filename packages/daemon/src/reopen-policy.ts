import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import { mfwHome } from "./config.ts";
import { serializeFileMutation } from "./serialized-file-mutation.ts";
import type { ReopenCondition } from "./tasks/types.ts";

const RecordSchema = z.object({
	hash: z.string().regex(/^[a-f0-9]{64}$/),
	checkout: z.enum(["integration-worktree", "primary"]),
	armedAt: z.number(),
});
const PolicySchema = z.record(z.string(), RecordSchema);
export type ReopenCommandPolicy = z.infer<typeof RecordSchema>;

/** Operator-owned authorization; never read policy from the repository. */
export function reopenPolicyPath(
	projectRoot: string,
	home = mfwHome(),
): string {
	const key = createHash("sha256").update(resolve(projectRoot)).digest("hex");
	return join(home, "reopen", `${key}.json`);
}

export function reopenDefinitionHash(
	conditions: ReopenCondition[],
	checkPrefix: string | undefined,
	integrationBranch: string,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				conditions,
				checkPrefix: checkPrefix ?? "",
				integrationBranch,
			}),
		)
		.digest("hex");
}

export async function loadReopenPolicies(
	projectRoot: string,
	home = mfwHome(),
): Promise<Record<string, ReopenCommandPolicy>> {
	const path = reopenPolicyPath(projectRoot, home);
	try {
		return PolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read reopen command policy ${path}: ${error}`);
	}
}

export async function setReopenPolicy(
	projectRoot: string,
	taskId: string,
	policy: ReopenCommandPolicy | null,
): Promise<void> {
	const path = reopenPolicyPath(projectRoot);
	await serializeFileMutation(path, async () => {
		const policies = await loadReopenPolicies(projectRoot);
		if (policy) policies[taskId] = RecordSchema.parse(policy);
		else delete policies[taskId];
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFileAtomic(path, `${JSON.stringify(policies, null, 2)}\n`, {
			mode: 0o600,
		});
	});
}
