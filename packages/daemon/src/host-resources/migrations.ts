export const HOST_SCHEMA_VERSION = 3;

/**
 * host.db has an independent schema and migration history. It must never use
 * the project migrations: those contain project-local resource semaphores and
 * are intentionally a different coordination domain.
 */
export const HOST_MIGRATIONS: readonly { version: number; sql: string }[] = [
	{
		version: 1,
		sql: `
CREATE TABLE host_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  host_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  kernel_boot_id TEXT,
  process_boot_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  next_fence INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  attached INTEGER NOT NULL DEFAULT 0 CHECK (attached IN (0, 1)),
  last_attached_at INTEGER,
  last_detached_at INTEGER,
  last_process_boot_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE resource_definitions (
  id TEXT PRIMARY KEY,
  accounting TEXT NOT NULL CHECK (accounting IN ('slot', 'quantity')),
  provisioning TEXT NOT NULL CHECK (provisioning IN ('static', 'dynamic')),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  observation_kind TEXT,
  ignore_observation INTEGER NOT NULL DEFAULT 0 CHECK (ignore_observation IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE resource_bindings (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resource_definitions(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(resource_id, stable_key)
);

CREATE TABLE waiters (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'granted', 'cancelled')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_waiters_fifo ON waiters(state, sequence);
CREATE INDEX ix_waiters_project ON waiters(project_id, state, sequence);

CREATE TABLE waiter_requirements (
  waiter_id TEXT NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resource_definitions(id),
  binding_id TEXT REFERENCES resource_bindings(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY(waiter_id, resource_id)
);
CREATE INDEX ix_waiter_requirements_resource ON waiter_requirements(resource_id, waiter_id);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  waiter_id TEXT NOT NULL UNIQUE REFERENCES waiters(id),
  project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional','active','uncertain','releasing','released','reclaimed','force_released')),
  fence INTEGER NOT NULL UNIQUE CHECK (fence > 0),
  run_id TEXT,
  run_dir TEXT,
  session_id TEXT,
  pid INTEGER,
  process_start_time TEXT,
  kernel_boot_id TEXT,
  owner_process_boot_id TEXT,
  granted_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_renewed_at INTEGER,
  expires_at INTEGER,
  release_reason TEXT,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_leases_state ON leases(state, granted_at);
CREATE INDEX ix_leases_project ON leases(project_id, state);
CREATE INDEX ix_leases_run ON leases(run_id);

CREATE TABLE lease_allocations (
  lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resource_definitions(id),
  binding_id TEXT REFERENCES resource_bindings(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY(lease_id, resource_id)
);
CREATE INDEX ix_allocations_resource ON lease_allocations(resource_id, lease_id);

CREATE TABLE observation_health (
  kind TEXT PRIMARY KEY,
  result TEXT NOT NULL CHECK (result IN ('ok','degraded','error','unsupported')),
  checked_at INTEGER NOT NULL,
  process_boot_id TEXT NOT NULL,
  kernel_boot_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE observations (
  binding_id TEXT PRIMARY KEY REFERENCES resource_bindings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  result TEXT NOT NULL CHECK (result IN ('ok','degraded','error','unsupported')),
  observed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  process_boot_id TEXT NOT NULL,
  kernel_boot_id TEXT,
  adapter_version TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  occupants_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  project_id TEXT,
  waiter_id TEXT,
  lease_id TEXT,
  fence INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_audit_time ON audit(at_ms, seq);
CREATE INDEX ix_audit_lease ON audit(lease_id, seq);

CREATE TABLE host_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`,
	},
	{
		version: 2,
		sql: `
ALTER TABLE resource_definitions ADD COLUMN quantity_unit TEXT
  CHECK (quantity_unit IS NULL OR quantity_unit IN ('integer','bytes'));
ALTER TABLE resource_definitions ADD COLUMN safety_headroom INTEGER
  CHECK (safety_headroom IS NULL OR safety_headroom >= 0);

CREATE TABLE host_incidents (
  incident_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ram-low-headroom')),
  resource_id TEXT NOT NULL REFERENCES resource_definitions(id),
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  context_json TEXT NOT NULL
);
CREATE INDEX ix_host_incidents_state ON host_incidents(state, updated_at);
`,
	},
	{
		version: 3,
		sql: `
ALTER TABLE resource_definitions ADD COLUMN cpu_pressure_json TEXT;
ALTER TABLE leases ADD COLUMN process_tree_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE host_incidents RENAME TO host_incidents_v2;
DROP INDEX ix_host_incidents_state;
CREATE TABLE host_incidents (
  incident_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ram-low-headroom','gpu-occupancy-conflict','cpu-pressure')),
  resource_id TEXT NOT NULL REFERENCES resource_definitions(id),
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  context_json TEXT NOT NULL
);
INSERT INTO host_incidents SELECT * FROM host_incidents_v2;
DROP TABLE host_incidents_v2;
CREATE INDEX ix_host_incidents_state ON host_incidents(state, updated_at);

CREATE TABLE host_resource_holds (
  resource_id TEXT PRIMARY KEY REFERENCES resource_definitions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  reason TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot_generation INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  diagnostic_json TEXT NOT NULL
);
CREATE INDEX ix_host_resource_holds_state ON host_resource_holds(state, updated_at);
`,
	},
];

