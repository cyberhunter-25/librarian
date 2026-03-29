# Design Rationale and Risk Analysis

---

## Why a Governance Layer (Not Just Storage)

OpenClaw's existing memory is file-backed Markdown plus semantic search. Any agent can write directly. This creates a contamination problem: bad summaries, hallucinated facts, and temporary assumptions become canonical "truth" with no way to distinguish them from validated information.

The Librarian separates the actor (OpenClaw) from the memory steward (Librarian). OpenClaw proposes memory events. The Librarian decides whether they become canonical memory, and if so, what type.

This is not a novel pattern. It mirrors:
- **Event sourcing** — facts are derived from an ordered log of events, not from mutable state
- **Write-ahead logs** — changes are validated and committed through a controlled pipeline
- **Editorial review** — the writer proposes, the editor decides what's published

---

## Why SQLite (Not Supabase)

The initial design considered Supabase/Postgres. The decision was changed to local SQLite:

| Factor | Supabase | SQLite |
|--------|----------|--------|
| **Network dependency** | Requires network to Supabase instance | None — Concierge is the sole consumer |
| **Tenant isolation** | Row-Level Security (policy-based, can be misconfigured) | **Physical file isolation** (one DB per workspace) |
| **Existing usage** | New dependency | OpenClaw already uses `node:sqlite` via `requireNodeSqlite()` |
| **ACID guarantees** | Full | Full (with WAL mode) |
| **Infrastructure** | Managed service | Zero — just a file |
| **Backup** | Supabase backup tooling | Copy the file |

**The decisive factor:** tenant isolation. With Supabase, cross-tenant access is prevented by RLS policies — one misconfigured policy and you leak data. With one SQLite file per workspace, cross-tenant access is physically impossible unless you open the wrong file. The isolation boundary moves from "query filter" to "filesystem path."

---

## Why One DB Per Workspace

- Cross-tenant access is **physically impossible** (wrong file = wrong DB)
- Workspace identity stored **once** in `meta` table, not repeated on every row
- Simpler backup story: **copy the file**
- DB lifecycle: created on first proposal, archived by moving to `archived/` subdirectory on workspace deletion

DB path convention: `~/.openclaw/state/governed-memory/<workspace-id>.sqlite`

---

## Key Design Decisions

### 1. Proposals, Not Direct Writes

OpenClaw emits proposals to `memory_proposals`. It never writes to `memories` directly. The Librarian validates, classifies, and either accepts or rejects. This is the governance boundary.

**Why:** If the actor writes its own canonical memory, every hallucination, misclassification, and temporary assumption becomes permanent truth with no review step.

### 2. Append-Only with Supersession

Never overwrite a memory. Always supersede. The old version is marked `superseded` with a timestamp; the new version links back via `supersedes_memory_id`.

**Why:** Overwriting destroys audit trail. With supersession, you can always reconstruct how a fact evolved over time, catch memory poisoning after the fact, and roll back if needed.

### 3. Policies Require Human Approval

`operating_policy` proposals always route to `needs_human` status regardless of content.

**Why:** Policies change how the system behaves. An LLM should never unilaterally promote something to policy status. A "fact" being wrong is recoverable — you supersede it. A "policy" being wrong changes system behavior with cascading effects.

### 4. Deterministic Retrieval (No LLM in Read Path)

Retrieval is pure SQL: filter by status/scope/expiry, rank by canonical_key > subject_key > recency, cap at 5 results.

**Why:** The read path must be fast, predictable, and scope-constrained. Putting an LLM in the retrieval path adds latency, token cost, and a hallucination surface on every memory access.

### 5. TTLs Enforced by Validator (Not LLM)

Default decay times are deterministic rules based on `kind`:
- `task_state`: 7 days
- `episodic`: 30 days
- Others: permanent

**Why:** Expiry decisions should never require LLM judgment. That's another hallucination surface. Deterministic rules handle the 80%; edge cases can be manually archived.

### 6. Idempotent Write Path

`proposal_id` for exactly-once processing, `dedupe_key` for "this is the same logical fact being proposed again."

