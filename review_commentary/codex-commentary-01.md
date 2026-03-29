# Codex Commentary 01

Date: 2026-03-29
Reviewer: Codex
Scope: Deployment-focused code review of Librarian

## Verdict

I found three issues I would treat as deployment blockers and two additional medium-severity risks.

The blockers are all in the core governance path:
- session-scoped memory can leak through retrieval
- singleton enforcement is wrong across kinds
- subject/canonical query parameters do not filter, they only reorder

I also confirmed these with local runtime repros using the current Node 24 `--experimental-sqlite` implementation, not just static reading.

## Findings

### 1. High: Session-scoped memories leak through retrieval

Files:
- `service/src/retrieval.mjs:34`
- `service/src/retrieval.mjs:64`
- `service/src/retrieval.mjs:71`

Problem:
- session filtering only happens when `q.accessScope` is provided
- `query(db, {})` returns all active memories, including `session`-scoped entries
- `getByCanonicalKey()` and `getHistory()` do not enforce scope/session isolation at all

Why this matters:
- this breaks the documented scope model
- a caller that forgets to pass scope/session gets cross-session memory they should not see
- this is directly contrary to the service's isolation story

Confirmed repro:
- inserted a `session`-scoped episodic memory with `sessionKey = sess-1`
- `query(db, { limit: 10 })` returned it
- `getByCanonicalKey(db, "secret:key")` also returned it without any session context

### 2. High: Singleton enforcement supersedes across kinds

Files:
- `service/src/writer.mjs:84`
- `service/src/writer.mjs:86`
- `service/src/schema.mjs:133`

Problem:
- the active-singleton lookup and unique index are keyed only by `canonical_key`
- they do not include `kind`
- accepting a new singleton of one kind can supersede an active singleton of a different kind with the same key

Why this matters:
- `task_state`, `project_fact`, and `operating_policy` are semantically different memory classes
- sharing a canonical key should not let one class destroy another class's active record
- this can silently replace long-lived project facts or policies with ephemeral task state

Confirmed repro:
- accepted `project_fact(canonical_key = "shared:key")`
- then accepted `task_state(canonical_key = "shared:key")`
- the `project_fact` was marked `superseded`
- only the `task_state` remained active

### 3. High: `/query` key parameters do not filter results

Files:
- `service/src/retrieval.mjs:54`
- `service/src/retrieval.mjs:55`
- `service/src/retrieval.mjs:56`
- `service/src/retrieval.mjs:60`

Problem:
- `canonicalKey` and `subjectKey` only affect `ORDER BY`
- they are not added to `WHERE`
- the endpoint returns unrelated active memories as long as they fit inside `limit`

Why this matters:
- this violates the documented retrieval contract
- downstream agents can get irrelevant memories mixed into targeted lookups
- the system will appear to work in small datasets, then degrade as the corpus grows

Confirmed repro:
- inserted project facts for `alpha` and `beta`
- called `query(db, { subjectKey: "alpha", limit: 10 })`
- got both `alpha` and `beta`

### 4. Medium: Workspace identity is not enforced on startup

Files:
- `service/src/schema.mjs:143`
- `service/src/schema.mjs:145`
- `service/src/schema.mjs:146`

Problem:
- `workspace_id` is inserted with `INSERT OR IGNORE`
- there is no check that the existing DB `workspace_id` matches the configured `LIBRARIAN_WORKSPACE_ID`

Why this matters:
- one wrong DB path can silently point an instance at the wrong workspace database
- the service will boot normally instead of failing closed
- that weakens the "one DB per workspace" safety claim

Confirmed repro:
- called `ensureSchema(db, "workspace-a")`
- then `ensureSchema(db, "workspace-b")`
- DB kept `workspace-a`
- no error was raised

### 5. Medium: Deterministic validation is weaker than the docs claim

Files:
- `service/src/writer.mjs:21`
- `service/src/writer.mjs:51`
- `service/src/writer.mjs:57`
- docs claim stronger behavior in `docs/03 - Write Path and Retrieval.md`

Problem:
- validator checks required fields and enums only
- it does not validate `proposedDecayAt` as ISO-8601
- it does not validate evidence item shape or require evidence `type`

Why this matters:
- documented guarantees are being relied on that do not actually exist
- malformed TTL values are persisted directly and later compared lexically in SQL
- bad evidence structure gets stored even though docs say it is validated

Confirmed repro:
- submitted `proposedDecayAt = "not-a-date"` and `evidence = [{}]`
- proposal was accepted and stored as `pending`

## Testing Note

`npm test` currently runs zero tests:
- `service/package.json` points to `src/*.test.mjs`
- there are no test files in the repo

So none of the invariants above are automatically guarded right now.

## Bottom Line

I would pause deployment until Findings 1 through 3 are fixed.

Those are not polish issues. They cut directly into:
- scope isolation
- canonical memory correctness
- retrieval relevance

Findings 4 and 5 are not immediate stop-ship by themselves, but they materially weaken the service's stated governance and safety model.
