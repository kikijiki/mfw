import { useEffect, useId, useState } from "react";

/**
 * One mermaid diagram, rendered in the browser. The library is a dynamic
 * `import()` inside an effect: it is large, only documents with a diagram pay
 * for it, and it needs a DOM (so it never enters the SSR graph). While it
 * loads, and whenever rendering fails, the diagram's source is shown instead
 * (with the error), so a page is never blank because a diagram is wrong.
 * `securityLevel: "strict"` makes mermaid sanitize labels and ignore click
 * handlers; the SVG is still only ever inserted into this block.
 */

type MermaidApi = typeof import("mermaid")["default"];

let loading: Promise<MermaidApi> | null = null;
const load = () => {
	loading ??= import("mermaid").then((m) => m.default);
	return loading;
};

/** True while the document paints dark (`data-theme` or the OS), re-evaluated on change. */
function useDark(): boolean {
	const [dark, setDark] = useState(false);
	useEffect(() => {
		const root = document.documentElement;
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const read = () => {
			const choice = root.getAttribute("data-theme");
			setDark(choice === "dark" || (choice === null && mq.matches));
		};
		read();
		const observer = new MutationObserver(read);
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		mq.addEventListener("change", read);
		return () => {
			observer.disconnect();
			mq.removeEventListener("change", read);
		};
	}, []);
	return dark;
}

export function Mermaid({ code }: { code: string }) {
	const dark = useDark();
	const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
	const [state, setState] = useState<
		{ svg: string } | { error: string } | null
	>(null);

	useEffect(() => {
		let cancelled = false;
		setState(null);
		load()
			.then(async (mermaid) => {
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: dark ? "dark" : "default",
					fontFamily: "inherit",
				});
				// Throws on a syntax error; `parse` first keeps mermaid from
				// drawing its own error bomb into the page.
				await mermaid.parse(code);
				const { svg } = await mermaid.render(`mmd-${uid}`, code);
				if (!cancelled) setState({ svg });
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [code, dark, uid]);

	if (state && "svg" in state) {
		return (
			<figure
				className="my-3 overflow-x-auto rounded border p-3"
				style={{ borderColor: "var(--mfw-border)" }}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's own sanitized SVG (securityLevel strict)
				dangerouslySetInnerHTML={{ __html: state.svg }}
			/>
		);
	}
	return (
		<figure className="my-3">
			{state && "error" in state ? (
				<figcaption
					className="mb-1"
					style={{
						color: "var(--mfw-warn)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					Diagram could not be rendered: {state.error.split("\n")[0]}
				</figcaption>
			) : null}
			<pre
				className="overflow-x-auto rounded border p-2.5 text-xs"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<code>{code}</code>
			</pre>
		</figure>
	);
}
