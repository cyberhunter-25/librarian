# Librarian

Memory governance for agentic AI systems.

Librarian is a standalone HTTP service that replaces direct memory writes with a **proposal/validation/acceptance pipeline**. It ensures that an AI agent's long-term memory is clean, versioned, auditable, and governed — not a dumping ground of hallucinated facts and stale assumptions.

**The core insight:** An AI agent should not write its own canonical memory. It should *propose* memory events. A separate Librarian service decides what becomes canonical. This is the same separation that makes event sourcing and write-ahead logs reliable.

## Why This Exists

Every agentic AI system with persistent memory eventually hits the same problems:

| Problem | What Happens |
|---------|-------------|
| **Memory poisoning** | Bad summaries or hallucinated facts become permanent "truth" |
| **Contradictory memory** | Conflicting statements accumulate with no resolution |
| **Memory bloat** | Low-value storage degrades retrieval quality |
| **Wrong memory type** | A temporary chat preference gets stored with the same authority as a system policy |
| **Over-retrieval** | Too much history dragged into context degrades reasoning |
| **No provenance** | No way to trace *why* a fact was stored or *who* validated it |

Librarian solves all of these with a governance layer between the agent and its memory store.

## Architecture

```
AI Agent (any framework)              Librarian Service
    │                                      │
    │── POST /propose ─────────────────────│──→ validate → submit → auto-accept
    │── GET  /query   ─────────────────────│──→ deterministic SQL retrieval
    │── GET  /memory  ─────────────────────│──→ canonical key lookup
    │── GET  /history ─────────────────────│──→ supersession chain
    │                                      │
    │                                      │──→ writes: MEMORY_CANONICAL.md
    │                                      │──→ SQLite: one DB per workspace
```

### Key Principles

- **Agents propose; the Librarian decides.** Agents never write canonical memory directly.
- **Append-only with supersession.** Never overwrite; always supersede. Full history preserved.
- **Policies require human approval.** `operating_policy` kind always gates through `needs_human`.
- **Hard isolation by file.** One SQLite DB per workspace. Cross-tenant access is physically impossible.
- **Deterministic retrieval.** Simple SQL queries, scope-constrained, capped at N results. No LLM in the read path.
- **Provenance from day one.** Every memory traces to its source proposal, evidence, creator, and approver.
- **Zero dependencies.** Node.js built-in SQLite. No npm packages. No external services.

## Quick Start

### Requirements

- Node.js 22+ (uses built-in `node:sqlite`)

### Run the Service

```bash
cd service

# Minimal — starts on localhost:9700 with a local SQLite DB
LIBRARIAN_DB_PATH=./data/my-workspace.sqlite \
LIBRARIAN_WORKSPACE_ID=my-workspace \
LIBRARIAN_WORKSPACE_DIR=./workspace \
node --experimental-sqlite src/server.mjs
```

### Propose a Memory

```bash
curl -s -X POST http://127.0.0.1:9700/propose \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "project_fact",
    "subjectKey": "deploy-key-rotation",
    "canonicalKey": "infra:deploy-key-rotation",
    "proposedText": "The deploy key rotates monthly on the first Monday.",
    "sourceType": "human_input"
  }'
```

### Query Memories

```bash
# All active memories
curl -s http://127.0.0.1:9700/query | python3 -m json.tool

# By subject
curl -s "http://127.0.0.1:9700/query?subjectKey=deploy-key-rotation"

# By canonical key
curl -s "http://127.0.0.1:9700/memory?canonicalKey=infra:deploy-key-rotation"

# Full version history
curl -s "http://127.0.0.1:9700/history?canonicalKey=infra:deploy-key-rotation"

# Health check
curl -s http://127.0.0.1:9700/health
```

## Memory Types

