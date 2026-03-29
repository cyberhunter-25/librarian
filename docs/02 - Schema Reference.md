# Schema Reference

---

## Database Configuration

**Pragmas (set on every connection open):**

| Pragma | Value | Why |
|--------|-------|-----|
| `journal_mode` | `WAL` | Concurrent reads during writes |
| `synchronous` | `FULL` | No silent data loss on crash |
| `foreign_keys` | `ON` | SQLite doesn't enforce FK constraints by default |
| `busy_timeout` | `5000` | 5-second wait on contention instead of immediate failure |

**Transaction model:** `BEGIN IMMEDIATE` for all write operations. A regular `BEGIN` in SQLite starts as a deferred lock — two concurrent writers can both start transactions and then one deadlocks. `BEGIN IMMEDIATE` takes the write lock upfront so the second writer blocks cleanly.

---

## Tables

### `meta`

Workspace identity and schema versioning. One row per key.

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | `workspace_id`, `governed_memory_schema_version` |
| `value` | TEXT NOT NULL | |

- `governed_memory_schema_version` uses `INSERT OR REPLACE` — updates on schema bumps
- `workspace_id` uses `INSERT OR IGNORE` — immutable once set (one DB = one workspace)

---

### `memory_proposals`

Inbound write buffer. OpenClaw emits proposals here. Never written to `memories` directly.

| Column | Type | Default | Constraints |
|--------|------|---------|-------------|
| `id` | TEXT PK | | Internal row ID (UUID, used in FKs) |
| `proposal_id` | TEXT NOT NULL | | External business ID from OpenClaw (unique) |
| `agent_id` | TEXT NOT NULL | | Which agent proposed this |
| `session_key` | TEXT | | Required when `access_scope = 'session'` |
| `kind` | TEXT NOT NULL | | `task_state`, `episodic`, `project_fact`, `operating_policy`, `decision` |
| `subject_key` | TEXT NOT NULL | | What this memory is about |
| `canonical_key` | TEXT | | Required for singleton kinds |
| `access_scope` | TEXT NOT NULL | | `session`, `agent`, `workspace`, `tenant` |
| `proposed_text` | TEXT NOT NULL | | Human-readable memory content |
| `structured_payload` | TEXT | `'{}'` | JSON. Validated with `json_valid()` |
| `evidence` | TEXT | `'[]'` | JSON array. Validated with `json_valid()` |
| `source_type` | TEXT NOT NULL | | `agent_turn`, `document`, `observation`, `human_input` |
| `source_ref` | TEXT | | Thread ID, file path, URL |
| `dedupe_key` | TEXT | | Partial unique — prevents duplicate proposals on retry |
| `proposed_decay_at` | TEXT | | ISO-8601 UTC. Agent's suggested TTL. |
| `status` | TEXT NOT NULL | `'pending'` | `pending`, `accepted`, `rejected`, `needs_human`, `invalid` |
| `validator_errors` | TEXT | `'[]'` | JSON array of validation failures |
| `review_notes` | TEXT | | Human or librarian notes |
| `reviewed_by` | TEXT | | Who reviewed |
| `reviewed_at` | TEXT | | When reviewed (ISO-8601 UTC) |
| `created_at` | TEXT NOT NULL | `now()` | ISO-8601 UTC |

**CHECK constraints:**
- `kind` must be in allowed values
- `access_scope` must be in allowed values
- `proposal_id`, `agent_id`, `subject_key`, `proposed_text`, `source_type` must be non-empty (trimmed)
- Singleton kinds (`task_state`, `project_fact`, `operating_policy`) require non-empty `canonical_key`
- `session` scope requires non-empty `session_key`
- `structured_payload`, `evidence`, `validator_errors` must pass `json_valid()`

**Indexes:**
- `UNIQUE(proposal_id)` — business ID uniqueness
- `UNIQUE(dedupe_key) WHERE dedupe_key IS NOT NULL` — partial, idempotency
- `(status, created_at)` — pending proposal queue
- `(subject_key, kind, created_at)` — subject lookups

---

### `memories`

Canonical store. Only the accept transaction writes here.

