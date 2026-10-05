import { Plus, Trash2 } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { RouterOutputs } from "../../lib/trpc";

/**
 * Executable verification-plan builder.
 *
 * Three check shapes, edited as rows rather than YAML (a mistyped key in a raw
 * textarea produced a task the verifier silently could not check). Types come
 * from the server (`tasks.get`), so schema changes break this file at compile
 * time.
 */

type TaskDod = NonNullable<
	NonNullable<RouterOutputs["tasks"]["get"]>["verification"]
>;
export type DodCheck = TaskDod["checks"][number];
export type Dod = { verifier: TaskDod["verifier"]; checks: DodCheck[] };
export type VerificationCheck = DodCheck;
export type VerificationPlan = Dod;

type CheckKind = "run" | "files_exist" | "diff_against_base";

export function checkKind(check: DodCheck): CheckKind {
	if ("run" in check) return "run";
	if ("files_exist" in check) return "files_exist";
	return "diff_against_base";
}

function emptyCheck(kind: CheckKind): DodCheck {
	if (kind === "run") return { run: "", expect_exit: 0 };
	if (kind === "files_exist") return { files_exist: [""] };
	return { diff_against_base: true };
}

/** The shared schema refuses an empty deterministic plan. */
export function dodError(dod: Dod | null): string | null {
	if (!dod) return null;
	if (dod.verifier === "deterministic" && dod.checks.length === 0) {
		return "A verification plan needs at least one check.";
	}
	for (const check of dod.checks) {
		if ("run" in check && !check.run.trim())
			return "A run check needs a command.";
		if (
			"files_exist" in check &&
			check.files_exist.filter((f) => f.trim()).length === 0
		) {
			return "A files_exist check needs at least one path.";
		}
	}
	return null;
}

export const verificationError = dodError;

export function VerificationBuilder({
	value,
	taskType,
	onChange,
}: {
	value: Dod | null;
	/** Legacy llm-judge plans remain readable for spikes. */
	taskType: string;
	onChange: (next: Dod | null) => void;
}) {
	const dod = value;

	if (!dod) {
		return (
			<div className="flex flex-wrap items-center gap-2">
				<span
					className="min-w-0 flex-1 basis-60 break-words"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					No task-specific checks. Project merge checks still apply.
				</span>
				<Button
					size="xs"
					variant="outline"
					onClick={() =>
						onChange({ verifier: "deterministic", checks: [emptyCheck("run")] })
					}
				>
					<Plus aria-hidden /> Add one
				</Button>
			</div>
		);
	}

	const setCheck = (index: number, next: DodCheck) => {
		onChange({
			...dod,
			checks: dod.checks.map((c, i) => (i === index ? next : c)),
		});
	};

	const error = dodError(dod);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<label className="flex items-center gap-1.5">
					<span style={{ color: "var(--mfw-fg-muted)" }}>verification</span>
					<select
						className="mfw-focus min-h-8 border px-1.5"
						style={{
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							color: "var(--mfw-fg)",
						}}
						value={dod.verifier}
						onChange={(e) =>
							onChange({
								...dod,
								verifier: e.target.value as Dod["verifier"],
							})
						}
					>
						<option value="deterministic">Run checks</option>
						<option value="llm-judge" disabled={taskType !== "spike"}>
							AI assessment{taskType !== "spike" ? " (spikes only)" : ""}
						</option>
					</select>
				</label>
				<span className="flex-1" />
				<Button size="xs" variant="ghost" onClick={() => onChange(null)}>
					Remove task checks
				</Button>
			</div>

			<ul className="flex flex-col gap-1.5">
				{dod.checks.map((check, index) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: checks are an ordered list the operator reorders by editing, not by identity
						key={index}
						className="flex flex-wrap items-center gap-1.5 border p-1.5"
						style={{
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							background: "var(--mfw-bg-subtle)",
						}}
					>
						<select
							aria-label={`Check ${index + 1} kind`}
							className="mfw-focus min-h-8 border px-1.5"
							style={{
								background: "var(--mfw-bg-raised)",
								borderColor: "var(--mfw-border)",
								borderRadius: "var(--mfw-radius-sm)",
								color: "var(--mfw-fg)",
							}}
							value={checkKind(check)}
							onChange={(e) =>
								setCheck(index, emptyCheck(e.target.value as CheckKind))
							}
						>
							<option value="run">run</option>
							<option value="files_exist">files exist</option>
							<option value="diff_against_base">diff against base</option>
						</select>

						{"run" in check ? (
							<>
								<Input
									className="min-w-40 flex-1"
									aria-label="Command"
									placeholder="bun test src/auth"
									value={check.run}
									onChange={(e) =>
										setCheck(index, { ...check, run: e.target.value })
									}
								/>
								<div className="flex items-center gap-1">
									<span aria-hidden style={{ color: "var(--mfw-fg-muted)" }}>
										exit
									</span>
									<Input
										className="w-16"
										type="number"
										aria-label="Expected exit code"
										value={check.expect_exit}
										onChange={(e) =>
											setCheck(index, {
												...check,
												expect_exit: Number(e.target.value) || 0,
											})
										}
									/>
								</div>
							</>
						) : null}

						{"files_exist" in check ? (
							<Input
								className="min-w-40 flex-1"
								aria-label="Paths, comma separated"
								placeholder="src/auth/refresh.ts, docs/auth.md"
								value={check.files_exist.join(", ")}
								onChange={(e) =>
									setCheck(index, {
										...check,
										files_exist: e.target.value
											.split(",")
											.map((s) => s.trim())
											.filter(Boolean),
									})
								}
							/>
						) : null}

						{"diff_against_base" in check ? (
							<label className="flex flex-1 items-center gap-1.5">
								<input
									type="checkbox"
									checked={check.diff_against_base}
									onChange={(e) =>
										setCheck(index, {
											...check,
											diff_against_base: e.target.checked,
										})
									}
								/>
								<span style={{ color: "var(--mfw-fg-muted)" }}>
									the branch must differ from its base
								</span>
							</label>
						) : null}

						<Button
							size="icon-xs"
							variant="ghost"
							aria-label={`Remove check ${index + 1}`}
							onClick={() =>
								onChange({
									...dod,
									checks: dod.checks.filter((_, i) => i !== index),
								})
							}
						>
							<Trash2 aria-hidden />
						</Button>
					</li>
				))}
			</ul>

			<div className="flex flex-wrap items-center gap-1.5">
				{(["run", "files_exist", "diff_against_base"] as const).map((kind) => (
					<Button
						key={kind}
						size="xs"
						variant="outline"
						onClick={() =>
							onChange({ ...dod, checks: [...dod.checks, emptyCheck(kind)] })
						}
					>
						<Plus aria-hidden /> {kind.replace(/_/g, " ")}
					</Button>
				))}
			</div>

			{error ? (
				<p className="break-words" style={{ color: "var(--mfw-warn)" }}>
					{error}
				</p>
			) : null}
		</div>
	);
}

/** @deprecated Compatibility export for older call sites. */
export const DodBuilder = VerificationBuilder;
