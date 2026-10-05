/**
 * URL of a task attachment's raw bytes (served by
 * `routes/api/attachments.$project.$taskId.$name.ts`). Derived from `BASE_URL`
 * the same way the tRPC endpoint is, so a sub-path deployment keeps working.
 */
export function attachmentUrl(
	project: string,
	taskId: string,
	name: string,
): string {
	const base = `${import.meta.env.BASE_URL}api/attachments`.replace(
		/\/{2,}/g,
		"/",
	);
	return `${base}/${[project, taskId, name].map(encodeURIComponent).join("/")}`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function isImageAttachment(name: string): boolean {
	return IMAGE_EXT.test(name);
}

export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