| Column | Type | Default | Constraints |
|--------|------|---------|-------------|
| `id` | TEXT PK | | UUID |
| `agent_id` | TEXT NOT NULL | | |
| `session_key` | TEXT | | Required when `access_scope = 'session'` |
| `kind` | TEXT NOT NULL | | Same enum as proposals |
| `status` | TEXT NOT NULL | `'active'` | `active`, `superseded`, `archived`, `expired` |
| `subject_key` | TEXT NOT NULL | | |
| `canonical_key` | TEXT NOT NULL | | |
| `access_scope` | TEXT NOT NULL | | |
| `content` | TEXT NOT NULL | | |
| `structured_payload` | TEXT | `'{}'` | JSON |
| `evidence` | TEXT | `'[]'` | JSON array |
| `confidence` | REAL NOT NULL | `0.500` | Range: `0.0` to `1.0` |
| `source_proposal_id` | TEXT NOT NULL | | FK to `memory_proposals(id)` |
| `source_type` | TEXT NOT NULL | | |
| `source_ref` | TEXT | | |
| `created_by` | TEXT NOT NULL | | Which agent created the proposal |
| `accepted_by` | TEXT NOT NULL | | `librarian` or `human` |
| `policy_version` | TEXT NOT NULL | | Which validation rules were in effect |
| `valid_at` | TEXT NOT NULL | `now()` | When this memory became effective |
| `decay_at` | TEXT | | NULL = permanent. ISO-8601 UTC. |
| `supersedes_memory_id` | TEXT | | FK to `memories(id)` |
| `superseded_at` | TEXT | | Required when `status = 'superseded'` |
| `archived_at` | TEXT | | Required when `status = 'archived'` |
| `expired_at` | TEXT | | Required when `status = 'expired'` |
| `created_at` | TEXT NOT NULL | `now()` | |

**CHECK constraints:**
- Status-timestamp consistency: `superseded` requires `superseded_at`, `archived` requires `archived_at`, `expired` requires `expired_at`
- `session` scope requires `session_key`
- All required text fields must be non-empty (trimmed)
- `confidence` must be between 0.0 and 1.0
- JSON fields must pass `json_valid()`

**Indexes:**
- `UNIQUE(canonical_key) WHERE status = 'active' AND kind IN ('task_state', 'project_fact', 'operating_policy')` — **singleton enforcement** (the critical constraint)
- `(status, kind, created_at DESC)` — retrieval queries
- `(subject_key, status)` — subject lookups
- `(canonical_key, status)` — canonical lookups
- `(access_scope, status, decay_at, created_at DESC)` — scope-filtered retrieval with expiry
- `(source_proposal_id)` — FK lookups

---

### `memory_events`

Decision ledger. Append-only audit trail.

| Column | Type | Default | Constraints |
|--------|------|---------|-------------|
| `id` | INTEGER PK AUTOINCREMENT | | Monotonically increasing (even after deletes) |
| `proposal_id` | TEXT | | FK to `memory_proposals(id)` |
| `memory_id` | TEXT | | FK to `memories(id)` |
| `event_type` | TEXT NOT NULL | | `proposed`, `validated`, `accepted`, `rejected`, `needs_human`, `superseded`, `archived`, `expired` |
| `actor_type` | TEXT NOT NULL | | `agent`, `validator`, `librarian`, `human`, `system` |
| `actor_id` | TEXT NOT NULL | | |
| `details` | TEXT | `'{}'` | JSON |
| `created_at` | TEXT NOT NULL | `now()` | |

**Constraints:**
- At least one of `proposal_id` or `memory_id` must be non-null
- `actor_id` must be non-empty (trimmed)
- `event_type` and `actor_type` must be in allowed values
- `details` must pass `json_valid()`

**Indexes:**
- `(proposal_id, created_at)` — proposal event history
- `(memory_id, created_at)` — memory event history
- `(event_type, created_at)` — event type queries

---

## TTL Defaults (Enforced by Validator)

| Kind | Default `decay_at` | Rationale |
|------|-------------------|-----------|
| `task_state` | `now() + 7 days` | Task state is ephemeral; stale task state is actively harmful |
| `episodic` | `now() + 30 days` | Observations have diminishing relevance |
| `project_fact` | NULL (permanent) | Facts persist until superseded |
| `operating_policy` | NULL (permanent) | Policies persist until explicitly superseded by human |
| `decision` | NULL (permanent) | Decisions are the audit trail — never expire |

---

## Memory Lifecycle

```
active ──→ superseded  (new version accepted; superseded_at set)
active ──→ archived    (manually archived; archived_at set)
active ──→ expired     (TTL reached; expired_at set)
```

No hard deletes in v1. Deletion is a separate retention-policy step (v2+). Expired and archived memories are preserved for audit but excluded from retrieval.

---

## Scope Model

Access scopes from narrowest to broadest:

```
session < agent < workspace < tenant
```

When querying at a given scope, the retrieval broker returns memories at that scope and broader. For example, querying at `agent` scope returns `agent`, `workspace`, and `tenant` memories — but not `session` memories (unless a matching `session_key` is provided).

Session-scoped memories require a matching `session_key` for both writes and reads. This prevents cross-session information leakage.
