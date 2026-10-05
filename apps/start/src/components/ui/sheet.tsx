import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A panel anchored to the right edge, full height, the `dialog` primitive
 * built on for a task, not centered content. Same Radix root (focus trap,
 * Esc-to-close, restores focus to whatever had it on open), different
 * placement and motion.
 *
 * Only the right side exists here: nothing in this app opens a sheet from any
 * other edge, so the other three are not built until something needs them.
 */

function Sheet({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetPortal({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
	return <DialogPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			data-slot="sheet-overlay"
			className={cn(
				"fixed inset-0 z-50 bg-black/20 duration-200 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none motion-reduce:transition-none",
				className,
			)}
			{...props}
		/>
	);
}

function SheetContent({
	className,
	children,
	showCloseButton = true,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
	showCloseButton?: boolean;
}) {
	return (
		<SheetPortal>
			<SheetOverlay />
			<DialogPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed inset-y-0 right-0 z-50 flex h-dvh max-w-full flex-col overflow-hidden bg-popover text-popover-foreground shadow-lg outline-none ring-1 ring-foreground/10 duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right motion-reduce:animate-none motion-reduce:transition-none",
					className,
				)}
				{...props}
			>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close data-slot="sheet-close" asChild>
						<Button
							variant="ghost"
							className="absolute top-2 right-2 z-20"
							size="icon-sm"
						>
							<XIcon />
							<span className="sr-only">Close</span>
						</Button>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</SheetPortal>
	);
}

/** Radix requires an accessible name for `Content`; visually hidden because
 *  the panel's own heading already shows one on screen. */
function SheetTitle({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="sheet-title"
			className={cn("sr-only", className)}
			{...props}
		/>
	);
}

function SheetDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="sheet-description"
			className={cn("sr-only", className)}
			{...props}
		/>
	);
}

export {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetOverlay,
	SheetPortal,
	SheetTitle,
};
