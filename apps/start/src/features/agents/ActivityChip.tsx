import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import {
	ACTIVITY_LABEL,
	ACTIVITY_TONE,
	activityExplanation,
	asActivityDetail,
	scopeCounts,
	shownActivity,
} from "./activity";

/**
 * What a live run is doing, as a chip: working, approval, question, stalled,
 * idle. Renders nothing for a finished run or a row with no activity yet.
 * With `to`, the chip is the way into the run.
 */
export function ActivityChip({
	run,
	to,
}: {
	run: { state: string; activity?: unknown; activityDetail?: unknown };
	to?: string;
}) {
	const activity = shownActivity(run);
	if (!activity) return null;
	const title = activityExplanation(
		activity,
		asActivityDetail(run.activityDetail),
	);
	const chip = (
		<Chip tone={ACTIVITY_TONE[activity]} title={title}>
			{ACTIVITY_LABEL[activity]}
		</Chip>
	);
	return to ? (
		<AppLink to={to} aria-label={`${title} Open the run.`}>
			{chip}
		</AppLink>
	) : (
		chip
	);
}

/**
 * Files the run has touched, how many fall outside its task's `owns`, and how
 * many another claimed task owns. Only once the scope watchdog has written a
 * sample; nothing otherwise.
 */
export function ScopeMeter({ sample }: { sample: unknown }) {
	const counts = scopeCounts(sample);
	if (!counts) return null;
	const overLimit = counts.maxFiles !== null && counts.files > counts.maxFiles;
	const tone =
		counts.foreign > 0 || overLimit
			? "critical"
			: counts.outside > 0
				? "warn"
				: "neutral";
	const limit = counts.maxFiles !== null ? ` (limit ${counts.maxFiles})` : "";
	const owners = counts.foreignFiles
		.slice(0, 3)
		.map((f) => `${f.path} (${f.taskId})`)
		.join(", ");
	const title = `${counts.files} file${counts.files === 1 ? "" : "s"} changed${limit}, ${counts.outside} outside the task's owns, ${counts.foreign} owned by another claimed task${owners ? `: ${owners}` : ""}`;
	return (
		<Chip tone={tone} title={title}>
			<span className="mfw-num">
				{counts.files}
				{counts.outside > 0 || counts.foreign > 0
					? ` / ${counts.outside} / ${counts.foreign}`
					: ""}{" "}
				files
			</span>
		</Chip>
	);
}
