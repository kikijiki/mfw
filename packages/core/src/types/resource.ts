/**
 * Resource model: a project declares the scarce things its tasks contend for
 * (a local GPU, a paid pod pool, an API seat). The scheduler gates tasks on
 * acquiring the relevant resource lock. `fixed` resources always exist;
 * `dynamic` ones are provisioned/torn-down on demand per `policy`.
 */
export interface ResourcePolicy {
	grace_period_seconds?: number;
	/** Command run to tear down a dynamic resource. Template vars: {resource_id} {metadata}. */
	cleanup_command?: string | null;
	reuse_existing?: boolean;
	max_idle?: number;
}

export interface ResourceConfig {
	id: string;
	name: string;
	type: "fixed" | "dynamic";
	cost: "free" | "paid";
	max_concurrent?: number; // default 1
	policy?: ResourcePolicy;
}
