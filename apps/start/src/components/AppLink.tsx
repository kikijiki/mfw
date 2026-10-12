import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useGo } from "../lib/nav";
import { withBase } from "../routes";
import { Tip } from "./ui/tooltip";

/**
 * An in-app link. Renders a real `<a href>` (middle-click, modifier-click and copy
 * address work); a plain left click is handled by the router.
 */
export interface AppLinkProps
	extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
	to: string;
	children: ReactNode;
	replace?: boolean;
	/** Overrides where an unmodified left click navigates; `href` stays `to`. Used to open a task through a masked route that keeps the board mounted. */
	navigate?: () => void;
	/** Show `title` only while the link text is cut off (a truncated name). */
	clipped?: boolean;
}

export function AppLink({
	to,
	children,
	className,
	replace,
	navigate,
	onClick,
	title,
	clipped,
	...rest
}: AppLinkProps) {
	const go = useGo();
	const link = (
		<a
			{...rest}
			href={withBase(to)}
			className={cn("mfw-focus no-underline hover:underline", className)}
			onClick={(e) => {
				onClick?.(e);
				if (e.defaultPrevented) return;
				// Modified clicks belong to the browser (new tab, new window).
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
					return;
				e.preventDefault();
				if (navigate) navigate();
				else go(to, { replace });
			}}
		>
			{children}
		</a>
	);
	return (
		<Tip label={title} clipped={clipped ?? false}>
			{link}
		</Tip>
	);
}
