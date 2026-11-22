import { Check, Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Tip } from "~/components/ui/tooltip";
import { type ThemeChoice, useTheme } from "~/lib/theme";
import { cn } from "~/lib/utils";
import { THEMES, type ThemeMeta } from "./registry";
import { useThemeName } from "./useThemeName";

const MODES: readonly ThemeChoice[] = ["system", "light", "dark"];
const MENU_WIDTH = 300;
const EDGE = 8;

/** Two halves: the theme's light and dark paper, each with its ink and accent. */
function Swatch({ theme }: { theme: ThemeMeta }) {
	return (
		<span
			aria-hidden
			className="flex h-7 w-11 shrink-0 overflow-hidden border"
			style={{ borderColor: "var(--mfw-border-strong)" }}
		>
			{[theme.light, theme.dark].map((s) => (
				<span
					key={s.bg}
					className="flex flex-1 flex-col justify-end gap-0.5 p-0.5"
					style={{ background: s.bg }}
				>
					<span className="h-0.5 w-full" style={{ background: s.fg }} />
					<span className="h-1 w-2/3" style={{ background: s.accent }} />
				</span>
			))}
		</span>
	);
}

/** Opens above or below the trigger, whichever fits, and stays on screen. */
function placeMenu(trigger: DOMRect, height: number) {
	const left = Math.max(
		EDGE,
		Math.min(trigger.left, window.innerWidth - MENU_WIDTH - EDGE),
	);
	const below = trigger.bottom + 4;
	const top =
		below + height + EDGE <= window.innerHeight
			? below
			: Math.max(EDGE, trigger.top - height - 4);
	return { left, top };
}

export function ThemeSwitcher({ expanded = true }: { expanded?: boolean }) {
	const { name, setName } = useThemeName();
	const { theme: mode, setTheme: setMode } = useTheme();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ left: EDGE, top: EDGE });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const current = THEMES.find((t) => t.id === name) ?? THEMES[0];

	useEffect(() => {
		if (!open) return;
		const menu = menuRef.current;
		const trigger = triggerRef.current;
		if (menu && trigger) {
			setPosition(
				placeMenu(trigger.getBoundingClientRect(), menu.offsetHeight),
			);
			menu
				.querySelector<HTMLElement>(
					'[role="menuitemradio"][aria-checked="true"]',
				)
				?.focus();
		}
		const close = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (menu?.contains(target) || trigger?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);

	const onMenuKey = (event: React.KeyboardEvent) => {
		// Stop here so the app's global shortcuts do not also act on these keys.
		event.stopPropagation();
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>(
				'[role="menuitemradio"]',
			) ?? [],
		);
		const at = items.indexOf(document.activeElement as HTMLElement);
		const step = event.key === "ArrowDown" ? 1 : -1;
		items[(at + step + items.length) % items.length]?.focus();
	};

	const button = (
		<button
			ref={triggerRef}
			type="button"
			aria-label={`Theme: ${current.label}`}
			aria-haspopup="menu"
			aria-expanded={open}
			className={cn(
				"mfw-focus flex shrink-0 items-center gap-2 border-0 bg-transparent",
				expanded
					? "h-[var(--mfw-row-h)] w-full px-2 text-left"
					: "size-8 justify-center self-center",
			)}
			style={{
				borderRadius: "var(--mfw-radius-md)",
				color: "var(--mfw-fg-muted)",
			}}
			onClick={() => setOpen((v) => !v)}
		>
			<Palette aria-hidden className="size-4 shrink-0" />
			{expanded ? (
				<span className="min-w-0 flex-1 truncate">{current.label}</span>
			) : null}
		</button>
	);

	return (
		<>
			{expanded ? (
				button
			) : (
				<Tip label="Theme" side="right">
					{button}
				</Tip>
			)}
			{open
				? createPortal(
						// biome-ignore lint/a11y/noStaticElementInteractions: the key handler serves the menu items inside
						<div
							ref={menuRef}
							onKeyDown={onMenuKey}
							className="fixed z-[60] flex flex-col border p-1"
							style={{
								left: position.left,
								top: position.top,
								width: MENU_WIDTH,
								maxHeight: `calc(100dvh - ${EDGE * 2}px)`,
								overflowY: "auto",
								background: "var(--mfw-bg-raised)",
								borderColor: "var(--mfw-border-strong)",
								borderRadius: "var(--mfw-radius-md)",
								boxShadow: "var(--mfw-shadow-overlay)",
								color: "var(--mfw-fg)",
								fontFamily: "var(--mfw-font-ui)",
								fontSize: "var(--mfw-text-sm)",
							}}
						>
							<div role="menu" aria-label="Theme" className="flex flex-col">
								{THEMES.map((theme) => (
									<button
										key={theme.id}
										type="button"
										role="menuitemradio"
										aria-checked={theme.id === name}
										className="mfw-focus flex items-center gap-2 border-0 bg-transparent p-1.5 text-left hover:bg-[var(--mfw-bg-hover)]"
										style={{ borderRadius: "var(--mfw-radius-sm)" }}
										onClick={() => setName(theme.id)}
									>
										<Swatch theme={theme} />
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="font-medium">{theme.label}</span>
											<span
												style={{
													color: "var(--mfw-fg-muted)",
													fontSize: "var(--mfw-text-2xs)",
												}}
											>
												{theme.note}
											</span>
										</span>
										{theme.id === name ? (
											<Check aria-hidden className="size-4 shrink-0" />
										) : null}
									</button>
								))}
							</div>
							<div
								role="radiogroup"
								aria-label="Light or dark"
								className="mt-1 flex gap-1 border-t pt-1"
								style={{ borderColor: "var(--mfw-border)" }}
							>
								{MODES.map((m) => (
									// biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
									<button
										key={m}
										type="button"
										role="radio"
										aria-checked={mode === m}
										className="mfw-focus flex-1 border-0 px-2 py-1 capitalize"
										style={{
											borderRadius: "var(--mfw-radius-sm)",
											background:
												mode === m ? "var(--mfw-accent-subtle)" : "transparent",
											color:
												mode === m
													? "var(--mfw-accent)"
													: "var(--mfw-fg-muted)",
											fontSize: "var(--mfw-text-xs)",
										}}
										onClick={() => setMode(m)}
									>
										{m}
									</button>
								))}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
