import { useQuery } from "@tanstack/react-query";
import { Chip, Panel } from "~/components/Page";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/lib/trpc";
import {
	healthHeadline,
	healthLabel,
	healthRows,
	healthTone,
} from "./healthView";

/**
 * The `mfw doctor` report. It only displays: each fix is text for the owner to
 * run. The query runs while this section is open, not whenever Settings mounts.
 */
export function HealthPanel({ active }: { active: boolean }) {
	const trpc = useTRPC();
	const doctor = useQuery({
		...trpc.system.doctor.queryOptions(),
		enabled: active,
		staleTime: 60_000,
		refetchOnWindowFocus: false,
	});
	const report = doctor.data;
	return (
		<Panel
			title="Health"
			actions={
				<Button
					size="xs"
					variant="outline"
					disabled={doctor.isFetching}
					onClick={() => void doctor.refetch()}
				>
					{doctor.isFetching ? "Checking" : "Check again"}
				</Button>
			}
		>
			{doctor.isError ? (
				<p role="alert">The health check failed: {doctor.error.message}</p>
			) : !report ? (
				<p>Checking this host.</p>
			) : (
				<div className="flex flex-col gap-2">
					<p>
						{healthHeadline(report)}. Agent CLIs are not run from here; use{" "}
						<code>mfw doctor</code> for their versions.
					</p>
					<ul className="flex flex-col gap-2">
						{healthRows(report).map((c) => (
							<li
								key={`${c.project ?? ""}:${c.id}`}
								className="flex min-w-0 items-start gap-2"
							>
								<Chip tone={healthTone(c)}>{healthLabel(c)}</Chip>
								<div className="min-w-0 break-words">
									<div>
										<code>{c.id}</code>
										{c.project ? ` [${c.project}]` : ""}: {c.detail}
									</div>
									{c.fix && c.status === "problem" ? (
										<div>
											Fix: <code>{c.fix}</code>
										</div>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</div>
			)}
		</Panel>
	);
}
