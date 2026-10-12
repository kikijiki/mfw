/**
 * The run slice of `useNodeActions`. Kept as its own module so the screens
 * that only handle a run keep importing what they always did; the mutations
 * themselves are built in `useNodeActions.tsx`, the one place.
 */
export {
	type ApprovalDecision,
	type RunControls,
	type RunControlTarget,
	StopRunDialog,
	useRunControls,
} from "./useNodeActions";
