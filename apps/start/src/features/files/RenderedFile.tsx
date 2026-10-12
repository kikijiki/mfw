import { ImageOff } from "lucide-react";
import { useMemo, useState } from "react";

import { Empty } from "../../components/Empty";
import { href } from "../../routes";
import { DocMarkdown } from "../docs/DocMarkdown";
import {
	FILE_ASSET_BASE,
	type FileSource,
	fileAssetUrl,
	IMAGE_MAX_BYTES,
	markdownContext,
	parentDir,
} from "./fileKinds";

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * A markdown file as a document, at whichever tree is browsed. Relative links
 * and images resolve against the file's own directory in that same tree:
 * links open the target in this viewer, images stream through the read-only
 * image route (`?ref=` or `?run=` carried along, so a branch's README shows
 * that branch's pictures).
 */
export function MarkdownView({
	source,
	path,
	text,
}: {
	source: FileSource;
	path: string;
	text: string;
}) {
	const link = useMemo(() => markdownContext(path), [path]);
	const targets = useMemo(
		() => ({
			image: (key: string) => fileAssetUrl(FILE_ASSET_BASE(), source, key),
			link: (key: string, fragment?: string) =>
				`${href.files(source.project, {
					run: source.ref ? undefined : source.run,
					ref: source.ref,
					path: parentDir(key),
					file: key,
				})}${fragment ? `#${fragment}` : ""}`,
		}),
		[source],
	);
	return (
		<div className="min-h-0 flex-1 overflow-auto p-4">
			<div className="max-w-3xl">
				<DocMarkdown
					project={source.project}
					text={text}
					link={link}
					knownIds={NO_IDS}
					targets={targets}
				/>
			</div>
		</div>
	);
}

/**
 * An image file through `<img>`, always: an SVG is never inlined, so script in
 * it cannot run. Over the byte cap it is not fetched at all.
 */
export function ImageView({
	source,
	path,
	size,
}: {
	source: FileSource;
	path: string;
	size: number;
}) {
	const [failed, setFailed] = useState(false);
	if (size > IMAGE_MAX_BYTES) {
		return (
			<Empty
				icon={ImageOff}
				title="Image too large to display"
				description={`This image is ${size} bytes; the viewer shows images up to ${IMAGE_MAX_BYTES} bytes.`}
			/>
		);
	}
	if (failed) {
		return (
			<Empty
				icon={ImageOff}
				title="Could not load this image"
				description="The file may be corrupt, or not a format the browser can show."
			/>
		);
	}
	return (
		<div
			className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
			style={{ background: "var(--mfw-bg-subtle)" }}
		>
			<img
				src={fileAssetUrl(FILE_ASSET_BASE(), source, path)}
				alt={path}
				className="max-h-full max-w-full object-contain"
				onError={() => setFailed(true)}
			/>
		</div>
	);
}
