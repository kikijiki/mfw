import { z } from "zod";

/**
 * A model id goes on an agent CLI's command line as the value of `--model`. One
 * that starts with `-` would be read as an option, and removing it as one would
 * make `--model` swallow the next argument, such as the tool denylist.
 */
export const MODEL_ID_PROBLEM =
	"a model id cannot start with '-': it would be read as a command-line option";

export const isModelId = (value: string): boolean => !/^\s*-/.test(value);

export function assertModelId(value: string): void {
	if (!isModelId(value)) throw new Error(MODEL_ID_PROBLEM);
}

/** A non-empty model id, for every config, API and task input. */
export const ModelId = z.string().min(1).refine(isModelId, MODEL_ID_PROBLEM);

/** The project's stored model, where an empty string means "not set". */
export const OptionalModelId = z.string().refine(isModelId, MODEL_ID_PROBLEM);
