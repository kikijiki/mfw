import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useTRPC } from "../../lib/trpc";
import {
	answerBadges,
	CHAT_CHARS,
	type ChatRow,
	chatRows,
	citationLink,
} from "./lead";

const POLL_MS = 2_000;
const SHOWN = 10;

/**
 * Ask the tech lead a question. Separate from giving direction: an answer
 * changes nothing. All text renders as plain React text, so markup in a task
 * title or a log line stays visible as characters.
 */
export function AskBrain({ project }: { project: string }) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const [text, setText] = useState("");
	const key = useRef<string | null>(null);
	const thread = useQuery(
		trpc.brain.chatThread.queryOptions(
			{ project },
			{
				refetchInterval: (q) =>
					((q.state.data as { pending: number } | undefined)?.pending ?? 0) > 0
						? POLL_MS
						: false,
			},
		),
	);
	const refresh = () =>
		void queryClient.invalidateQueries(
			trpc.brain.chatThread.queryFilter({ project }),
		);
	const ask = useMutation(
		trpc.brain.chatAsk.mutationOptions({
			meta: { label: "Ask the brain" },
			onSuccess: () => {
				key.current = null;
				setText("");
			},
			onSettled: refresh,
		}),
	);
	const direct = useMutation(
		trpc.brain.chatGiveDirection.mutationOptions({
			meta: { label: "Give as direction" },
			onSettled: () => {
				refresh();
				void queryClient.invalidateQueries(
					trpc.brain.directions.queryFilter({ project }),
				);
			},
		}),
	);

	const blank = text.trim() === "";
	const submit = () => {
		if (blank || ask.isPending) return;
		key.current ??= crypto.randomUUID();
		ask.mutate({ project, text, key: key.current });
	};
	const rows = chatRows(thread.data?.entries).slice(-SHOWN);

	return (
		<div className="flex flex-col gap-2" data-testid="ask-brain">
			{rows.length > 0 ? (
				<ol
					aria-label="Chat with the brain"
					className="m-0 flex max-h-80 list-none flex-col gap-3 overflow-y-auto p-0"
					style={{ fontSize: "var(--mfw-text-xs)" }}
				>
					{rows.map((row) => (
						<ChatExchange
							key={row.id}
							project={project}
							row={row}
							giving={direct.isPending}
							onGive={(answerId) => direct.mutate({ project, answerId })}
						/>
					))}
				</ol>
			) : null}
			<form
				className="flex items-start gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<Input
					aria-label="Ask the brain"
					maxLength={CHAT_CHARS}
					placeholder="Ask a question (changes nothing)"
					value={text}
					onChange={(e) => {
						key.current = null;
						setText(e.target.value);
					}}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={blank || ask.isPending}
				>
					Ask
				</Button>
			</form>
		</div>
	);
}

function ChatExchange({
	project,
	row,
	giving,
	onGive,
}: {
	project: string;
	row: ChatRow;
	giving: boolean;
	onGive: (answerId: string) => void;
}) {
	const { answer } = row;
	return (
		<li className="flex min-w-0 flex-col gap-1">
			<p className="m-0 break-words" style={{ color: "var(--mfw-fg-muted)" }}>
				{row.question}
			</p>
			{answer ? (
				<>
					<p
						data-testid="chat-answer"
						className="m-0 whitespace-pre-wrap break-words"
					>
						{answer.text}
					</p>
					<span className="flex flex-wrap items-center gap-2">
						{answerBadges(answer).map((b) => (
							<Chip key={b.label} tone={b.tone} title={b.title}>
								{b.label}
							</Chip>
						))}
						{answer.citations.map((c) => {
							const link = citationLink(project, c);
							return (
								<AppLink key={`${c.kind}:${c.id}`} to={link.to}>
									{link.label}
								</AppLink>
							);
						})}
						{answer.offer ? (
							row.directionGiven ? (
								<span style={{ color: "var(--mfw-fg-faint)" }}>
									given as a direction
								</span>
							) : (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={giving}
									onClick={() => onGive(answer.id)}
								>
									Give as direction
								</Button>
							)
						) : null}
					</span>
				</>
			) : (
				<span style={{ color: "var(--mfw-fg-faint)" }}>answering…</span>
			)}
		</li>
	);
}
