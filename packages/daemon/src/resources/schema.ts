/**
 * The resource core's tables inside host.db, with their own schema version:
 * a store refuses to open a version it does not know.
 */
export const RESOURCE_SCHEMA_VERSION = 4;

/**
 * Cleanup records: written before a machine is provisioned and closed only
 * when a later inventory proves the object is gone.
 */
export const RESOURCE_CLEANUP_SCHEMA = `
CREATE TABLE rp_cleanup (
  ownership_token TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES rp_leases(id),
  pool_id TEXT NOT NULL REFERENCES rp_pools(id),
  project_id TEXT NOT NULL,
  external_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','closed')),
  teardown_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX ix_rp_cleanup_open ON rp_cleanup(state, pool_id);
CREATE INDEX ix_rp_cleanup_lease ON rp_cleanup(lease_id, state);

CREATE TABLE rp_host_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  host_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rp_projects (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  attached INTEGER NOT NULL CHECK (attached IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_attached_at INTEGER NOT NULL,
  last_detached_at INTEGER
);

CREATE TABLE rp_host_definitions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL
);

CREATE TABLE rp_host_bindings (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES rp_host_definitions(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  binding_json TEXT NOT NULL
);
CREATE INDEX ix_rp_host_bindings_resource ON rp_host_bindings(resource_id);
`;

/**
 * Incidents: one row per condition key, so a condition that persists across
 * observations and restarts is one incident with one opening.
 */
export const RESOURCE_INCIDENT_SCHEMA = `
CREATE TABLE rp_incidents (
  incident_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ram-low-headroom','gpu-occupancy-conflict','cpu-pressure')),
  pool_id TEXT NOT NULL REFERENCES rp_pools(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  context_json TEXT NOT NULL
);
CREATE INDEX ix_rp_incidents_state ON rp_incidents(state, pool_id);
`;

/**
 * The latest probe evidence. It survives a restart so the operator can see
 * what was last known, and admission refuses it because its boot id is old.
 */
export const RESOURCE_PROBE_SCHEMA = `
CREATE TABLE rp_probe_health (
  kind TEXT PRIMARY KEY,
  result TEXT NOT NULL CHECK (result IN ('ok','degraded','error','unsupported')),
  checked_at INTEGER NOT NULL,
  process_boot_id TEXT NOT NULL,
  kernel_boot_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE rp_probe_samples (
  binding_id TEXT PRIMARY KEY,
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
`;

export const RESOURCE_SCHEMA = `
CREATE TABLE rp_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL,
  next_fence INTEGER NOT NULL DEFAULT 1,
  next_sequence INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rp_pools (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_hard_limit INTEGER NOT NULL DEFAULT 0 CHECK (provider_hard_limit IN (0, 1)),
  max_observation_age_ms INTEGER CHECK (max_observation_age_ms IS NULL OR max_observation_age_ms > 0),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rp_dimensions (
  pool_id TEXT NOT NULL REFERENCES rp_pools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slot','quantity','window','meter')),
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  spec_json TEXT NOT NULL,
  PRIMARY KEY (pool_id, name)
);

CREATE TABLE rp_quotas (
  pool_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  limit_amount INTEGER NOT NULL CHECK (limit_amount >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pool_id, dimension, scope, name),
  FOREIGN KEY (pool_id, dimension) REFERENCES rp_dimensions(pool_id, name) ON DELETE CASCADE
);

CREATE TABLE rp_holds (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES rp_pools(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('rate_limit','auth','budget','observation-stale','observation-failed','observation-uncertain','definition','draining','operator')),
  actor TEXT NOT NULL CHECK (actor IN ('owner','core','brain')),
  detail TEXT NOT NULL DEFAULT '',
  opened_at INTEGER NOT NULL,
  until INTEGER,
  cleared_at INTEGER,
  cleared_by TEXT
);
CREATE UNIQUE INDEX uq_rp_holds_open ON rp_holds(pool_id, reason) WHERE cleared_at IS NULL;

CREATE TABLE rp_observations (
  pool_id TEXT PRIMARY KEY REFERENCES rp_pools(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('ok','degraded','down','unknown')),
  dimensions_json TEXT NOT NULL,
  violations_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE rp_waiters (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  sequence INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('waiting','granted','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_rp_waiters_fifo ON rp_waiters(state, sequence);

CREATE TABLE rp_waiter_claims (
  waiter_id TEXT NOT NULL REFERENCES rp_waiters(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  unit TEXT,
  PRIMARY KEY (waiter_id, pool_id, dimension),
  FOREIGN KEY (pool_id, dimension) REFERENCES rp_dimensions(pool_id, name)
);

CREATE TABLE rp_leases (
  id TEXT PRIMARY KEY,
  waiter_id TEXT NOT NULL UNIQUE REFERENCES rp_waiters(id),
  project_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional','active','uncertain','releasing','released','reclaimed','force_released')),
  fence INTEGER NOT NULL UNIQUE CHECK (fence > 0),
  run_id TEXT,
  run_json TEXT,
  owner_boot_id TEXT,
  granted_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_renewed_at INTEGER,
  expires_at INTEGER,
  release_reason TEXT,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ix_rp_leases_state ON rp_leases(state, granted_at);

CREATE TABLE rp_allocations (
  lease_id TEXT NOT NULL REFERENCES rp_leases(id) ON DELETE CASCADE,
  pool_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  units_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (lease_id, pool_id, dimension),
  FOREIGN KEY (pool_id, dimension) REFERENCES rp_dimensions(pool_id, name)
);
CREATE INDEX ix_rp_allocations_pool ON rp_allocations(pool_id, dimension);

CREATE TABLE rp_ledger (
  id TEXT PRIMARY KEY,
  entry_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  lease_id TEXT REFERENCES rp_leases(id),
  scopes_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','settled','estimated','void')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reserved_amount INTEGER,
  at_ms INTEGER NOT NULL,
  FOREIGN KEY (pool_id, dimension) REFERENCES rp_dimensions(pool_id, name)
);
CREATE INDEX ix_rp_ledger_window ON rp_ledger(pool_id, dimension, state, at_ms);
CREATE INDEX ix_rp_ledger_project ON rp_ledger(project_id, at_ms);

CREATE TABLE rp_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  pool_id TEXT,
  lease_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO rp_schema(singleton, version) VALUES (1, ${RESOURCE_SCHEMA_VERSION});
`;