| Kind | Singleton | Default TTL | Human Approval | Use Case |
|------|-----------|-------------|----------------|----------|
| `task_state` | Yes (by canonical_key) | 7 days | No | Current task progress, temporary working state |
| `episodic` | No | 30 days | No | Conversation observations, one-off events |
| `project_fact` | Yes (by canonical_key) | Permanent | No | Architecture decisions, customer details, validated facts |
| `operating_policy` | Yes (by canonical_key) | Permanent | **Yes (always)** | System behavior rules, operating procedures |
| `decision` | No | Permanent | No | Material choices with rationale and rejected alternatives |

**Singleton** means only one active memory can exist per `canonical_key` for that kind. When a new version is accepted, the old one is automatically superseded (not deleted — full history preserved).

## Multi-Instance Deployment

Librarian is designed for fleet deployment. Each instance is fully independent — no shared state, no coordination, no distributed consensus.

### The Model: Shared Brains vs. Distinct Brains

Think of each Librarian instance as a **brain** for a specific scope of concern:

```
┌───────────────────────────────────────────────────────┐
│                    Organization                       │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐ ┌──────────────┐  │
│  │  Shared Brain│  │  Shared Brain│ │  Shared Brain│  │
│  │  (Company)   │  │  (Infra)     │ │  (Legal)     │  │
│  │  Port 9700   │  │  Port 9701   │ │  Port 9702   │  │
│  │              │  │              │ │              │  │
│  │  Policies,   │  │  Runbooks,   │ │  Compliance  │  │
│  │  org facts,  │  │  topology,   │ │  rules,      │  │
│  │  culture     │  │  incidents   │ │  precedents  │  │
│  └──────────────┘  └──────────────┘ └──────────────┘  │
│                                                       │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │ Distinct     │  │ Distinct    │  │ Distinct    │   │
│  │ Brain        │  │ Brain       │  │ Brain       │   │
│  │ (Sales Team) │  │ (Eng Team)  │  │ (SOC Team)  │   │
│  │ Port 9710    │  │ Port 9711   │  │ Port 9712   │   │
│  │              │  │             │  │             │   │
│  │ Deals, CRM   │  │ Sprint      │  │ Cases,      │   │
│  │ contacts,    │  │ context,    │  │ triage,     │   │
│  │ proposals    │  │ tech debt   │  │ IOCs        │   │
│  └──────────────┘  └─────────────┘  └─────────────┘   │
└───────────────────────────────────────────────────────┘
```

**Shared Brains** hold knowledge that multiple teams or agents need:
- Company-wide policies and facts
- Infrastructure topology and runbooks
- Legal/compliance rules

**Distinct Brains** hold knowledge scoped to a specific team, project, or customer:
- Sales pipeline for one rep
- Engineering sprint context for one team
- SOC case history for one customer

An agent can query multiple Librarian instances to build context from both shared and distinct brains.

### Deploying Multiple Instances

Each instance needs its own port, database path, and workspace ID:

```bash
# Shared brain: company-wide knowledge
LIBRARIAN_PORT=9700 \
LIBRARIAN_DB_PATH=/data/librarian/company.sqlite \
LIBRARIAN_WORKSPACE_ID=company \
LIBRARIAN_WORKSPACE_DIR=/data/workspaces/company \
node --experimental-sqlite src/server.mjs

# Distinct brain: engineering team
LIBRARIAN_PORT=9711 \
LIBRARIAN_DB_PATH=/data/librarian/eng-team.sqlite \
LIBRARIAN_WORKSPACE_ID=eng-team \
LIBRARIAN_WORKSPACE_DIR=/data/workspaces/eng-team \
node --experimental-sqlite src/server.mjs

# Distinct brain: SOC operations
LIBRARIAN_PORT=9712 \
LIBRARIAN_DB_PATH=/data/librarian/soc-ops.sqlite \
LIBRARIAN_WORKSPACE_ID=soc-ops \
LIBRARIAN_WORKSPACE_DIR=/data/workspaces/soc-ops \
node --experimental-sqlite src/server.mjs
```

### Systemd Template (for Linux servers)

Create `/etc/systemd/system/librarian@.service`:

