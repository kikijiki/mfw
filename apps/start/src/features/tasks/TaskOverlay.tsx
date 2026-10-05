import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "~/components/ui/sheet";
import { useGo } from "../../lib/nav";
import { href } from "../../routes";
import { TaskPage } from "./TaskPage";

/**
 * A task panel over whatever screen it was reached from. From the board,
 * `/p/$project/board/tasks/$taskId` keeps `BoardPage` mounted (masked as
 * `/p/$project/tasks/$taskId`, see `routeMasks`); otherwise the flat route
 * mounts its own backdrop board. This component is only the panel.
 */
export function TaskOverlay({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const router = useRouter();
	const go = useGo();
	useScrollLock();

	const close = () => {
		// Go back rather than to a fixed route; the fallback is for a cold load with no history.
		if (router.history.canGoBack()) router.history.back();
		else go(href.board(project), { replace: true });
	};

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<SheetContent className="w-full max-w-none lg:w-[90vw] lg:max-w-7xl">
				<SheetTitle>{taskId}</SheetTitle>
				<SheetDescription>
					Task detail for {taskId} in {project}.
				</SheetDescription>
				<div className="flex min-h-0 flex-1 flex-col">
					<TaskPage
						key={`${project}:${taskId}`}
						project={project}
						taskId={taskId}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}

/**
 * Locks the shell's scroll container (`<main data-scroll-root>`, not `body`,
 * which never scrolls) and pads for the vanished scrollbar to avoid a layout shift.
 */
function useScrollLock() {
	useEffect(() => {
		const main = document.querySelector<HTMLElement>("[data-scroll-root]");
		if (!main) return;
		const scrollbarWidth = main.offsetWidth - main.clientWidth;
		const prevOverflow = main.style.overflow;
		const prevPaddingRight = main.style.paddingRight;
		main.style.overflow = "hidden";
		if (scrollbarWidth > 0) main.style.paddingRight = `${scrollbarWidth}px`;
		return () => {
			main.style.overflow = prevOverflow;
			main.style.paddingRight = prevPaddingRight;
		};
	}, []);
}