export const REQUIRED_HOST_TABLES = [
	"host_meta",
	"projects",
	"resource_definitions",
	"resource_bindings",
	"waiters",
	"waiter_requirements",
	"leases",
	"lease_allocations",
	"observation_health",
	"observations",
	"host_incidents",
	"host_resource_holds",
	"audit",
	"host_schema_migrations",
] as const;

/** Minimum shape checked even when user_version claims to be current. */
export const REQUIRED_HOST_COLUMNS: Readonly<
	Record<string, readonly string[]>
> = {
	host_meta: [
		"host_id",
		"coordinator_id",
		"kernel_boot_id",
		"process_boot_id",
		"generation",
		"next_fence",
	],
	projects: ["id", "root", "display_name", "attached", "last_process_boot_id"],
	resource_definitions: [
		"id",
		"accounting",
		"provisioning",
		"capacity",
		"enabled",
		"draining",
		"version",
		"quantity_unit",
		"safety_headroom",
		"cpu_pressure_json",
	],
	resource_bindings: ["id", "resource_id", "stable_key", "enabled", "version"],
	waiters: [
		"id",
		"request_key",
		"request_hash",
		"project_id",
		"sequence",
		"generation",
		"state",
	],
	waiter_requirements: ["waiter_id", "resource_id", "binding_id", "amount"],
	leases: [
		"id",
		"waiter_id",
		"project_id",
		"state",
		"fence",
		"run_id",
		"run_dir",
		"session_id",
		"pid",
		"process_start_time",
		"kernel_boot_id",
		"owner_process_boot_id",
		"expires_at",
		"process_tree_json",
	],
	lease_allocations: ["lease_id", "resource_id", "binding_id", "amount"],
	observation_health: [
		"kind",
		"result",
		"checked_at",
		"process_boot_id",
		"kernel_boot_id",
	],
	observations: [
		"binding_id",
		"kind",
		"sequence",
		"result",
		"observed_at",
		"process_boot_id",
		"kernel_boot_id",
	],
	host_incidents: [
		"incident_key",
		"kind",
		"resource_id",
		"state",
		"opened_at",
		"updated_at",
		"resolved_at",
		"context_json",
	],
	host_resource_holds: [
		"resource_id",
		"state",
		"reason",
		"fingerprint",
		"snapshot_generation",
		"opened_at",
		"updated_at",
		"resolved_at",
		"diagnostic_json",
	],
	audit: ["seq", "event_key", "at_ms", "action", "actor", "lease_id", "fence"],
	host_schema_migrations: ["version", "applied_at"],
};
