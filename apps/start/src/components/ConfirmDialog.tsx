import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * Confirmation for destructive actions (no `window.confirm` anywhere). The
 * destructive button stays disabled until the operator types the exact name of
 * the target, so it cannot be done by reflex.
 */
export interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	/** What will happen, in plain words. State consequences, not reassurance. */
	description: ReactNode;
	/** The exact string that must be typed. Omit for a plain (non-destructive) confirm. */
	confirmText?: string;
	confirmLabel?: string;
	/** Extra context: the list of things about to be affected, checks, etc. */
	children?: ReactNode;
	onConfirm: () => void | Promise<void>;
	/** True while the mutation is in flight; the dialog stays open and locked. */
	pending?: boolean;
	/** Additional form requirements which must be satisfied before confirming. */
	confirmDisabled?: boolean;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmText,
	confirmLabel = "Confirm",
	children,
	onConfirm,
	pending = false,
	confirmDisabled = false,
}: ConfirmDialogProps) {
	const [typed, setTyped] = useState("");
	const inputId = useId();

	// Reopening must never inherit the previous attempt's typed name.
	useEffect(() => {
		if (!open) setTyped("");
	}, [open]);

	const armed = confirmText === undefined || typed.trim() === confirmText;

	return (
		// Refuse to close while in flight, so the operator is never unsure whether the call landed.
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!pending) onOpenChange(next);
			}}
		>
			<DialogContent className="mfw-v2 sm:max-w-125">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<TriangleAlert
							aria-hidden
							className="size-4"
							style={{ color: "var(--mfw-critical)" }}
						/>
						{title}
					</DialogTitle>
					<DialogDescription asChild>
						<div style={{ color: "var(--mfw-fg-muted)" }}>{description}</div>
					</DialogDescription>
				</DialogHeader>

				{children}

				{confirmText === undefined ? null : (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={inputId}>
							Type <span className="mfw-num">{confirmText}</span> to confirm
						</Label>
						<Input
							id={inputId}
							value={typed}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setTyped(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && armed && !pending && !confirmDisabled)
									void onConfirm();
							}}
						/>
					</div>
				)}

				<DialogFooter>
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={!armed || pending || confirmDisabled}
						onClick={() => void onConfirm()}
					>
						{pending ? "Working…" : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
