import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { openDatabase, ensureSchema } from "./schema.mjs";
import { validate, submitProposal, acceptProposal, rejectProposal } from "./writer.mjs";
import { query, getByCanonicalKey, getHistory } from "./retrieval.mjs";
import { renderProjection } from "./projection.mjs";
import { autoProcess } from "./librarian.mjs";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.LIBRARIAN_PORT ?? "9700", 10);
const HOST = process.env.LIBRARIAN_HOST ?? "127.0.0.1";
const DB_PATH = process.env.LIBRARIAN_DB_PATH ?? "/home/cyberhunter/.openclaw/state/governed-memory/concierge.sqlite";
const WORKSPACE_ID = process.env.LIBRARIAN_WORKSPACE_ID ?? "concierge";
const WORKSPACE_DIR = process.env.LIBRARIAN_WORKSPACE_DIR ?? "/home/cyberhunter/.openclaw/workspace";
const PROJECTION_REL = "memory/governed/MEMORY_CANONICAL.md";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = openDatabase(DB_PATH);
ensureSchema(db, WORKSPACE_ID);
const projectionPath = path.join(WORKSPACE_DIR, PROJECTION_REL);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = {
  "POST /propose": async (req, res) => {
    const body = await readBody(req);
    const input = {
      proposalId: body.proposalId ?? crypto.randomUUID(),
      agentId: body.agentId ?? "openclaw",
      sessionKey: body.sessionKey,
      kind: body.kind,
      subjectKey: body.subjectKey,
      canonicalKey: body.canonicalKey,
      accessScope: body.accessScope ?? "workspace",
      proposedText: body.proposedText,
      structuredPayload: body.structuredPayload,
      evidence: body.evidence,
      sourceType: body.sourceType ?? "agent_turn",
      sourceRef: body.sourceRef,
      dedupeKey: body.dedupeKey,
      proposedDecayAt: body.proposedDecayAt,
    };

    const result = submitProposal(db, input);
    if (result.status === "invalid") return json(res, 400, result);
    if (result.status === "duplicate") return json(res, 409, result);

    // Auto-process via librarian
    const librarian = await autoProcess(db, result.proposalRowId, projectionPath);
    json(res, 201, { proposal: result, librarian });
  },

  "POST /accept": async (req, res) => {
    const body = await readBody(req);
    if (!body.proposalRowId) return json(res, 400, { error: "proposalRowId required" });
    const result = acceptProposal(db, body.proposalRowId, {
      acceptedBy: body.acceptedBy ?? "human",
      confidence: body.confidence,
      canonicalKeyOverride: body.canonicalKeyOverride,
    });
    if (result.status === "error") return json(res, 404, result);
    const proj = await renderProjection(db, projectionPath);
    json(res, 200, { ...result, projection: proj });
  },

  "POST /reject": async (req, res) => {
    const body = await readBody(req);
    if (!body.proposalRowId) return json(res, 400, { error: "proposalRowId required" });
    const result = rejectProposal(db, body.proposalRowId, {
      rejectedBy: body.rejectedBy ?? "human",
      reason: body.reason,
    });
    if (result.status === "error") return json(res, 404, result);
    json(res, 200, result);
  },

  "GET /query": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const q = {
      canonicalKey: url.searchParams.get("canonicalKey") ?? undefined,
      subjectKey: url.searchParams.get("subjectKey") ?? undefined,
      kinds: url.searchParams.get("kinds")?.split(",").filter(Boolean) ?? undefined,
      accessScope: url.searchParams.get("accessScope") ?? undefined,
      sessionKey: url.searchParams.get("sessionKey") ?? undefined,
      limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit"), 10) : undefined,
      minConfidence: url.searchParams.has("minConfidence") ? parseFloat(url.searchParams.get("minConfidence")) : undefined,
    };
    json(res, 200, { results: query(db, q) });
  },

  "GET /memory": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const key = url.searchParams.get("canonicalKey");
    if (!key) return json(res, 400, { error: "canonicalKey required" });
    const sessionKey = url.searchParams.get("sessionKey") ?? undefined;
    const record = getByCanonicalKey(db, key, sessionKey);
    json(res, record ? 200 : 404, record ?? { error: "not found" });
  },

  "GET /history": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const key = url.searchParams.get("canonicalKey");
    if (!key) return json(res, 400, { error: "canonicalKey required" });
    json(res, 200, { history: getHistory(db, key) });
  },

  "GET /health": async (_req, res) => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get();
    json(res, 200, { status: "ok", activeMemories: count.count, workspaceId: WORKSPACE_ID });
  },

  "POST /projection/render": async (_req, res) => {
    const result = await renderProjection(db, projectionPath);
    json(res, 200, result);
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const method = req.method;
  const pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  const routeKey = `${method} ${pathname}`;

  const handler = routes[routeKey];
  if (!handler) return json(res, 404, { error: "not found", path: pathname });

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${routeKey}] Error:`, err.message);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[librarian] Governed memory service listening on http://${HOST}:${PORT}`);
  console.log(`[librarian] DB: ${DB_PATH}`);
  console.log(`[librarian] Workspace: ${WORKSPACE_DIR}`);
  console.log(`[librarian] Projection: ${projectionPath}`);
});

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
