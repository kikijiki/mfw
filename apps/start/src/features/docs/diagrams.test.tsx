import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { DiagramPre, textOf } from "./DiagramPre";
import { Mermaid } from "./Mermaid";

/**
 * Server render only: effects do not run, which is exactly the state a diagram
 * is in before (or without) the mermaid chunk. The page must show the source,
 * never a blank block.
 */
describe("diagrams", () => {
	test("a diagram shows its source until it has rendered", () => {
		const html = renderToString(<Mermaid code={"graph TD\n  A --> B"} />);
		expect(html).toContain("graph TD");
		expect(html).toContain("A --&gt; B");
		expect(html).toContain("<pre");
	});

	test("a mermaid fence becomes a diagram, other fences stay code blocks", () => {
		const diagram = renderToString(
			<DiagramPre>
				<code className="language-mermaid">{"graph LR\n  X --> Y\n"}</code>
			</DiagramPre>,
		);
		expect(diagram).toContain("<figure");
		expect(diagram).toContain("X --&gt; Y");

		const code = renderToString(
			<DiagramPre>
				<code className="language-ts">{"const a = 1;\n"}</code>
			</DiagramPre>,
		);
		expect(code).not.toContain("<figure");
		expect(code).toContain("const a = 1;");
		expect(code).toContain("<pre");
	});

	test("the text of nested nodes is joined", () => {
		expect(
			textOf(
				<span>
					a<b>b</b>
					{["c", 4]}
				</span>,
			),
		).toBe("ab" + "c4");
		expect(textOf(null)).toBe("");
	});
});
