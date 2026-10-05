// Hoisted to @mfw/board-core (generic, not board-specific); re-exported by
// name so existing consumers of @mfw/board's surface (scheduler.ts,
// task-service.ts) don't need to change their import source.
export {
	filesOutsideOwns,
	findOwnershipConflicts,
	normalizeOwnsPattern,
	type OwnershipConflict,
	type OwnershipNode,
	overlappingPatterns,
	ownsPath,
	patternsOverlap,
	validateOwnsPattern,
} from "@mfw/board-core";
export * from "./claim.ts";
export * from "./project.ts";
export * from "./state.ts";
