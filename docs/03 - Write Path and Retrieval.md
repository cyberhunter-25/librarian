# Write Path and Retrieval

---

## Write Path Overview

The write path is the pipeline from OpenClaw emitting a memory proposal through to canonical memory creation. It has three stages: validation, submission, and acceptance.

```
OpenClaw emits proposal
         │
         ▼
┌─────────────────────┐
│ Deterministic        │──── invalid ──→ return errors (no DB write)
│ Validator            │
└─────────┬───────────┘
          │ valid
          ▼
┌─────────────────────┐
│ Idempotency Check   │──── duplicate ──→ return existing proposal_id
│ (dedupe_key)        │
└─────────┬───────────┘
          │ new
          ▼
┌─────────────────────┐
│ Compute TTL         │   task_state: +7d, episodic: +30d, others: permanent
│ Route Status        │   operating_policy → needs_human, others → pending
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ BEGIN IMMEDIATE      │   Insert proposal + write proposed/validated events
│ Transaction          │
└─────────┬───────────┘
          │
          ▼
    Proposal stored as pending/needs_human
          │
          ▼ (Librarian or Human reviews)
          │
    ┌─────┴─────┐
    │           │
  Accept      Reject
    │           │
    ▼           ▼
┌──────────┐ ┌──────────┐
│ BEGIN    │ │ BEGIN    │
│ IMMEDIATE│ │ IMMEDIATE│
│          │ │          │
│ Lock     │ │ Update   │
│ Supersede│ │ proposal │
│ Insert   │ │ Write    │
│ Update   │ │ event    │
│ Events   │ │          │
└────┬─────┘ └────┬─────┘
     │             │
     ▼             ▼
  Render        Render
  Projection    Projection
  (async)       (async)
```

---

## Stage 1: Deterministic Validation

`validateProposal()` is a pure function — no database access. It runs structural checks:

**Required fields:**
- `proposalId`, `agentId`, `subjectKey`, `proposedText`, `sourceType`

**Enum validation:**
- `kind` must be: `task_state`, `episodic`, `project_fact`, `operating_policy`, `decision`
- `accessScope` must be: `session`, `agent`, `workspace`, `tenant`
- `sourceType` must be: `agent_turn`, `document`, `observation`, `human_input`

**Conditional requirements:**
- Singleton kinds (`task_state`, `project_fact`, `operating_policy`) require `canonicalKey`
- `session` scope requires `sessionKey`

**Format validation:**
- `proposedDecayAt` must be valid ISO-8601 if present
- Each evidence item must have a non-empty `type`

Invalid proposals return typed `ValidationError[]` immediately without database writes.

---

## Stage 2: Proposal Submission

`submitProposal()` handles idempotency and initial insert:

1. Run `validateProposal()` — return `{ status: 'invalid', errors }` if it fails
2. Check `dedupe_key` against existing proposals — return `{ status: 'duplicate', existingProposalId }` if matched
3. Compute `decay_at` from defaults if not provided by the agent
4. Determine initial status: `operating_policy` → `needs_human`, everything else → `pending`
5. `BEGIN IMMEDIATE` transaction:
   - Insert into `memory_proposals`
   - Write `proposed` event (actor_type: `agent`)
   - Write `validated` event (actor_type: `validator`)

---

## Stage 3: Accept/Reject

### Accept (`acceptProposal`)

Runs inside a single `BEGIN IMMEDIATE` transaction:

1. Verify proposal exists and status is `pending` or `needs_human`
2. For singleton kinds, find existing active memory with same `canonical_key`
3. If found:
   - `UPDATE` old memory: `status = 'superseded'`, set `superseded_at`
   - Write `superseded` event with `{ superseded_by, reason: 'new_version_accepted' }`
4. `INSERT` new memory row as `active` with:
   - Content from proposal
   - `confidence` from librarian/human
   - `policy_version` from current schema version
   - `supersedes_memory_id` linking to old memory (if applicable)
5. `UPDATE` proposal: `status = 'accepted'`, set `reviewed_by`, `reviewed_at`
6. Write `accepted` event with `{ memory_id, confidence, superseded_memory_id? }`

**Atomicity guarantee:** If any step fails, the entire transaction rolls back. The partial unique index on `memories(canonical_key) WHERE status = 'active'` prevents two active singletons from ever existing.

### Reject (`rejectProposal`)

Runs inside `BEGIN IMMEDIATE`:

1. Verify proposal exists and status is `pending` or `needs_human`
2. `UPDATE` proposal: `status = 'rejected'`, set `review_notes`, `reviewed_by`, `reviewed_at`
3. Write `rejected` event

---

## Projection Wrappers

After the database transaction commits, the projection file is regenerated:

