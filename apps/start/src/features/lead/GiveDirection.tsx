import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	DIRECTION_CHARS,
	type DirectionState,
	directionBadge,
	directionsOpen,
} from "./lead";

const POLL_MS = 5_000;

/**
 * One sentence to the tech lead, and how it is going. The submit key belongs
 * to the text: a double click or a retry after a lost response is the same
 * direction, and editing the text makes a new one.
 */
export function GiveDirection({
	project,
	brainOff,
}: {
	project: string;
	brainOff: boolean;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const [text, setText] = useState("");
	const key = useRef<string | null>(null);
	const directions = useQuery(
		trpc.brain.directions.queryOptions(
			{ project },
			{
				refetchInterval: (q) =>
					directionsOpen(
						q.state.data as { status: DirectionState }[] | undefined,
					)
						? POLL_MS
						: false,
			},
		),
	);
	const give = useMutation(
		trpc.brain.giveDirection.mutationOptions({
			meta: { label: "Give direction" },
			onSuccess: () => {
				key.current = null;
				setText("");
			},
			onSettled: () =>
				void queryClient.invalidateQueries(
					trpc.brain.directions.queryFilter({ project }),
				),
		}),
	);

	const blank = text.trim() === "";
	const submit = () => {
		if (blank || brainOff || give.isPending) return;
		key.current ??= crypto.randomUUID();
		give.mutate({ project, text, key: key.current });
	};

	return (
		<div className="flex flex-col gap-2">
			<form
				className="flex items-start gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<Textarea
					aria-label="Give direction"
					className="min-h-9"
					rows={1}
					maxLength={DIRECTION_CHARS}
					disabled={brainOff}
					placeholder={
						brainOff
							? "Turn the brain on to give direction"
							: "Give direction in one sentence"
					}
					value={text}
					onChange={(e) => {
						key.current = null;
						setText(e.target.value);
					}}
					onKeyDown={(e) => {
						// Enter during IME composition confirms the conversion.
						if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
						e.preventDefault();
						submit();
					}}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={blank || brainOff || give.isPending}
				>
					Send
				</Button>
			</form>
			{directions.data?.length ? (
				<ol
					aria-label="Directions"
					className="m-0 flex list-none flex-col gap-1 p-0"
					style={{ fontSize: "var(--mfw-text-xs)" }}
				>
					{directions.data.slice(0, 5).map((d) => {
						const badge = directionBadge(d.status, d.received);
						return (
							<li key={d.id} className="flex flex-wrap items-center gap-2">
								<Chip tone={badge.tone}>{badge.label}</Chip>
								<span className="min-w-0 break-words">{d.text}</span>
								{d.status === "held" ? (
									<AppLink to={`${href.project(project)}#needs-you`}>
										Decide
									</AppLink>
								) : null}
								{d.taskIds.slice(0, 3).map((id) => (
									<AppLink
										key={id}
										to={href.board(project, { node: nodeRef.task(id) })}
									>
										{id}
									</AppLink>
								))}
								{d.taskIds.length > 3 ? (
									<span style={{ color: "var(--mfw-fg-faint)" }}>
										+{d.taskIds.length - 3}
									</span>
								) : null}
							</li>
						);
					})}
				</ol>
			) : null}
		</div>
	);
}
