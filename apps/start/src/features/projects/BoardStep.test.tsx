import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
	type AddState,
	type BoardTemplateInfo,
	describeInspection,
	type Inspection,
	summarize,
} from "./addProject";
import { BoardStep } from "./BoardStep";

const templates: BoardTemplateInfo[] = [
	{
		id: "mfw-default",
		title: "mfw default",
		description: "The full lifecycle",
		statuses: ["draft", "ready", "done"],
	},
	{
		id: "kanban",
		title: "Kanban",
		description: "Minimal columns",
		statuses: ["todo", "doing", "done"],
	},
];

const state: AddState = {
	repo: "/dev/app",
	board: { kind: "repo" },
	template: null,
};

function inspection(patch: Partial<Inspection>): Inspection {
	return {
		path: "/dev/app",
		exists: true,
		isGitRepo: true,
		location: "none",
		boardYaml: null,
		valid: false,
		error: null,
		key: null,
		types: [],
		statusRoles: null,
		statusMapError: null,
		...patch,
	};
}

function render(found: Inspection, current: AddState = state) {
	return renderToStaticMarkup(
		<BoardStep
			state={current}
			onChange={() => {}}
			folderPath={null}
			onPickFolder={() => {}}
			inspection={{ isLoading: false, error: null, refetch: () => {} }}
			view={describeInspection(found)}
			templates={{
				isLoading: false,
				error: null,
				refetch: () => {},
				data: templates,
			}}
			summary={summarize(current, found, templates)}
			error={null}
		/>,
	);
}

describe("BoardStep", () => {
	test("no board: offers the templates with their columns and the summary", () => {
		const html = render(inspection({}));
		expect(html).toContain("Inside this repository (default)");
		expect(html).toContain("Another folder…");
		expect(html).toContain("No board here yet");
		expect(html).toContain("Kanban");
		expect(html).toContain("1. todo");
		expect(html).toContain("When you press Add");
		expect(html).toContain("will be written");
	});

	test("an existing board: statuses with counts, and no template picker", () => {
		const html = render(
			inspection({
				location: "root",
				valid: true,
				types: [
					{
						name: "task",
						dir: "tasks",
						layout: "flat",
						documents: 2,
						statusField: "status",
						statuses: ["todo", "done"],
						statusCounts: { todo: 1, done: 1 },
					},
				],
				statusRoles: { todo: "ready", done: "done" },
			}),
		);
		expect(html).toContain("Existing board found");
		expect(html).toContain("2 tasks, flat layout");
		expect(html).toContain("todo");
		expect(html).not.toContain("Kanban");
	});

	test("an ambiguous folder is an alert and offers no template", () => {
		const html = render(inspection({ location: "ambiguous" }));
		expect(html).toContain('role="alert"');
		expect(html).toContain("Remove one and try again.");
		expect(html).not.toContain("Kanban");
	});
});
