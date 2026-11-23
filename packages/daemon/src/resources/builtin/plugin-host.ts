import type {
	HostServices,
	Json,
	JsonObject,
	LogLevel,
} from "../../../../plugin-api/src/common.ts";
import type { Logger } from "../../log.ts";

/**
 * Host services for compiled-in plugins. Built-ins reach their providers
 * through injected clients, so the broker is refused here: nothing can use it
 * to make a credentialed call by accident.
 */
export function builtinPluginHost(
	log: Logger,
	now: () => number,
): HostServices {
	const state = new Map<string, Json>();
	return {
		log(level: LogLevel, message: string, fields?: JsonObject) {
			log[level](fields ?? {}, message);
		},
		state: {
			get: async (key) => state.get(key),
			set: async (key, value) => {
				state.set(key, value);
			},
			delete: async (key) => {
				state.delete(key);
			},
		},
		http: async () => {
			throw new Error("built-in plugins have no broker");
		},
		emit(type, data) {
			log.debug({ type, data }, "plugin event");
		},
		clock: { now },
	};
}