```ini
[Unit]
Description=Librarian Governed Memory (%i)
After=network.target

[Service]
Type=simple
User=ai-service
WorkingDirectory=/opt/librarian
ExecStart=/usr/bin/node --experimental-sqlite src/server.mjs
Restart=always
RestartSec=5
Environment=LIBRARIAN_PORT=%i
Environment=LIBRARIAN_HOST=127.0.0.1
Environment=LIBRARIAN_DB_PATH=/data/librarian/%i.sqlite
Environment=LIBRARIAN_WORKSPACE_DIR=/data/workspaces/%i

[Install]
WantedBy=multi-user.target
```

Then deploy instances by name:

```bash
# Start instances
sudo systemctl start librarian@9700    # company shared brain
sudo systemctl start librarian@9711    # eng team brain
sudo systemctl start librarian@9712    # soc team brain

# Enable on boot
sudo systemctl enable librarian@9700 librarian@9711 librarian@9712
```

### Multi-Brain Agent Pattern

An agent queries both shared and distinct brains to build its working context:

```python
import requests

SHARED_BRAIN = "http://127.0.0.1:9700"   # company policies
TEAM_BRAIN   = "http://127.0.0.1:9711"   # eng team context

def get_context(subject):
    """Query both shared and team brains for relevant context."""
    shared = requests.get(f"{SHARED_BRAIN}/query", params={"subjectKey": subject}).json()
    team = requests.get(f"{TEAM_BRAIN}/query", params={"subjectKey": subject}).json()
    return {
        "policies": shared.get("results", []),
        "team_context": team.get("results", []),
    }

def propose_memory(brain_url, kind, subject, text, canonical_key=None):
    """Propose a memory to a specific brain."""
    return requests.post(f"{brain_url}/propose", json={
        "kind": kind,
        "subjectKey": subject,
        "canonicalKey": canonical_key,
        "proposedText": text,
        "sourceType": "agent_turn",
    }).json()

# Team-specific fact goes to team brain
propose_memory(TEAM_BRAIN, "project_fact", "api-migration",
    "API v2 migration is 60% complete, auth endpoints done, billing pending",
    canonical_key="project:api-v2-migration-status")

# Company-wide policy goes to shared brain (will require human approval)
propose_memory(SHARED_BRAIN, "operating_policy", "incident-response",
    "All P1 incidents must have a postmortem within 48 hours",
    canonical_key="policy:incident-postmortem-sla")
```

## Using With Different AI Models

Librarian is **model-agnostic**. It's a pure HTTP service — any AI system that can make HTTP requests can use it. The auto-accept logic is deterministic (no LLM calls in the current v1), so it works identically regardless of which model is proposing memories.

### OpenClaw / Open WebUI

Use a skill or tool definition that teaches the agent to call the Librarian API:

```markdown
When the user wants something remembered, or when you identify a durable fact,
call the Librarian API:

POST http://127.0.0.1:9700/propose
{
  "kind": "project_fact",
  "subjectKey": "<topic>",
  "canonicalKey": "<namespace:key>",
  "proposedText": "<the memory>",
  "sourceType": "agent_turn"
}

Before acting on non-trivial tasks, query for relevant context:
GET http://127.0.0.1:9700/query?subjectKey=<topic>
```

### Claude Code / Anthropic

Add Librarian calls to your Claude Code hooks or custom skills. The projection file (`MEMORY_CANONICAL.md`) can be included in your `CLAUDE.md` context.

### LangChain / LangGraph

```python
from langchain.tools import tool
import requests

LIBRARIAN_URL = "http://127.0.0.1:9700"

@tool
def remember(kind: str, subject: str, text: str, canonical_key: str = None) -> str:
    """Store a governed memory via the Librarian service."""
    resp = requests.post(f"{LIBRARIAN_URL}/propose", json={
        "kind": kind, "subjectKey": subject,
        "canonicalKey": canonical_key, "proposedText": text,
        "sourceType": "agent_turn",
    })
    return resp.json()

@tool
def recall(subject: str) -> str:
    """Query governed memories by subject."""
    resp = requests.get(f"{LIBRARIAN_URL}/query", params={"subjectKey": subject})
    return resp.json()
```

