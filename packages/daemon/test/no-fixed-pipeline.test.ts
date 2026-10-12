import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * CI guard for P3 ("the brain owns failure policy; delete the fixed
 * pipeline"): the names of the retired paths must not come back into
 * `packages/daemon/src`. A renamed copy of the old pipeline is still the old
 * pipeline, so this is a grep, not a type check.
 */

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (name.endsWith(".ts")) out.push(path);
	}
	return out;
}

const FILES = sources(SRC).map((path) => ({
	path,
	text: readFileSync(path, "utf8"),
}));

/** What the plan names, then the rest of the retired surface. */
const BANNED: { name: string | RegExp; why: string }[] = [
	{ name: "replan_decide", why: "the replan finalize step" },
	{ name: "REPLAN_ACTIONS", why: "the replan action vocabulary" },
	{
		name: "spawn_repair",
		why: "the autonomous repair step (a continue: spawn)",
	},
	{
		name: "spawn_resume",
		why: "the autonomous resume step (a continue: spawn)",
	},
	{ name: "decide_resume", why: "the bounded resume decision" },
	{ name: "bump_review_round", why: "the review-round policy step" },
	{ name: "startResume", why: "RunEngine's autonomous resume" },
	{ name: "startAnsweredResume", why: "RunEngine's answered resume" },
	{ name: "startUnblock", why: "RunEngine's automatic unblock" },
	{ name: "maxStalls", why: "a stall cap as policy" },
	{ name: "maxResumes", why: "a resume cap as policy" },
	{ name: /\.replan\(/, why: "BrainService.replan" },
	{ name: "replanEnabled", why: "the replan gate" },
];

describe("the fixed pipeline stays deleted", () => {
	for (const { name, why } of BANNED) {
		test(`${String(name)} is absent from packages/daemon/src (${why})`, () => {
			const hits = FILES.filter(({ text }) =>
				typeof name === "string" ? text.includes(name) : name.test(text),
			).map(({ path }) => path.slice(SRC.length + 1));
			expect(hits).toEqual([]);
		});
	}

	test("the assistance settings that only steered the old pipeline are gone", () => {
		const config = FILES.find(({ path }) => path.endsWith("/config.ts"));
		// The stored schema keeps one assistance policy: the review floor.
		expect(config?.text).toContain("changeReview");
		const schema = config?.text.slice(
			config.text.indexOf("export const assistanceSchema"),
			config.text.indexOf("export type RecoveryAssistance"),
		);
		expect(schema).not.toContain('z.enum(["assisted", "escalate"])');
	});
});
