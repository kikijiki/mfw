import { z } from "zod";

/**
 * The doctor's result, for people and machines. `DoctorReportSchema` is the
 * JSON contract of `mfw doctor --json`: a breaking change raises
 * `DOCTOR_SCHEMA_VERSION`.
 *
 * `severity` says what a problem means: `blocker` stops autonomous runs or
 * leaves the install unsafe, `warn` degrades it, `info` is worth knowing.
 * Every string is passed through `sanitizeText` before it is stored here.
 */

export const DOCTOR_SCHEMA_VERSION = 1;

export const DOCTOR_GROUPS = [
	"host",
	"tools",
	"storage",
	"auth",
	"install",
	"exposure",
	"harness",
	"egress",
	"project",
] as const;

const GROUP_TITLES: Record<DoctorGroup, string> = {
	host: "Host",
	tools: "Tools",
	storage: "Storage",
	auth: "Auth",
	install: "Installation",
	exposure: "Exposure",
	harness: "Agent CLIs",
	egress: "Egress",
	project: "Projects",
};

export const DoctorCheckSchema = z.strictObject({
	id: z.string(),
	group: z.enum(DOCTOR_GROUPS),
	severity: z.enum(["blocker", "warn", "info"]),
	status: z.enum(["ok", "problem", "skipped"]),
	detail: z.string(),
	fix: z.string().optional(),
	project: z.string().optional(),
});

export const DoctorReportSchema = z.strictObject({
	schemaVersion: z.literal(DOCTOR_SCHEMA_VERSION),
	/** False when any blocker exists. */
	ok: z.boolean(),
	summary: z.strictObject({
		blocker: z.number().int(),
		warn: z.number().int(),
		info: z.number().int(),
		ok: z.number().int(),
		skipped: z.number().int(),
	}),
	checks: z.array(DoctorCheckSchema),
});

export type DoctorGroup = (typeof DOCTOR_GROUPS)[number];
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

/**
 * Safe to print: no terminal control sequences or bidi overrides from a file
 * name or a tool's output, and no credential in a recognisable form. It cannot
 * recognise every secret, so `redactText` is what makes a report shareable.
 */
export function sanitizeText(text: string): string {
	return (
		text
			.replace(/[\t\n\r]+/g, " ")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
			// Up to the last `@`, because a password can hold `/` or `@`.
			.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s'"]*@/gi, "$1***@")
			.replace(
				/([?&](?:access_token|token|api_key|apikey|auth|password|secret)=)[^&\s'"]+/gi,
				"$1***",
			)
			.replace(/mfwt_[A-Za-z0-9_-]+/g, "mfwt_***")
			.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
			.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_***")
			.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
			.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AKIA***")
			.replace(/\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g, "xox-***")
			.replace(
				/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
				"jwt_***",
			)
	);
}

/** What identifies this machine in a report that will be shared. */
export interface RedactContext {
	home?: string;
	mfwHome?: string;
	user?: string;
	/** Given only when project names should be hidden too. */
	projects?: readonly string[];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const PATH_END = "(?=$|[/\\s'\":,;)\\]])";

function replacePath(
	text: string,
	path: string | undefined,
	to: string,
): string {
	if (!path || path === "/") return text;
	const trimmed = path.replace(/\/+$/, "");
	return text.replace(
		new RegExp(`${escapeRegex(trimmed)}${PATH_END}`, "g"),
		() => to,
	);
}

/** For pasting into a public issue: no home paths, user name, URL paths or tokens. */
export function redactText(text: string, ctx: RedactContext): string {
	let s = sanitizeText(text)
		// Scheme and host only: a path or query can name a private repository.
		.replace(
			/\b([a-z][a-z0-9+.-]*):\/\/(?:\*\*\*@)?([^/\s:?#'"]+)[^\s'"]*/gi,
			"$1://$2",
		)
		.replace(/\b[\w.-]+@([\w-]+(?:\.[\w-]+)+):[^\s'"]+/g, "$1");
	// Longest first: $MFW_HOME is usually inside the home directory.
	s = replacePath(s, ctx.mfwHome, "$MFW_HOME");
	s = replacePath(s, ctx.home, "~");
	s = s.replace(/\/(?:home|Users)\/[^/\s'":,;)]+/g, "~");
	s = s.replace(new RegExp(`/root${PATH_END}`, "g"), "~");
	if (ctx.user && ctx.user.length >= 2 && ctx.user !== "unknown") {
		s = s.replace(new RegExp(`\\b${escapeRegex(ctx.user)}\\b`, "g"), "<user>");
	}
	for (const name of ctx.projects ?? []) {
		if (name) {
			s = s.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, "g"), "<project>");
		}
	}
	return s;
}

export function redactReport(
	report: DoctorReport,
	ctx: RedactContext,
): DoctorReport {
	return {
		...report,
		checks: report.checks.map((c) => ({
			...c,
			detail: redactText(c.detail, ctx),
			...(c.fix ? { fix: redactText(c.fix, ctx) } : {}),
			...(c.project ? { project: redactText(c.project, ctx) } : {}),
		})),
	};
}

export function buildReport(checks: readonly DoctorCheck[]): DoctorReport {
	const summary = { blocker: 0, warn: 0, info: 0, ok: 0, skipped: 0 };
	for (const c of checks) {
		if (c.status === "ok") summary.ok++;
		else if (c.status === "skipped") summary.skipped++;
		else summary[c.severity]++;
	}
	return {
		schemaVersion: DOCTOR_SCHEMA_VERSION,
		ok: summary.blocker === 0,
		summary,
		checks: [...checks],
	};
}

/** 0 without blockers, 1 with any. Warnings never fail the command. */
export function doctorExitCode(report: DoctorReport): number {
	return report.ok ? 0 : 1;
}

function mark(c: DoctorCheck): string {
	if (c.status === "ok") return "ok     ";
	if (c.status === "skipped") return "skip   ";
	return c.severity === "blocker"
		? "BLOCKER"
		: c.severity === "warn"
			? "warn   "
			: "info   ";
}

export function renderDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	for (const group of DOCTOR_GROUPS) {
		const checks = report.checks.filter((c) => c.group === group);
		if (checks.length === 0) continue;
		lines.push(GROUP_TITLES[group]);
		for (const c of checks) {
			const where = c.project ? `[${c.project}] ` : "";
			lines.push(`  ${mark(c)} ${c.id}: ${where}${c.detail}`);
			if (c.fix && c.status === "problem")
				lines.push(`          fix: ${c.fix}`);
		}
		lines.push("");
	}
	const s = report.summary;
	lines.push(
		`${s.blocker} blocker(s), ${s.warn} warning(s), ${s.info} note(s), ${s.ok} ok, ${s.skipped} skipped. Nothing was changed.`,
	);
	return lines.join("\n");
}
