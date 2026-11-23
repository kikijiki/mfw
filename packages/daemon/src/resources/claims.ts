import type { Claim } from "./types.ts";

/** The pool of a project-private semaphore. Names are slugged to the grammar. */
export function projectPoolId(projectId: string, name: string): string {
	const slug = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, 64) || "x";
	return `project.${slug(projectId)}.${slug(name)}`;
}

export function projectClaim(projectId: string, name: string): Claim {
	return {
		poolId: projectPoolId(projectId, name),
		dimension: "slot",
		amount: 1,
	};
}
