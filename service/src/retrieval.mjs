const SCOPE_ORDER = { session: 0, agent: 1, workspace: 2, tenant: 3 };

function scopesAtOrAbove(scope) {
  const threshold = SCOPE_ORDER[scope] ?? 0;
  return Object.entries(SCOPE_ORDER).filter(([, order]) => order >= threshold).map(([s]) => s);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toRecord(row) {
  return {
    id: row.id, agentId: row.agent_id, sessionKey: row.session_key, kind: row.kind,
    status: row.status, subjectKey: row.subject_key, canonicalKey: row.canonical_key,
    accessScope: row.access_scope, content: row.content,
    structuredPayload: parseJson(row.structured_payload, {}),
    evidence: parseJson(row.evidence, []),
    confidence: row.confidence, sourceType: row.source_type, sourceRef: row.source_ref,
    createdBy: row.created_by, acceptedBy: row.accepted_by, policyVersion: row.policy_version,
    validAt: row.valid_at, decayAt: row.decay_at,
    supersedesMemoryId: row.supersedes_memory_id, createdAt: row.created_at,
  };
}

const COLUMNS = `id, agent_id, session_key, kind, status, subject_key, canonical_key, access_scope, content, structured_payload, evidence, confidence, source_type, source_ref, created_by, accepted_by, policy_version, valid_at, decay_at, supersedes_memory_id, created_at`;

export function query(db, q = {}) {
  const limit = q.limit ?? 5;
  const conditions = ["status = 'active'", "(decay_at IS NULL OR decay_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))"];
  const params = [];

  if (q.accessScope) {
    const scopes = scopesAtOrAbove(q.accessScope);
    conditions.push(`access_scope IN (${scopes.map(() => "?").join(",")})`);
    params.push(...scopes);
    if (q.sessionKey) {
      conditions.push(`(access_scope != 'session' OR session_key = ?)`);
      params.push(q.sessionKey);
    } else {
      conditions.push("access_scope != 'session'");
    }
  }
  if (q.kinds?.length) {
    conditions.push(`kind IN (${q.kinds.map(() => "?").join(",")})`);
    params.push(...q.kinds);
  }
  if (q.minConfidence > 0) {
    conditions.push("confidence >= ?");
    params.push(q.minConfidence);
  }

  const order = [];
  if (q.canonicalKey) { order.push("CASE WHEN canonical_key = ? THEN 0 ELSE 1 END"); params.push(q.canonicalKey); }
  if (q.subjectKey) { order.push("CASE WHEN subject_key = ? THEN 0 ELSE 1 END"); params.push(q.subjectKey); }
  order.push("created_at DESC");

  params.push(limit);
  const sql = `SELECT ${COLUMNS} FROM memories WHERE ${conditions.join(" AND ")} ORDER BY ${order.join(", ")} LIMIT ?`;
  return db.prepare(sql).all(...params).map(toRecord);
}

export function getByCanonicalKey(db, canonicalKey) {
  const row = db.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE canonical_key = ? AND status = 'active' AND (decay_at IS NULL OR decay_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1`
  ).get(canonicalKey);
  return row ? toRecord(row) : null;
}

export function getHistory(db, canonicalKey) {
  const rows = db.prepare(
    `WITH RECURSIVE history AS (
      SELECT ${COLUMNS}, 0 AS depth FROM memories WHERE canonical_key = ? AND status = 'active'
      UNION ALL
      SELECT ${COLUMNS.split(",").map(c => `m.${c.trim()}`).join(",")}, history.depth + 1 AS depth
      FROM memories m JOIN history ON history.supersedes_memory_id = m.id
    )
    SELECT ${COLUMNS} FROM history ORDER BY depth ASC`
  ).all(canonicalKey);

  if (rows.length > 0) return rows.map(toRecord);

  return db.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE canonical_key = ? ORDER BY created_at DESC, id DESC`
  ).all(canonicalKey).map(toRecord);
}
