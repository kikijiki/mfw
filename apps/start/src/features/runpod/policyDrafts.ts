/** Provider values supported by the project placement contract. */
export { RUNPOD_CLOUDS, RUNPOD_CPU_FLAVORS } from "@mfw/core/runpod";

export function splitList(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[\n,]/)
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}

export function listText(value: readonly string[] | undefined): string {
	return value?.join("\n") ?? "";
}

export function toggleChoice(values: string[], value: string): string[] {
	return values.includes(value)
		? values.filter((item) => item !== value)
		: [...values, value];
}