**Why:** OpenClaw might retry proposals (network issues, restarts, concurrent agents). Without idempotency, retries create duplicate memories.

### 7. Provenance from Day One

Every memory records: `source_type` (agent_turn, document, observation, human_input), `source_ref` (thread ID, file path, URL), `evidence` (raw excerpts), `created_by`, `accepted_by`, `policy_version`.

**Why:** Without provenance, confidence scores are just vibes. You can't audit why a fact was accepted, trace back to source material, or determine which validation rules were in effect.

---

## Risk Analysis

### 1. Memory Poisoning

Bad summaries, hallucinated facts, or temporary assumptions become "truth."

**Mitigation:**
- Every memory has provenance (`source_type`, `source_ref`, `evidence`)
- Confidence scores with real meaning (tied to provenance, not vibes)
- Operating policies require human approval (`needs_human`)
- Append-only history enables post-hoc detection of poisoning

### 2. Contradictory Memory

The system accumulates conflicting statements over time.

**Mitigation:**
- Singleton partial unique index ensures only one active memory per canonical key for singleton kinds
- Version chains via `supersedes_memory_id` — the system always knows which version is current
- Deterministic keys (not embedding similarity) for canonicalization
- v2 will add contradiction detection; v1 prevents the worst case (two active singletons)

### 3. Memory Bloat

Too much low-value storage kills retrieval quality.

**Mitigation:**
- TTL-based decay (`decay_at`) — task state expires in 7 days, episodic in 30
- Bounded retrieval (cap 5 results) — over-retrieval is physically impossible
- Memory lifecycle: active -> expired -> archived (not deleted in v1)
- v2 will add compaction (merge duplicates, promote stable facts)

### 4. Wrong Memory Type

A temporary chat preference stored as system policy.

**Mitigation:**
- Schema enforcement at ingestion: `kind` validated against allowed values
- `operating_policy` always routes to `needs_human` — can't be auto-accepted
- Deterministic validator rejects structurally invalid proposals before the LLM touches them

### 5. Over-Retrieval

Too much history dragged into context degrades reasoning quality.

**Mitigation:**
- Retrieval capped at 5 results (configurable)
- Ranking: exact canonical_key match first, subject_key second, recency third
- Only active, non-expired memories returned
- Scope filtering: queries see their scope and broader, not narrower

### 6. Librarian Reliability

The Librarian worker is also an LLM. Who validates the validator?

**Mitigation:**
- The deterministic schema validator handles the 80% (structural checks, required fields, TTL bounds, idempotency)
- The Librarian worker only does classification and normalization — it cannot override hard rules
- Operating policies require human approval regardless of what the Librarian thinks
- v2 will add an Auditor that samples actions to verify correct memory usage

---

## Retrieval Gate Pattern

OpenClaw follows this pattern for non-trivial actions:

```
1. Check task context and immediate working state
2. Query Memory Library for:
   - Relevant policies
   - Project facts
   - Prior decisions
   - Unresolved threads
   - Known constraints
3. Pull only high-confidence, relevant memory objects (max 5)
4. Act
5. Emit a post-action memory proposal back to the Librarian
```

This is better than "always reference memory before acting on anything" because it is precise and operational. It avoids latency and token waste on trivial actions while ensuring material decisions are informed by canonical context.

---

## Decision Ledger

The `memory_events` table serves as the decision ledger. Every state transition is recorded:

| Event | When | Actor |
|-------|------|-------|
| `proposed` | OpenClaw emits a proposal | agent |
| `validated` | Schema validator passes | validator |
| `accepted` | Librarian accepts, canonical memory created | librarian or human |
| `rejected` | Librarian rejects | librarian or human |
| `needs_human` | Routed for human approval | validator (for operating_policy) |
| `superseded` | A newer memory replaced this one | librarian |
| `archived` | Manually archived | human or system |
| `expired` | TTL reached | system |

Each event records `actor_type`, `actor_id`, and `details` (JSON). This gives full auditability without polluting either the proposals or memories tables.
