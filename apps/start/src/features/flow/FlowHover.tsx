import {
	type FocusEvent,
	type PointerEvent,
	type ReactNode,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import type { Tip } from "./TimelineCell";
import type { TimeScale } from "./timeScale";

/**
 * Pointer and focus feedback for the whole Flow lens, in one place:
 *
 * - a crosshair that follows the pointer down every row (a CSS variable on
 *   the lens root, read by each cell, so moving the pointer re-renders
 *   nothing) and a time readout in the axis;
 * - one hover card for whatever bar or mark is under the pointer or has
 *   keyboard focus (anything carrying `data-tip`), so a bar and a marker
 *   explain themselves the same way.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM:SS`, with the date when the window spans more than a day. */
export function readoutLabel(ms: number, spanMs: number): string {
	const d = new Date(ms);
	const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return spanMs > 24 * 3_600_000
		? `${d.getMonth() + 1}/${d.getDate()} ${t}`
		: t;
}

function parseTip(el: Element | null): Tip | null {
	const raw = el?.getAttribute("data-tip");
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Tip;
	} catch {
		return null;
	}
}

export function TipCard({ tip }: { tip: Tip }) {
	return (
		<div
			role="tooltip"
			data-flow-tip=""
			style={{
				background: "var(--mfw-bg-raised)",
				border: "1px solid var(--mfw-border-strong)",
				borderLeft: `3px solid var(${tip.token})`,
				borderRadius: "var(--mfw-radius-md)",
				boxShadow: "var(--mfw-shadow-overlay)",
				padding: "6px 8px",
				fontSize: "var(--mfw-text-xs)",
				color: "var(--mfw-fg)",
				maxWidth: 320,
			}}
		>
			<div style={{ fontWeight: 600 }}>{tip.title}</div>
			<div className="mfw-num" style={{ color: "var(--mfw-fg-muted)" }}>
				{tip.when}
				{tip.duration ? ` · ${tip.duration}` : ""}
			</div>
			{tip.text ? <div className="mt-0.5">{tip.text}</div> : null}
			{tip.who || tip.cost ? (
				<div style={{ color: "var(--mfw-fg-muted)" }}>
					{[tip.who, tip.cost].filter(Boolean).join(" · ")}
				</div>
			) : null}
		</div>
	);
}

export function HoverLayer({
	scale,
	children,
	className,
	attrs,
}: {
	scale: TimeScale;
	/** Extra attributes for the root (`data-*`). */
	attrs?: Record<string, string>;
	children: ReactNode;
	className?: string;
}) {
	const root = useRef<HTMLDivElement | null>(null);
	const card = useRef<HTMLDivElement | null>(null);
	const current = useRef<Element | null>(null);
	const [tip, setTip] = useState<{ tip: Tip; x: number; y: number } | null>(
		null,
	);

	const place = (x: number, y: number) => {
		const c = card.current;
		if (!c) return;
		const w = c.offsetWidth;
		const h = c.offsetHeight;
		const left = Math.max(4, Math.min(window.innerWidth - w - 4, x + 12));
		const top = y + 18 + h > window.innerHeight ? y - h - 12 : y + 18;
		c.style.left = `${left}px`;
		c.style.top = `${Math.max(4, top)}px`;
	};

	const clearCrosshair = () => {
		const r = root.current;
		if (!r) return;
		r.style.removeProperty("--flow-x");
		delete r.dataset.hovering;
	};

	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		if (e.pointerType === "touch") return;
		const target = e.target as Element;
		const r = root.current;
		const wrap = target.closest("[data-timeline-wrap]");
		if (r && wrap) {
			const rect = wrap.getBoundingClientRect();
			const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
			r.style.setProperty("--flow-x", `${x}px`);
			r.style.setProperty(
				"--flow-readout-x",
				`${Math.max(34, Math.min(rect.width - 34, x))}px`,
			);
			const label = r.querySelector("[data-time-readout]");
			if (label)
				label.textContent = readoutLabel(scale.at(x), scale.to - scale.from);
			r.dataset.hovering = "1";
		} else clearCrosshair();

		const el = target.closest("[data-tip]");
		if (el !== current.current) {
			current.current = el;
			const t = parseTip(el);
			setTip(t ? { tip: t, x: e.clientX, y: e.clientY } : null);
		} else place(e.clientX, e.clientY);
	};

	const onLeave = () => {
		clearCrosshair();
		current.current = null;
		setTip(null);
	};

	const onFocus = (e: FocusEvent<HTMLDivElement>) => {
		const el = (e.target as Element).closest("[data-tip]");
		const t = parseTip(el);
		if (!el || !t) return;
		current.current = el;
		const r = el.getBoundingClientRect();
		setTip({ tip: t, x: r.left, y: r.bottom - 14 });
	};

	return (
		// Pure feedback: every interactive element inside keeps its own handlers.
		// biome-ignore lint/a11y/noStaticElementInteractions: see above
		<div
			ref={root}
			{...attrs}
			className={className}
			onPointerMove={onPointerMove}
			onPointerLeave={onLeave}
			onFocus={onFocus}
			onBlur={onLeave}
			// A click answers the question the card was asking (a cluster opens its list).
			onClickCapture={() => {
				current.current = null;
				setTip(null);
			}}
		>
			{children}
			{tip
				? createPortal(
						<div
							ref={(el) => {
								card.current = el;
								if (el) place(tip.x, tip.y);
							}}
							style={{
								position: "fixed",
								left: 0,
								top: 0,
								zIndex: 70,
								pointerEvents: "none",
							}}
						>
							<TipCard tip={tip.tip} />
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
