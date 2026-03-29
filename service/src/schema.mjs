import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const KINDS = ["task_state", "episodic", "project_fact", "operating_policy", "decision"];
const SINGLETON_KINDS = ["task_state", "project_fact", "operating_policy"];
const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "needs_human", "invalid"];
const MEMORY_STATUSES = ["active", "superseded", "archived", "expired"];
const ACCESS_SCOPES = ["session", "agent", "workspace", "tenant"];
const EVENT_TYPES = ["proposed", "validated", "accepted", "rejected", "needs_human", "superseded", "archived", "expired"];
const ACTOR_TYPES = ["agent", "validator", "librarian", "human", "system"];

function sqlList(values) {
  return values.map((v) => `'${v}'`).join(", ");
}

function trimPresent(field) {
  return `${field} IS NOT NULL AND length(trim(${field})) > 0`;
}

export function openDatabase(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function ensureSchema(db, workspaceId) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_proposals (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      kind TEXT NOT NULL CHECK (kind IN (${sqlList(KINDS)})),
      subject_key TEXT NOT NULL,
      canonical_key TEXT,
      access_scope TEXT NOT NULL CHECK (access_scope IN (${sqlList(ACCESS_SCOPES)})),
      proposed_text TEXT NOT NULL,
      structured_payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structured_payload)),
      evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
      source_type TEXT NOT NULL,
      source_ref TEXT,
      dedupe_key TEXT,
      proposed_decay_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (${sqlList(PROPOSAL_STATUSES)})),
      validator_errors TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(validator_errors)),
      review_notes TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      CHECK (${trimPresent("proposal_id")}),
      CHECK (${trimPresent("agent_id")}),
      CHECK (${trimPresent("subject_key")}),
      CHECK (${trimPresent("proposed_text")}),
      CHECK (${trimPresent("source_type")}),
      CHECK (kind NOT IN (${sqlList(SINGLETON_KINDS)}) OR ${trimPresent("canonical_key")}),
      CHECK (access_scope != 'session' OR ${trimPresent("session_key")})
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      kind TEXT NOT NULL CHECK (kind IN (${sqlList(KINDS)})),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${sqlList(MEMORY_STATUSES)})),
      subject_key TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      access_scope TEXT NOT NULL CHECK (access_scope IN (${sqlList(ACCESS_SCOPES)})),
      content TEXT NOT NULL,
      structured_payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structured_payload)),
      evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
      confidence REAL NOT NULL DEFAULT 0.500 CHECK (confidence >= 0.0 AND confidence <= 1.0),
      source_proposal_id TEXT NOT NULL REFERENCES memory_proposals(id),
      source_type TEXT NOT NULL,
      source_ref TEXT,
      created_by TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      valid_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      decay_at TEXT,
      supersedes_memory_id TEXT REFERENCES memories(id),
      superseded_at TEXT,
      archived_at TEXT,
      expired_at TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      CHECK (${trimPresent("agent_id")}),
      CHECK (${trimPresent("subject_key")}),
      CHECK (${trimPresent("canonical_key")}),
      CHECK (${trimPresent("content")}),
      CHECK (${trimPresent("source_type")}),
      CHECK (${trimPresent("created_by")}),
      CHECK (${trimPresent("accepted_by")}),
      CHECK (${trimPresent("policy_version")}),
      CHECK (access_scope != 'session' OR ${trimPresent("session_key")}),
      CHECK (status != 'superseded' OR superseded_at IS NOT NULL),
      CHECK (status != 'archived' OR archived_at IS NOT NULL),
      CHECK (status != 'expired' OR expired_at IS NOT NULL)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT REFERENCES memory_proposals(id),
      memory_id TEXT REFERENCES memories(id),
      event_type TEXT NOT NULL CHECK (event_type IN (${sqlList(EVENT_TYPES)})),
      actor_type TEXT NOT NULL CHECK (actor_type IN (${sqlList(ACTOR_TYPES)})),
      actor_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
      created_at TEXT NOT NULL DEFAULT (${NOW_UTC}),
      CHECK (${trimPresent("actor_id")}),
      CHECK (proposal_id IS NOT NULL OR memory_id IS NOT NULL)
    )
  `);

  // Indexes
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_proposal_id ON memory_proposals(proposal_id)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_dedupe_key ON memory_proposals(dedupe_key) WHERE dedupe_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mp_status ON memory_proposals(status, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mp_subject ON memory_proposals(subject_key, kind, created_at)`);
  db.exec(`DROP INDEX IF EXISTS idx_mem_active_singleton`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_active_singleton ON memories(canonical_key, kind) WHERE status = 'active' AND kind IN (${sqlList(SINGLETON_KINDS)})`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_status_kind ON memories(status, kind, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(subject_key, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_canonical ON memories(canonical_key, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(access_scope, status, decay_at, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_proposal ON memories(source_proposal_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_evt_proposal ON memory_events(proposal_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_evt_memory ON memory_events(memory_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_evt_type ON memory_events(event_type, created_at)`);

  // Meta
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run("governed_memory_schema_version", String(SCHEMA_VERSION));
  if (workspaceId?.trim()) {
    db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run("workspace_id", workspaceId.trim());
    // Verify the DB belongs to the configured workspace — fail closed on mismatch
    const existing = db.prepare(`SELECT value FROM meta WHERE key = 'workspace_id'`).get();
    if (existing && existing.value !== workspaceId.trim()) {
      throw new Error(
        `Workspace identity mismatch: DB has '${existing.value}' but service configured with '${workspaceId.trim()}'. ` +
        `Refusing to start — check LIBRARIAN_DB_PATH.`
      );
    }
  }
}

export function immediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = fn();
    db.exec("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    if (!committed) { try { db.exec("ROLLBACK"); } catch {} }
    throw err;
  }
}
