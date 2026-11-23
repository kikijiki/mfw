import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip, Panel } from "~/components/Page";
import { Button } from "~/components/ui/button";
import { useToast } from "~/lib/toast";
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
	const queryClient = useQueryClient();
	const { toast } = useToast();
	// Always a fresh redacted report from the server, never the one on screen.
	const copyRedacted = async () => {
		try {
			const shareable = await queryClient.fetchQuery({
				...trpc.system.doctor.queryOptions({ redact: true }),
				staleTime: 0,
				gcTime: 0,
			});
			await navigator.clipboard.writeText(JSON.stringify(shareable, null, 2));
			toast({ tone: "success", title: "Redacted report copied" });
		} catch {
			toast({ tone: "error", title: "Could not copy the report" });
		}
	};
	return (
		<Panel
			title="Health"
			actions={
				<div className="flex items-center gap-1">
					<Button
						size="xs"
						variant="outline"
						disabled={!report}
						onClick={() => void copyRedacted()}
					>
						Copy redacted
					</Button>
					<Button
						size="xs"
						variant="outline"
						disabled={doctor.isFetching}
						onClick={() => void doctor.refetch()}
					>
						{doctor.isFetching ? "Checking" : "Check again"}
					</Button>
				</div>
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
