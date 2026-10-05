/** Parse Git's raw `--name-status -z` output, retaining both sides of moves. */
export function parseDiffPaths(output: string): {
	code: string;
	oldPath: string;
	newPath: string;
}[] {
	const parts = output.split("\0");
	const changes: { code: string; oldPath: string; newPath: string }[] = [];
	for (let i = 0; i < parts.length && parts[i]; ) {
		const code = parts[i++];
		const oldPath = parts[i++];
		const newPath = /^[RC]/.test(code ?? "") ? parts[i++] : oldPath;
		if (!code || !oldPath || !newPath) {
			throw new Error("incomplete Git name-status output");
		}
		changes.push({ code, oldPath, newPath });
	}
	return changes;
}

export function affectedPaths(
	changes: ReturnType<typeof parseDiffPaths>,
): string[] {
	return [
		...new Set(changes.flatMap(({ oldPath, newPath }) => [oldPath, newPath])),
	];
}
