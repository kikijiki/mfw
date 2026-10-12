import { useQuery } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/lib/trpc";

import {
	type FolderSuggestion,
	joinPath,
	suggestFolders,
	validateFolderName,
} from "./addProject";
import { DirectoryBrowser } from "./DirectoryBrowser";

const RECENT_KEY = "mfw.addProject.recentBoardFolders";

/** Board folders used before on this device; storage may be unavailable. */
export function readRecentBoardFolders(): string[] {
	try {
		const raw = window.localStorage.getItem(RECENT_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === "string").slice(0, 5)
			: [];
	} catch {
		return [];
	}
}

export function rememberBoardFolder(path: string): void {
	try {
		const next = [path, ...readRecentBoardFolders().filter((p) => p !== path)];
		window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, 5)));
	} catch {
		// per-device convenience only
	}
}

const dirname = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * Pick the folder that holds the board: suggestions first (recent folders,
 * sibling folders, a new `<repo>-board`), then the browser, where a typed
 * folder NAME creates a new folder in the folder being viewed.
 */
export function FolderPicker({
	repo,
	onUse,
}: {
	repo: string;
	onUse: (path: string, create: boolean) => void;
}) {
	const trpc = useTRPC();
	const [path, setPath] = useState<string | undefined>(dirname(repo));
	const [name, setName] = useState("");
	const [touched, setTouched] = useState(false);
	const siblings = useQuery({
		...trpc.system.projectDirectory.queryOptions({ path: dirname(repo) }),
		staleTime: 10_000,
	});
	const recent = useMemo(() => readRecentBoardFolders(), []);
	const suggestions: FolderSuggestion[] = suggestFolders({
		repo,
		recent,
		siblings: siblings.data?.directories ?? [],
	});
	const nameError = validateFolderName(name);

	return (
		<div className="flex flex-col gap-3">
			<section aria-label="Suggested folders" className="flex flex-col gap-1">
				<h3
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					Suggested
				</h3>
				<ul className="flex flex-col gap-1">
					{suggestions.map((s) => (
						<li key={s.path}>
							<button
								type="button"
								className="mfw-focus flex min-h-11 w-full flex-col items-start justify-center border px-2 text-left md:min-h-9"
								style={{
									borderColor: "var(--mfw-border)",
									borderRadius: "var(--mfw-radius-sm)",
								}}
								onClick={() => onUse(s.path, s.create)}
							>
								<span className="truncate">
									{s.label}{" "}
									<span
										style={{
											color: "var(--mfw-fg-faint)",
											fontSize: "var(--mfw-text-2xs)",
										}}
									>
										{s.reason === "recent"
											? "used before"
											: s.create
												? "new folder"
												: "next to the repository"}
									</span>
								</span>
								<span
									className="mfw-num truncate"
									style={{
										color: "var(--mfw-fg-muted)",
										fontSize: "var(--mfw-text-2xs)",
									}}
								>
									{s.path}
								</span>
							</button>
						</li>
					))}
				</ul>
			</section>

			<DirectoryBrowser
				mode="folder"
				path={path}
				onPathChange={setPath}
				footer={(directory) => (
					<div className="flex flex-col gap-2">
						<form
							className="flex items-start gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								setTouched(true);
								if (nameError || !directory) return;
								// A name that already exists is that folder, not a new one.
								const existing = directory.directories.some(
									(entry) => entry.name === name.trim(),
								);
								onUse(joinPath(directory.path, name), !existing);
							}}
						>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Input
									aria-label="New folder name"
									aria-invalid={touched && nameError ? true : undefined}
									placeholder="New folder name (created here)"
									className="max-md:h-11"
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
								{touched && nameError ? (
									<span
										role="alert"
										style={{
											color: "var(--mfw-critical)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										{nameError}
									</span>
								) : null}
							</div>
							<Button
								type="submit"
								variant="outline"
								className="max-md:min-h-11"
								disabled={!directory}
							>
								<FolderPlus /> Create
							</Button>
						</form>
						<Button
							type="button"
							className="max-md:min-h-11"
							disabled={!directory}
							onClick={() => directory && onUse(directory.path, false)}
						>
							Use {directory ? directory.name || directory.path : "this folder"}
						</Button>
					</div>
				)}
			/>
		</div>
	);
}
