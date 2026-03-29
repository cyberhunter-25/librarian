# Implementation Log

---

## 2026-03-28 — Project Inception and v1 Complete

### Design Phase

**Participants:** Dennis (CyberHunter), Claude (Anthropic), Codex (OpenAI)

The design emerged from a structured conversation:

1. **Dennis** identified the problem: OpenClaw on Concierge losing its memory, getting confused with stale information, no way to distinguish live-pull data from archived state. Proposed the agentic librarian concept with detailed governance requirements.

2. **Claude** reviewed the concept and recommended making the librarian a governance layer (not just storage), with specific mechanisms: proposal/validation gate, append-only supersession, retrieval gate pattern, risk mitigations for poisoning/contradiction/bloat.

3. **Dennis** tightened the design:
   - Don't hard-delete expired memories — expire/archive first
   - Don't merge duplicates on embedding similarity alone — use deterministic keys
   - Make `tenant_id` a hard partition key, not metadata
   - Add idempotency (`proposal_id` + `dedupe_key`)
   - Add provenance fields from day one
   - Separate facts from policies (policies require human approval)
   - Scoped v1 to: proposals table, validator, librarian flow, memories table, simple retrieval

4. **Codex** inspected the OpenClaw codebase and recommended SQLite over Supabase (existing pattern match, no network dependency, hard file isolation). One DB per workspace with workspace identity in metadata.

5. **Dennis** confirmed: no Supabase, local SQLite on Concierge.

### Schema Implementation (Codex)

Codex explored the OpenClaw repo, found existing SQLite patterns in `src/memory/`, and built:

- `governed-memory-schema.ts`:
  - `openGovernedMemoryDatabase()` — SQLite pragmas (WAL, FULL sync, FK, busy_timeout)
  - `ensureGovernedMemorySchema()` — DDL for `meta`, `memory_proposals`, `memories`, `memory_events`
  - `withGovernedMemoryImmediateTransaction()` — `BEGIN IMMEDIATE` helper with rollback
  - Type exports for all enums

- `governed-memory-schema.test.ts`:
  - Pragma verification
  - Table creation + workspace metadata
  - Singleton enforcement with supersession flow
  - Transaction rollback atomics

- Exported new helpers from `src/memory/index.ts`

### Code Review (Claude)

Claude reviewed Codex's schema implementation and identified three issues:

1. **`setMetaValue` uses `INSERT OR IGNORE` for schema version** — means version bumps are silently ignored. Fix: use `INSERT OR REPLACE` for `governed_memory_schema_version`, keep `INSERT OR IGNORE` for `workspace_id`.

2. **`mkdirSync` catch swallows all errors** — empty `catch {}` hides permission errors, disk full, etc. Fix: remove try/catch since `recursive: true` handles existing dirs.

3. **Missing index on `memories(source_proposal_id)`** — needed for FK lookups and audit queries.

### Schema Fixes (Claude)

- Split `setMetaValue` into `upsertMetaValue` (INSERT OR REPLACE) and `setMetaValueIfAbsent` (INSERT OR IGNORE)
- Removed swallowed try/catch on mkdirSync
- Added `idx_memories_source_proposal_id` index

### Additional Tests (Claude)

Added 6 tests to `governed-memory-schema.test.ts`:
- `dedupe_key` idempotency (duplicate throws)
- Invalid `kind` rejection
- Empty required fields rejection (whitespace-only `subject_key`)
- Session scope without `session_key` rejection
- Singleton kind without `canonical_key` rejection
- Meta version update + workspace_id immutability

### Validator + Write Path (Claude)

Built `governed-memory-writer.ts`:

**Validator (`validateProposal`):**
- Pure function, no DB access
- Required fields, enum validation, conditional requirements, ISO-8601 format, evidence structure
- Returns typed `ValidationError[]`

**Writer:**
- `submitProposal()` — validates, checks dedupe_key, computes default TTL, inserts proposal + events in `BEGIN IMMEDIATE`
- `acceptProposal()` — loads proposal, supersedes existing singleton, inserts canonical memory, updates proposal, writes events — all in one transaction
- `rejectProposal()` — updates proposal status, writes event, in one transaction
- `operating_policy` proposals always route to `needs_human` status
- Default TTLs: task_state 7d, episodic 30d, others permanent

Built `governed-memory-writer.test.ts` with 19 tests covering validation, submission, accept flow, and reject flow.

### Retrieval (Claude)

Built `governed-memory-retrieval.ts`:

