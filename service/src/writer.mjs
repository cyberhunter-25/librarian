import crypto from "node:crypto";
import { SCHEMA_VERSION, immediate } from "./schema.mjs";

const SINGLETON_KINDS = new Set(["task_state", "project_fact", "operating_policy"]);
const VALID_KINDS = new Set(["task_state", "episodic", "project_fact", "operating_policy", "decision"]);
const VALID_SCOPES = new Set(["session", "agent", "workspace", "tenant"]);
const VALID_SOURCE_TYPES = new Set(["agent_turn", "document", "observation", "human_input"]);
const DEFAULT_DECAY_DAYS = { task_state: 7, episodic: 30 };
const POLICY_VERSION = `v${SCHEMA_VERSION}`;

function nonEmpty(v) { return v != null && String(v).trim().length > 0; }

function defaultDecay(kind) {
  const days = DEFAULT_DECAY_DAYS[kind];
  if (!days) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function validate(input) {
  const errors = [];
  if (!nonEmpty(input.proposalId)) errors.push({ field: "proposalId", message: "required" });
  if (!nonEmpty(input.agentId)) errors.push({ field: "agentId", message: "required" });
  if (!VALID_KINDS.has(input.kind)) errors.push({ field: "kind", message: `invalid: ${input.kind}` });
  if (!nonEmpty(input.subjectKey)) errors.push({ field: "subjectKey", message: "required" });
  if (!VALID_SCOPES.has(input.accessScope)) errors.push({ field: "accessScope", message: `invalid: ${input.accessScope}` });
  if (!nonEmpty(input.proposedText)) errors.push({ field: "proposedText", message: "required" });
  if (!nonEmpty(input.sourceType)) errors.push({ field: "sourceType", message: "required" });
  if (input.sourceType && !VALID_SOURCE_TYPES.has(input.sourceType)) errors.push({ field: "sourceType", message: `invalid: ${input.sourceType}` });
  if (SINGLETON_KINDS.has(input.kind) && !nonEmpty(input.canonicalKey)) errors.push({ field: "canonicalKey", message: `required for ${input.kind}` });
  if (input.accessScope === "session" && !nonEmpty(input.sessionKey)) errors.push({ field: "sessionKey", message: "required for session scope" });
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

function writeEvent(db, e) {
  db.prepare(
    `INSERT INTO memory_events (proposal_id, memory_id, event_type, actor_type, actor_id, details) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(e.proposalId ?? null, e.memoryId ?? null, e.eventType, e.actorType, e.actorId, JSON.stringify(e.details ?? {}));
}

export function submitProposal(db, input, actorId) {
  const v = validate(input);
  if (!v.valid) return { status: "invalid", errors: v.errors };

  if (input.dedupeKey) {
    const dup = db.prepare(`SELECT proposal_id FROM memory_proposals WHERE dedupe_key = ?`).get(input.dedupeKey);
    if (dup) return { status: "duplicate", existingProposalId: dup.proposal_id };
  }

  const decayAt = input.proposedDecayAt ?? defaultDecay(input.kind);
  const initialStatus = input.kind === "operating_policy" ? "needs_human" : "pending";
  const rowId = crypto.randomUUID();

  return immediate(db, () => {
    db.prepare(
      `INSERT INTO memory_proposals (id, proposal_id, agent_id, session_key, kind, subject_key, canonical_key, access_scope, proposed_text, structured_payload, evidence, source_type, source_ref, dedupe_key, proposed_decay_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(rowId, input.proposalId, input.agentId, input.sessionKey ?? null, input.kind, input.subjectKey, input.canonicalKey ?? null, input.accessScope, input.proposedText, JSON.stringify(input.structuredPayload ?? {}), JSON.stringify(input.evidence ?? []), input.sourceType, input.sourceRef ?? null, input.dedupeKey ?? null, decayAt, initialStatus);

    writeEvent(db, { proposalId: rowId, eventType: "proposed", actorType: "agent", actorId: actorId ?? input.agentId });
    writeEvent(db, { proposalId: rowId, eventType: "validated", actorType: "validator", actorId: "deterministic-validator" });

    return { status: initialStatus, proposalRowId: rowId };
  });
}

export function acceptProposal(db, proposalRowId, opts = {}) {
  const proposal = db.prepare(`SELECT * FROM memory_proposals WHERE id = ?`).get(proposalRowId);
  if (!proposal) return { status: "error", message: `not found: ${proposalRowId}` };
  if (proposal.status !== "pending" && proposal.status !== "needs_human") {
    return { status: "error", message: `status is '${proposal.status}'` };
  }

  const kind = proposal.kind;
  const canonicalKey = opts.canonicalKeyOverride ?? proposal.canonical_key ?? proposal.subject_key;
  const acceptedBy = opts.acceptedBy ?? "librarian";
  const confidence = opts.confidence ?? 0.5;
  const memoryId = crypto.randomUUID();
  const decayAt = proposal.proposed_decay_at;

  return immediate(db, () => {
    let supersededMemoryId;

    if (SINGLETON_KINDS.has(kind)) {
      const existing = db.prepare(
        `SELECT id FROM memories WHERE canonical_key = ? AND status = 'active' AND kind IN ('task_state','project_fact','operating_policy')`
      ).get(canonicalKey);
      if (existing) {
        supersededMemoryId = existing.id;
        db.prepare(`UPDATE memories SET status = 'superseded', superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(supersededMemoryId);
        writeEvent(db, { memoryId: supersededMemoryId, eventType: "superseded", actorType: "librarian", actorId: acceptedBy, details: { superseded_by: memoryId } });
      }
    }

    db.prepare(
      `INSERT INTO memories (id, agent_id, session_key, kind, status, subject_key, canonical_key, access_scope, content, structured_payload, evidence, confidence, source_proposal_id, source_type, source_ref, created_by, accepted_by, policy_version, decay_at, supersedes_memory_id) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(memoryId, proposal.agent_id, proposal.session_key ?? null, kind, proposal.subject_key, canonicalKey, proposal.access_scope, proposal.proposed_text, proposal.structured_payload ?? "{}", proposal.evidence ?? "[]", confidence, proposalRowId, proposal.source_type, proposal.source_ref ?? null, proposal.agent_id, acceptedBy, POLICY_VERSION, decayAt, supersededMemoryId ?? null);

    db.prepare(`UPDATE memory_proposals SET status = 'accepted', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(acceptedBy, proposalRowId);
    writeEvent(db, { proposalId: proposalRowId, memoryId, eventType: "accepted", actorType: acceptedBy === "human" ? "human" : "librarian", actorId: acceptedBy, details: { memory_id: memoryId, confidence, ...(supersededMemoryId ? { superseded_memory_id: supersededMemoryId } : {}) } });

    return { status: "accepted", memoryId, supersededMemoryId };
  });
}

export function rejectProposal(db, proposalRowId, opts = {}) {
  const proposal = db.prepare(`SELECT id, status FROM memory_proposals WHERE id = ?`).get(proposalRowId);
  if (!proposal) return { status: "error", message: `not found: ${proposalRowId}` };
  if (proposal.status !== "pending" && proposal.status !== "needs_human") {
    return { status: "error", message: `status is '${proposal.status}'` };
  }
  const rejectedBy = opts.rejectedBy ?? "librarian";
  return immediate(db, () => {
    db.prepare(`UPDATE memory_proposals SET status = 'rejected', review_notes = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(opts.reason ?? null, rejectedBy, proposalRowId);
    writeEvent(db, { proposalId: proposalRowId, eventType: "rejected", actorType: rejectedBy === "human" ? "human" : "librarian", actorId: rejectedBy, details: opts.reason ? { reason: opts.reason } : {} });
    return { status: "rejected" };
  });
}
