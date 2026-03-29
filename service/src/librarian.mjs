import { acceptProposal } from "./writer.mjs";
import { renderProjection } from "./projection.mjs";

const CONFIDENCE = { project_fact: 0.65, _default: 0.8 };

export async function autoProcess(db, proposalRowId, projectionPath) {
  const proposal = db.prepare(`SELECT id, kind, status FROM memory_proposals WHERE id = ?`).get(proposalRowId);
  if (!proposal) return { status: "error", message: `not found: ${proposalRowId}` };
  if (proposal.status === "needs_human" || proposal.kind === "operating_policy") {
    return { status: "needs_human", proposalRowId: proposal.id };
  }
  if (proposal.status !== "pending") {
    return { status: "noop", reason: `status is '${proposal.status}'` };
  }

  const confidence = CONFIDENCE[proposal.kind] ?? CONFIDENCE._default;
  const result = acceptProposal(db, proposal.id, { acceptedBy: "librarian", confidence });
  if (result.status !== "accepted") return { status: "error", message: result.message };

  let projection = { attempted: false };
  if (projectionPath) {
    try {
      const p = await renderProjection(db, projectionPath);
      projection = { attempted: true, changed: p.changed, entryCount: p.entryCount };
    } catch (err) {
      projection = { attempted: true, error: err.message };
    }
  }

  return {
    status: "accepted",
    memoryId: result.memoryId,
    supersededMemoryId: result.supersededMemoryId,
    projection,
  };
}
