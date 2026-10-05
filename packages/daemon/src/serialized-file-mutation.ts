import { resolve } from "node:path";

const QUEUES_KEY = Symbol.for("mfw.serializedFileMutationQueues");

type QueueHolder = { [QUEUES_KEY]?: Map<string, Promise<void>> };

/**
 * Serialize a whole-file mutation by its resolved path. The registry lives on
 * globalThis because production bundling may emit the same source module into
 * more than one chunk; module-local queues would then fail to coordinate them.
 *
 * Rejections never poison the tail, and idle keys are removed so one-off test
 * homes and credential paths do not accumulate for the life of the process.
 */
export function serializeFileMutation<T>(
	path: string,
	mutation: () => Promise<T>,
): Promise<T> {
	const holder = globalThis as unknown as QueueHolder;
	if (!holder[QUEUES_KEY]) holder[QUEUES_KEY] = new Map();
	const queues = holder[QUEUES_KEY];
	const key = resolve(path);
	const previous = queues.get(key) ?? Promise.resolve();
	const operation = previous.then(mutation, mutation);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, tail);
	void tail.then(() => {
		if (queues.get(key) === tail) queues.delete(key);
	});
	return operation;
}