### CrewAI / AutoGen / Any Framework

If your framework can make HTTP calls, it can use Librarian. The API is simple REST — no SDK required.

## API Reference

| Method | Path | Purpose |
|--------|------|---------|
| `POST /propose` | Submit a memory proposal (auto-processed by librarian) |
| `POST /accept` | Manually accept a `needs_human` proposal |
| `POST /reject` | Reject a proposal |
| `GET /query` | Query active memories (filtered, ranked, capped) |
| `GET /memory` | Get single memory by canonical key |
| `GET /history` | Get full supersession chain for a canonical key |
| `GET /health` | Service health + active memory count |
| `POST /projection/render` | Force re-render of Markdown projection file |

### POST /propose

```json
{
  "kind": "project_fact",
  "subjectKey": "deploy-rotation",
  "canonicalKey": "infra:deploy-key-rotation",
  "proposedText": "Deploy key rotates monthly on the first Monday.",
  "accessScope": "workspace",
  "sourceType": "agent_turn",
  "sourceRef": "thread-abc123",
  "evidence": [{"type": "observation", "text": "User confirmed in chat"}],
  "structuredPayload": {"rotation_day": "first_monday"},
  "dedupeKey": "deploy-rotation-v1"
}
```

**Required:** `kind`, `subjectKey`, `proposedText`, `sourceType`
**Auto-generated if omitted:** `proposalId`, `agentId`, `accessScope` (defaults to `workspace`)

### GET /query

| Param | Type | Description |
|-------|------|-------------|
| `canonicalKey` | string | Exact match (ranked first) |
| `subjectKey` | string | Exact match (ranked second) |
| `kinds` | string | Comma-separated: `project_fact,operating_policy` |
| `accessScope` | string | Returns this scope and broader |
| `sessionKey` | string | Required for session-scoped memories |
| `limit` | int | Max results (default: 5) |
| `minConfidence` | float | Minimum confidence threshold |

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `LIBRARIAN_PORT` | `9700` | HTTP listen port |
| `LIBRARIAN_HOST` | `127.0.0.1` | Bind address (loopback only by default) |
| `LIBRARIAN_DB_PATH` | (see source) | SQLite database file path |
| `LIBRARIAN_WORKSPACE_ID` | `default` | Workspace identifier stored in DB metadata |
| `LIBRARIAN_WORKSPACE_DIR` | (see source) | Directory for projection file output |

The projection file is written to `{LIBRARIAN_WORKSPACE_DIR}/memory/governed/MEMORY_CANONICAL.md`.

## Data Isolation

Each Librarian instance uses a **separate SQLite file**. Cross-workspace access is physically impossible — not prevented by policy or row-level security, but by filesystem boundaries. There is no way to query workspace A's data from workspace B's Librarian instance.

This means:
- **Backup** = copy the `.sqlite` file
- **Migration** = move the file to a new server
- **Deletion** = delete the file (or move to an archive directory)
- **Compliance** = data residency is as simple as choosing where the file lives

## Roadmap

### v1 (Current)
- [x] Standalone HTTP service (zero dependencies, Node.js built-in SQLite)
- [x] Deterministic validator + auto-accept librarian with confidence tiers
- [x] Singleton enforcement, supersession chains, full audit trail
- [x] Scope-filtered deterministic retrieval
- [x] Markdown projection file (generated, not authored)

### v2 (Planned)
- [ ] Semantic deduplication
- [ ] Contradiction auto-resolution
- [ ] Smart compaction (merge duplicates, promote stable facts)
- [ ] Embedding-based search
- [ ] Dynamic threshold learning from rejection history
- [ ] `needs_human` notification surface (Slack, webhook, etc.)
- [ ] Session-memory hook integration

## License

MIT

## Credits

Designed by CyberHunter Solutions. Built collaboratively by Dennis Jax, Claude (Anthropic), and Codex (OpenAI).
