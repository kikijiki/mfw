import { CircleHelp } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { TooltipContent } from "./ui/tooltip";

/** Compact, keyboard-accessible help for context that should not crowd a form. */
export function HelpTip({
	children,
	label = "More information",
	className,
}: {
	children: ReactNode;
	label?: string;
	className?: string;
}) {
	return (
		<TooltipPrimitive.Provider delayDuration={400}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>
					<button
						type="button"
						aria-label={label}
						className={cn(
							"mfw-focus inline-flex size-5 shrink-0 items-center justify-center",
							className,
						)}
						style={{ color: "var(--mfw-fg-faint)" }}
					>
						<CircleHelp aria-hidden className="size-3.5" />
					</button>
				</TooltipPrimitive.Trigger>
				<TooltipContent side="top">{children}</TooltipContent>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}
