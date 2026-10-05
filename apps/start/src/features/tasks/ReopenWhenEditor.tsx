import type { ReopenCondition } from "@mfw/daemon/tasks/types";
import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/**
 * Editor for `reopen_when`: the facts that move a parked task (blocked, or
 * backlog held by hand) back to ready. Every condition must hold, and the
 * list is cleared once it fires, so parking the task again needs a new one.
 */
export function ReopenWhenEditor({
	value,
	onChange,
}: {
	value: ReopenCondition[];
	onChange: (value: ReopenCondition[]) => void;
}) {
	const editorId = useId();
	const update = (index: number, next: ReopenCondition) =>
		onChange(value.map((c, i) => (i === index ? next : c)));

	return (
		<div className="flex flex-col gap-1.5">
			<p style={{ color: "var(--mfw-fg-muted)" }}>
				When the task is blocked or held in backlog, it moves to ready once
				every condition holds. Commands require separate operator arming and an
				active scheduler, and run at most every 10 minutes in the armed
				checkout. Editing a condition requires rearming it. The conditions are
				cleared when they fire.
			</p>
			<ul className="flex flex-col gap-1.5">
				{value.map((condition, index) => {
					const isRun = "run" in condition;
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: conditions are an ordered list edited in place
							key={index}
							className="flex flex-wrap items-center gap-2"
						>
							<select
								aria-label={`Condition ${index + 1} kind`}
								className="mfw-focus min-h-8 shrink-0 border px-1.5"
								style={{
									background: "var(--mfw-bg-raised)",
									borderColor: "var(--mfw-border)",
									borderRadius: "var(--mfw-radius-sm)",
									color: "var(--mfw-fg)",
								}}
								value={isRun ? "run" : "task_done"}
								onChange={(e) =>
									update(
										index,
										e.target.value === "run"
											? { run: "", expect_exit: 0 }
											: { task_done: "" },
									)
								}
							>
								<option value="task_done">task done</option>
								<option value="run">command</option>
							</select>
							<Input
								className="flex-1"
								aria-label={`Condition ${index + 1} ${isRun ? "command" : "task id"}`}
								placeholder={
									isRun ? "curl -fsS localhost:8080/health" : "MFW-12"
								}
								value={isRun ? condition.run : condition.task_done}
								onChange={(e) =>
									update(
										index,
										isRun
											? { ...condition, run: e.target.value }
											: { task_done: e.target.value.trim() },
									)
								}
							/>
							{isRun && (
								<>
									<label
										htmlFor={`${editorId}-${index}-exit`}
										className="flex items-center gap-1"
									>
										Expected exit
										<Input
											id={`${editorId}-${index}-exit`}
											className="w-20"
											type="number"
											step={1}
											aria-label={`Condition ${index + 1} expected exit code`}
											value={condition.expect_exit}
											onChange={(e) => {
												const code = e.target.valueAsNumber;
												if (Number.isInteger(code))
													update(index, { ...condition, expect_exit: code });
											}}
										/>
									</label>
									<label
										htmlFor={`${editorId}-${index}-timeout`}
										className="flex items-center gap-1"
									>
										Timeout (seconds)
										<Input
											id={`${editorId}-${index}-timeout`}
											className="w-24"
											type="number"
											min={0.001}
											step="any"
											placeholder="300"
											aria-label={`Condition ${index + 1} timeout in seconds (blank uses 300)`}
											value={condition.timeout ?? ""}
											onChange={(e) => {
												if (e.target.value === "") {
													update(index, {
														run: condition.run,
														expect_exit: condition.expect_exit,
													});
												} else if (e.target.valueAsNumber > 0) {
													update(index, {
														...condition,
														timeout: e.target.valueAsNumber,
													});
												}
											}}
										/>
									</label>
								</>
							)}
							<Button
								size="icon-xs"
								variant="ghost"
								aria-label={`Remove condition ${index + 1}`}
								onClick={() => onChange(value.filter((_, i) => i !== index))}
							>
								<Trash2 aria-hidden />
							</Button>
						</li>
					);
				})}
			</ul>
			<Button
				className="self-start"
				size="xs"
				variant="outline"
				onClick={() => onChange([...value, { task_done: "" }])}
			>
				<Plus aria-hidden /> Condition
			</Button>
		</div>
	);
}

/** Drop conditions left blank; the server rejects an empty id or command. */
export function completeReopenConditions(
	value: ReopenCondition[],
): ReopenCondition[] {
	return value.filter((c) =>
		"run" in c ? c.run.trim().length > 0 : c.task_done.length > 0,
	);
}
