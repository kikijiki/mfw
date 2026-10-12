import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { describeKey } from "../lib/keyboard";
import { useIsMac } from "../lib/platform";

/**
 * A keyboard hint as a `<kbd>`: a binding key (`mod+k`, `g h`) in this
 * platform's words or symbols (command-key symbol on macOS, `Ctrl` elsewhere).
 * Server and first client render show the non-Mac words, then it resolves
 * after mount (`useIsMac`), so hydration never mismatches.
 */
export function ShortcutKbd({
	keys,
	spaced = false,
	bordered = true,
	className,
	style,
}: {
	keys: string;
	/** `Ctrl K` instead of `Ctrl+K` (a compact hint on a button). */
	spaced?: boolean;
	bordered?: boolean;
	className?: string;
	style?: CSSProperties;
}) {
	const mac = useIsMac();
	return (
		<kbd
			className={cn("mfw-num", bordered && "border px-1", className)}
			style={{
				...(bordered
					? {
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							fontSize: "var(--mfw-text-2xs)",
						}
					: {}),
				...style,
			}}
		>
			{describeKey(keys, mac, spaced)}
		</kbd>
	);
}
