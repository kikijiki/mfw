"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Switch({
	className,
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-3 focus-visible:ring-[var(--mfw-accent)]/50 disabled:cursor-not-allowed disabled:opacity-50",
				"data-[state=unchecked]:bg-[var(--mfw-border-strong)] data-[state=checked]:bg-[var(--mfw-ok)]",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-[var(--mfw-bg-raised)] shadow-[var(--mfw-shadow-raised)] transition-transform data-[state=checked]:translate-x-[18px]"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