- `queryGovernedMemories()` — deterministic SQL, filters active + not expired, scope-constrained, ranked by canonical_key > subject_key > recency, default limit 5
- `getActiveMemoryByCanonicalKey()` — direct singleton lookup
- `getMemoryHistory()` — full supersession chain, newest first
- Scope model: queries at a given scope return that scope and broader; session-scoped requires matching sessionKey

Built `governed-memory-retrieval.test.ts` with 11 tests.

### Projection Layer (Codex)

Codex built `governed-memory-projection.ts`:

- `listGovernedMemoryProjectionRecords()` — SQL query for active, unexpired memories, ordered by kind (operating_policy first, task_state last), then confidence DESC, with deterministic tie-breakers
- `buildGovernedMemoryProjectionContent()` — renders grouped Markdown with metadata per entry
- `renderGovernedMemoryProjection()` — writes to file, skip-if-unchanged for idempotency
- "Do not edit" banner in generated output

Built `governed-memory-projection.test.ts` with 4 tests.

### Mutation + Projection Wrappers (Codex)

Added to `governed-memory-writer.ts`:

- `acceptProposalAndProject()` — calls acceptProposal, renders projection on success
- `rejectProposalAndProject()` — calls rejectProposal, renders projection on success
- Projection is post-commit side effect (not inside SQLite transaction)
- Projection failure does not roll back canonical data (tested explicitly)
- Added `ProjectionRefreshResult`, `AcceptAndProjectResult`, `RejectAndProjectResult` types

Added 4 wrapper tests. Codex ran full suite: **4 files, 57 tests passing**.

### Obsidian Documentation (Claude)

Created project documentation in `Documents/Obsidian_Vault/Claude Projects/Librarian/`:
- `00 - Project Overview.md`
- `01 - Design Rationale and Risk Analysis.md`
- `02 - Schema Reference.md`
- `03 - Write Path and Retrieval.md`
- `04 - Implementation Log.md` (this file)

---

## 2026-03-28 — Runtime Integration (Codex)

Codex wired the governed memory data layer into the OpenClaw runtime:

- `governed-memory-db.ts` — workspace-scoped DB lifecycle helpers
- `governed-memory-librarian.ts` — v1 auto-accept with confidence tiers (0.65 for project_fact, 0.80 for others)
- `memory_propose` tool in `memory-tool.ts` — registered across tool catalog, policy, gateway, runtime, extensions, system prompt
- Governed DB initialized at workspace creation in `ensureAgentWorkspace()`
- Projection auto-indexed by existing `MemoryIndexManager` file watcher
- Fixed two bugs: tool handler return type, history ordering (now CTE-based)
- **7 test files, 84 tests passing**

---

## 2026-03-28 — Standalone Service Refactor (Claude)

### The Problem

The patched-OpenClaw integration meant every `npm i -g openclaw@latest` would overwrite all governed memory code. 24 patched files across the OpenClaw source. Fragile, non-portable, and not what the design called for — the Librarian should have been an API, not embedded code.

### The Fix

Refactored to a **standalone HTTP service** with zero OpenClaw source dependencies:

1. **Built** `/opt/governed-memory/` — 6 plain `.mjs` files, zero npm dependencies, Node.js built-in SQLite
2. **Restored** stock OpenClaw `2026.3.22` on Concierge (reinstalled from npm)
3. **Deployed** the service as `governed-memory.service` (systemd, port 9700, loopback)
4. **Created** skill at `~/.openclaw/skills/governed-memory/SKILL.md` — teaches OpenClaw to call the API
5. **Verified** end-to-end: propose → auto-accept → projection → searchable via stock `memory_search`

### What's on Concierge Now

| Component | Location | Survives Updates |
|-----------|----------|-----------------|
| Service | `/opt/governed-memory/` (systemd) | Yes |
| Database | `~/.openclaw/state/governed-memory/concierge.sqlite` | Yes |
| Projection | `~/.openclaw/workspace/memory/governed/MEMORY_CANONICAL.md` | Yes |
| Skill | `~/.openclaw/skills/governed-memory/SKILL.md` | Yes |
| OpenClaw | Stock `2026.3.22`, zero patches | Updates freely |

---

## What's Next

### v2 — Intelligence Layer (Deferred)

These require real proposal traffic to be useful:

- Semantic deduplication (embedding similarity for clustering, deterministic keys for canonicalization)
- Contradiction auto-resolution
- Smart compaction (merge duplicates, archive stale state, promote stable facts to semantic memory)
- Embedding-based search
- Dynamic threshold learning from rejection history
- Auditor agent (samples actions to verify correct memory usage)
- `needs_human` notification surface for operating policies
- Session-memory hook integration (route `/new`, `/reset` summaries through governance)
