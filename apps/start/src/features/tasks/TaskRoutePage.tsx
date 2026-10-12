import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useGo } from "../../lib/nav";
import { nodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";
import { useDockSide } from "../inspector/dock";
import { Inspector } from "../inspector/Inspector";

/**
 * `/p/$project/tasks/$taskId`, the canonical shareable task URL. Where the
 * inspector can dock beside the board (>= 1280px) this redirects to the board
 * with `?node=task:ID`, so the task opens next to the work it belongs to.
 * Narrower, it is the inspector as a full-width page: no dimmed sheet over a
 * backdrop board.
 */
export function TaskRoutePage({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const router = useRouter();
	const go = useGo();
	const side = useDockSide();
	const docked = side === "right" || side === "split";

	useEffect(() => {
		if (!docked) return;
		go(href.board(project, { node: nodeRef.task(taskId) }), { replace: true });
	}, [docked, go, project, taskId]);

	if (docked) return null;

	const close = () => {
		// Go back rather than to a fixed route; the fallback is for a cold load with no history.
		if (router.history.canGoBack()) router.history.back();
		else go(href.board(project), { replace: true });
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<Inspector
				key={`${project}:${taskId}`}
				project={project}
				nodeRef={nodeRef.task(taskId)}
				presentation="page"
				onClose={close}
			/>
		</div>
	);
}