```typescript
acceptProposalAndProject(db, proposalRowId, workspaceDir, opts)
  1. acceptProposal(db, proposalRowId, opts)          // pure DB, synchronous
  2. if accepted: renderGovernedMemoryProjection(...)  // async filesystem
  3. return { ...acceptResult, projection: { attempted, changed, entryCount, error? } }
```

**Key properties:**
- Projection is a **post-commit side effect**, not inside the SQLite transaction
- If projection write fails, canonical data is preserved (tested explicitly)
- Skip-if-unchanged: comparing content before writing avoids unnecessary mtime churn
- Output path: `path.join(workspaceDir, 'memory/governed/MEMORY_CANONICAL.md')`

The projection file is **generated, not authored**. OpenClaw reads it but never writes to it. That is the governance boundary at the filesystem level.

### Projection Content

The projection renders active, non-expired memories grouped by kind in fixed order:

1. **Operating Policies** (most authoritative first)
2. **Project Facts**
3. **Decisions**
4. **Episodic Memory**
5. **Task State** (most ephemeral last)

Within each section, entries are sorted by `confidence DESC`, `created_at DESC`, with deterministic tie-breakers (`canonical_key ASC`, `id ASC`) for byte-identical output on the same data state.

Each entry includes:
- `canonical_key` (for reference-back)
- `confidence` (3 decimal places)
- `subject_key`, `access_scope`, `created_at` (for context)
- Memory content

---

## Safety Properties

| Property | Enforcement |
|----------|-------------|
| **Idempotency** | `dedupe_key` partial unique index on proposals |
| **Singleton guarantee** | Partial unique index on `(canonical_key) WHERE status='active' AND kind IN (...)` |
| **Atomicity** | All mutations in `BEGIN IMMEDIATE` transactions |
| **Audit trail** | Every state transition produces a `memory_events` row |
| **Policy gate** | `operating_policy` kind always starts as `needs_human` |
| **No direct writes** | `memories` table only written by `acceptProposal()` |
| **Projection isolation** | `MEMORY_CANONICAL.md` is generated, never authored by OpenClaw |

---

## Retrieval API

### `queryGovernedMemories(db, query)`

General-purpose retrieval. Deterministic SQL with:

- **Filter:** `status='active'`, not expired (`decay_at IS NULL OR decay_at > now`)
- **Scope:** queries at a given scope see that scope and broader (e.g., `agent` sees `agent`, `workspace`, `tenant`)
- **Session isolation:** session-scoped memories only returned with matching `sessionKey`; excluded entirely without one
- **Kind filter:** optional, restrict to specific memory types
- **Confidence filter:** optional minimum threshold
- **Ranking:** exact `canonical_key` match > `subject_key` match > recency
- **Cap:** default 5 results (configurable)

### `getActiveMemoryByCanonicalKey(db, canonicalKey)`

Direct singleton lookup. Returns the single active memory for a canonical key, or null. Excludes expired memories.

### `getMemoryHistory(db, canonicalKey)`

Returns full supersession chain for a canonical key, newest first. Includes all statuses (active, superseded, archived, expired). Useful for:
- Auditing how a fact evolved
- Investigating when a policy changed
- Debugging memory poisoning

---

## File Locations

### Standalone Service (live on Concierge at `/opt/governed-memory/`)

| File | Purpose |
|------|---------|
| `src/server.mjs` | HTTP server, routes, request handling |
| `src/schema.mjs` | SQLite DDL, pragmas, `BEGIN IMMEDIATE` helper |
| `src/writer.mjs` | Deterministic validator, submit, accept/reject |
| `src/retrieval.mjs` | Query, canonical key lookup, CTE-based history chain |
| `src/projection.mjs` | Deterministic Markdown renderer, skip-if-unchanged |
| `src/librarian.mjs` | Auto-accept with confidence tiers |

### Reference Implementation (OpenClaw repo, TypeScript, 84 tests)

| File | Purpose | Tests |
|------|---------|-------|
| `src/memory/governed-memory-schema.ts` | DDL, pragmas, `BEGIN IMMEDIATE` helper | 10 tests |
| `src/memory/governed-memory-writer.ts` | Validator, submit, accept/reject, projection wrappers | 27 tests |
| `src/memory/governed-memory-retrieval.ts` | Query, canonical key lookup, history chain | 16 tests |
| `src/memory/governed-memory-projection.ts` | Deterministic Markdown renderer | 4 tests |

### Integration Points (user-space, survive OpenClaw updates)

| File | Purpose |
|------|---------|
| `~/.openclaw/skills/governed-memory/SKILL.md` | Teaches OpenClaw to call the HTTP API |
| `~/.openclaw/workspace/memory/governed/MEMORY_CANONICAL.md` | Read-only projection, auto-indexed by `memory_search` |
| `/etc/systemd/system/governed-memory.service` | Systemd unit for the standalone service |
