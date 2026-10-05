import { useState } from "react";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	activeBindings,
	describeKey,
	type KeyBinding,
	useKeyBindings,
} from "../lib/keyboard";

/**
 * The `?` cheat sheet.
 *
 * Generated from the registry rather than maintained by hand, so a shortcut
 * that exists is a shortcut that is documented, and one that was removed
 * stops being advertised on the same commit.
 */
export function KeyboardHelp() {
	const [open, setOpen] = useState(false);
	const [snapshot, setSnapshot] = useState<KeyBinding[]>([]);

	useKeyBindings([
		{
			key: "?",
			label: "Keyboard shortcuts",
			group: "Global",
			hidden: true,
			run: () => {
				// Snapshot on open: the registry is whatever is mounted right now,
				// and the dialog itself changes nothing about that.
				setSnapshot(activeBindings());
				setOpen(true);
			},
		},
	]);

	const groups = new Map<string, KeyBinding[]>();
	for (const binding of snapshot) {
		const key = binding.group ?? "Other";
		groups.set(key, [...(groups.get(key) ?? []), binding]);
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="mfw-v2 sm:max-w-125">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription asChild>
						<div style={{ color: "var(--mfw-fg-muted)" }}>
							What this screen answers to right now. Text fields swallow
							single-key shortcuts.
						</div>
					</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-100 flex-col gap-3 overflow-auto">
					{[...groups].map(([group, bindings]) => (
						<section key={group}>
							<h3
								className="mb-1 uppercase"
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-2xs)",
									letterSpacing: "0.06em",
								}}
							>
								{group}
							</h3>
							<ul className="flex flex-col gap-0.5">
								{bindings.map((binding) => (
									<li key={binding.key} className="flex items-baseline gap-2">
										<kbd
											className="mfw-num border px-1"
											style={{
												borderColor: "var(--mfw-border)",
												borderRadius: "var(--mfw-radius-sm)",
												fontSize: "var(--mfw-text-2xs)",
											}}
										>
											{describeKey(binding.key)}
										</kbd>
										<span>{binding.label}</span>
									</li>
								))}
							</ul>
						</section>
					))}
					{snapshot.length === 0 ? (
						<p style={{ color: "var(--mfw-fg-faint)" }}>
							This screen claims no shortcuts.
						</p>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
