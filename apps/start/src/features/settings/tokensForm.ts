/** The Tokens form's choices, and turning them into a create request. */

export const TOKEN_SCOPE_CHOICES = [
	{
		scope: "status:read",
		label: "Status",
		hint: "Health, inbox and what is running.",
	},
	{
		scope: "board:read",
		label: "Board read",
		hint: "Tasks, ADRs, clarifications and audit events.",
	},
	{
		scope: "board:write",
		label: "Board write",
		hint: "Edit task content and file tasks in backlog.",
	},
	{
		scope: "runs:act",
		label: "Run tasks",
		hint: "Start and stop runs, read transcripts, move tasks to ready.",
	},
] as const;

export const TOKEN_EXPIRY_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TokenForm {
	name: string;
	scopes: readonly string[];
	project: string;
	days: string;
}

export type TokenDraft = {
	name: string;
	scopes: string[];
	project?: string;
	ttlMs: number;
};

/** The request to send, or the problem to show. */
export function tokenDraft(form: TokenForm): TokenDraft | string {
	const name = form.name.trim();
	if (!name) return "Give the token a name.";
	if (form.scopes.length === 0) return "Choose at least one scope.";
	const days = Number(form.days);
	if (!Number.isInteger(days) || days < 1 || days > TOKEN_EXPIRY_MAX_DAYS)
		return `Expiry must be 1 to ${TOKEN_EXPIRY_MAX_DAYS} days.`;
	const project = form.project.trim();
	return {
		name,
		scopes: [...form.scopes],
		...(project ? { project } : {}),
		ttlMs: days * DAY_MS,
	};
}
