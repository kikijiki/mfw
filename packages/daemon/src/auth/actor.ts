import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The API token behind the current call, for audit rows written deep in the
 * daemon. Unset for owner sessions, the brain and background work.
 */
export interface TokenActor {
	kind: "token";
	id: string;
	name: string;
}

const KEY = Symbol.for("mfw.tokenActor");
type Holder = { [KEY]?: AsyncLocalStorage<TokenActor> };

/** On `globalThis`: the production bundle can emit this module more than once. */
function store(): AsyncLocalStorage<TokenActor> {
	const holder = globalThis as unknown as Holder;
	holder[KEY] ??= new AsyncLocalStorage<TokenActor>();
	return holder[KEY];
}

export function runAsTokenActor<T>(actor: TokenActor, run: () => T): T {
	return store().run(actor, run);
}

export function currentTokenActor(): TokenActor | undefined {
	return store().getStore();
}
