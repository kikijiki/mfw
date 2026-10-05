import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useGo } from "../lib/nav";
import { withBase } from "../routes";

/**
 * An in-app link. Renders a real `<a href>` (middle-click, ⌘-click and copy
 * address work); a plain left click is handled by the router.
 */
export interface AppLinkProps
	extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
	to: string;
	children: ReactNode;
	replace?: boolean;
	/** Overrides where an unmodified left click navigates; `href` stays `to`. Used to open a task through a masked route that keeps the board mounted. */
	navigate?: () => void;
}

export function AppLink({
	to,
	children,
	className,
	replace,
	navigate,
	onClick,
	...rest
}: AppLinkProps) {
	const go = useGo();
	return (
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
}
