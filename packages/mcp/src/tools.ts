import type { VerificationPlan } from "@mfw/core/taskfile";
import type { MfwClient } from "./client.ts";

type Status =
	| "backlog"
	| "ready"
	| "in_progress"
	| "blocked"
	| "review"
	| "done"
	| "archived";

type TaskType = "implementation" | "spike" | "epic" | "maintenance";
type Priority = "critical" | "high" | "medium" | "low";
type Size = "xs" | "s" | "m" | "l" | "xl";

/**
 * Tool implementations backed by the app's tRPC API. Pure forwarding: the
 * daemon does all validation and persistence. The current task/run come from
 * MFW_TASK_ID / MFW_RUN_ID in the environment (see RunEngine).
 */
export function mcpTools(client: MfwClient) {
	return {
		list_tasks: (a: { project: string; status?: Status }) =>
			client.tasks.list.query(a),

		get_task: (a: { project: string; id: string }) => client.tasks.get.query(a),

		graph: (a: { project: string }) => client.tasks.graph.query(a),

		create_task: (a: {
			project: string;
			title: string;
			body?: string;
			type?: TaskType;
			priority?: Priority;
			size?: Size | null;
			labels?: string[];
			dependsOn?: string[];
			requiresResources?: string[];
			/** Focused task evidence; project merge checks still run. */
			verification?: VerificationPlan | null;
			criteria?: { id?: string; text: string; checked?: boolean }[];
			/** Routing pins: harness or endpoint id, exact model id. */
			provider?: string | null;
			model?: string | null;
		}) => client.tasks.create.mutate(a),

		/** `baseRev` is `contentRev` as last read; a concurrent edit becomes a retryable CONFLICT. */
		edit_task: (a: {
			project: string;
			id: string;
			baseRev?: number;
			patch: {
				title?: string;
				body?: string;
				type?: TaskType;
				priority?: Priority;
				size?: Size | null;
				labels?: string[];
				dependsOn?: string[];
				requiresResources?: string[];
				criteria?: { id?: string; text: string; checked?: boolean }[];
				provider?: string | null;
				model?: string | null;
			};
		}) => client.tasks.update.mutate(a),

		/** One acceptance checklist op; the flat MCP arguments become the API's tagged op. */
		criteria: (a: {
			project: string;
			id: string;
			baseRev?: number;
			op: "add" | "toggle" | "set" | "edit" | "remove";
			selector?: string;
			text?: string;
			checked?: boolean;
		}) => {
			const selector = a.selector ?? "";
			const op =
				a.op === "add"
					? { op: "add" as const, text: a.text ?? "", checked: a.checked }
					: a.op === "set"
						? { op: "set" as const, selector, checked: a.checked ?? true }
						: a.op === "edit"
							? { op: "edit" as const, selector, text: a.text ?? "" }
							: a.op === "toggle"
								? { op: "toggle" as const, selector }
								: { op: "remove" as const, selector };
			return client.tasks.criteria.mutate({
				project: a.project,
				id: a.id,
				baseRev: a.baseRev,
				op,
			});
		},

		move_task: (a: {
			project: string;
			id: string;
			to: Status;
			reason?: string;
		}) => client.tasks.move.mutate(a),

		/** Everything needing a human, across every project. */
		inbox: () => client.inbox.list.query(),

		/** Why is this task where it is: its runs, decisions and events. */
		task_trace: (a: { project: string; taskId: string }) =>
			client.system.taskTrace.query(a),

		health: () => client.system.health.query(),

		list_runs: (a: { project: string; taskId?: string }) =>
			client.runs.list.query(a),

		/** The parsed transcript of a run, from a byte offset. */
		run_entries: (a: { project: string; runId: string; offset?: number }) =>
			client.runs.entries.query(a),
	};
}
