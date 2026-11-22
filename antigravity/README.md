# ArtEmis: EverOS Memory Plugin for Google Antigravity

Persistent, cross-session, self-evolving memory for **Google Antigravity**, backed by the [EverOS](https://github.com/EverMind-AI/EverOS) cognitive memory engine (`http://127.0.0.1:8000`).

Strictly compliant with the EverOS v2 backend protocol (`/api/v2/memory/*`), built with a **pure ESM architecture and zero runtime dependencies (Zero-Dep)**, fully resilient on Windows 11, and featuring an advanced **Three-Tier Progressive Disclosure** context assembly pipeline.

---

## Table of Contents

- [1. Cognitive Model Prerequisites (Important!)](#1-cognitive-model-prerequisites-important)
- [2. One-Click AI Agent Deployment Prompt](#2-one-click-ai-agent-deployment-prompt)
- [3. Manual Installation & Setup](#3-manual-installation--setup)
- [4. Key Highlights & Architectural Invariants](#4-key-highlights--architectural-invariants)
- [5. Dual-Language Semantic Anchors](#5-dual-language-semantic-anchors)
- [6. Native MCP Server Tools & Skills Console](#6-native-mcp-server-tools--skills-console)
- [7. Configuration Reference](#7-configuration-reference)
- [8. Verification & Test Suite](#8-verification--test-suite)
- [License](#license)

---

## 1. Cognitive Model Prerequisites (Important!)

> [!IMPORTANT]
> **Dual-Model Cognitive Engine Dependency**:
> This plugin (client adapter layer) is strictly pure ESM with **zero runtime dependencies** and built-in fail-open resilience.
> However, the underlying **EverOS backend engine requires two distinct AI model services** configured to extract memories and power dense vector retrieval:
> 1. **Extractor LLM (Inference Model)**: Distills raw conversation transcripts, extracts coding conventions, records architectural decisions, and evolves the developer profile.
> 2. **Dense Embedding Model (Vector Model)**: Computes dense semantic vectors for user prompts and memory collections, enabling sub-second hybrid and semantic search.
>
> Without configuring these models, EverOS cannot construct vector indexes or extract cognitive memories.

### Recommended Configuration Template (`~/.everos/everos.toml`)

Create or update `~/.everos/everos.toml` (or `%USERPROFILE%\.everos\everos.toml` on Windows):

```toml
[server]
host = "127.0.0.1"
port = 8000

# 1. Extractor LLM: Distills transcripts, extracts entities, and evolves user profile
[llm]
provider = "openai"
base_url = "https://api.example.com/v1"       # Endpoint for your inference model
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
model = "your-chat-model-name"
temperature = 0.2

# 2. Dense Embedding Model: Vectorizes memory collections for semantic retrieval
[embedding]
provider = "openai"
base_url = "https://api.example.com/v1"       # Endpoint for your embedding model
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
model = "your-embedding-model-name"
dimension = 4096                              # Must strictly match the model dimension
query_max_concurrent = 8                      # Concurrent search slots (default 16)

[storage]
backend = "lancedb"                           # Default vector storage backend
```

### Health Verification
Start your EverOS server and verify readiness:
```bash
curl http://127.0.0.1:8000/health
```
**Expected response**:
```json
{
  "healthy": true,
  "embed": true,
  "version": "1.5.1"
}
```
> Ensure both `"healthy": true` and `"embed": true` are returned to activate full semantic retrieval and memory ingestion.

---

## 2. One-Click AI Agent Deployment Prompt

If you use an AI Agent (e.g., Antigravity, Codex, Claude Code, Deepseek Harness, etc.), **copy and paste the prompt below directly to your Agent**. It will automatically inspect the environment, configure prerequisites, and register the plugin:

````markdown
# ArtEmis Automated Deployment Task

Please execute the automated configuration, deployment, and verification of the ArtEmis (EverOS Google Antigravity) memory plugin on this machine.
The plugin root is the current directory (if not located here, please prompt me for or locate the plugin repository path).

Execute the workflow sequentially through the following five phases:

## Phase 1: Runtime & Dependency Discovery
- Verify that Node.js runtime version satisfies `>= 20.0.0`;
- Inspect system Python `>= 3.10` and EverOS package status (`everos --version` or in the active virtual environment); guide or run `pip install everos` if uninstalled.

## Phase 2: Dual-Model Cognitive Configuration Verification
- Check if `~/.everos/everos.toml` (or `%USERPROFILE%\.everos\everos.toml` on Windows) exists with valid `[llm]` and `[embedding]` sections;
- If missing or unconfigured, prompt me for the following two sets of credentials:
  1. **Extractor LLM**: Base URL, API Key, Model Name (for transcript distillation, rule extraction, and developer profile evolution);
  2. **Embedding Model**: Base URL, API Key, Model Name, and Output Dimension (for dense vector indexing and semantic recall);
- Automatically generate and atomically write the standard `~/.everos/everos.toml`.

## Phase 3: Daemon Launch & Health Deep Check
- Start or verify the running EverOS daemon (`http://127.0.0.1:8000`);
- Probe `http://127.0.0.1:8000/health` and verify the JSON response strictly satisfies:
  * `healthy === true`
  * `embed === true`
  Confirming both dense embedding and LLM backend pipelines are fully operational.

## Phase 4: Global Deployment, Native Sidecar Registration & Test Gates
- In the plugin repository root, run manifest security gates:
  `node scripts/check-manifests.mjs` (ensure all 16 checks pass with 0 FAIL);
- Deploy as a global plugin and register the native Antigravity Sidecar daemon:
  `node scripts/install.mjs -g -s` (installs to `~/.gemini/config/plugins/everos/` and registers `~/.gemini/config/sidecars/everos/`);
- Execute full test suite to guarantee environment resilience:
  `npm test` (verify all 120 tests pass).

## Phase 5: Handoff & Verification Summary
- Render a structured diagnostic summary (EverOS endpoint, dual-model connection status, plugin and sidecar registration paths);
- Advise me to restart or reload Antigravity and inspect status via `/everos status`.
````

---

## 3. Manual Installation & Setup

### 1. Global Plugin & Native Sidecar Registration (Recommended)
From the plugin repository directory, run:
```bash
# -g: Deploy as a global plugin (~/.gemini/config/plugins/everos)
# -s: Register Antigravity native persistent Sidecar daemon
node scripts/install.mjs -g -s
```

### 2. Workspace-Level Setup
To mount the plugin only for a specific project:
```bash
node scripts/install.mjs --workspace /path/to/your/workspace
```
The installer automatically links hooks and MCP tools into `<workspace>/.agents/hooks.json` and `<workspace>/.agents/mcp_config.json`, safely creating `.bak` backups of any existing configurations.

### 3. Uninstall & Rollback
```bash
node scripts/install.mjs -g --uninstall
```

---

## 4. Key Highlights & Architectural Invariants

```
       Google Antigravity IDE (Host)
┌───────────────────────────────────────────────┐
│ System Context: <everos_profile> (L1 Profile) │ ─── Prescriptive Covenants & Tacit Affinities
│ History Trajectory                            │
│ Ephemeral Turn: <everos_memory> (L2 Ephemeral)│ ─── Erstwhile Exemplars & Interwoven Vestiges
│ Current User Prompt                           │
└───────────────────────────────────────────────┘
                       ▲
                       │ stdio JSON-RPC 2.0 / Hook Ingestion
                       ▼
┌───────────────────────────────────────────────┐
│ everos-antigravity (Pure ESM, Zero-Dep)       │
│ - Hook IO & Windows 11 Natural Drain Protocol │
│ - Detached Worker Dispatch (~300ms startup)   │
│ - Two-Phase Commit (2PC) State Ledger         │
│ - Chunk Idempotency (acked_chunks tracking)   │
│ - Dummy Tool Synth & Anti-Recursive Defense   │
│ - Native stdio MCP Server & Unified /everos   │
└───────────────────────────────────────────────┘
                       ▲
                       │ HTTP REST (Loopback)
                       ▼
┌───────────────────────────────────────────────┐
│ EverOS Cognitive Memory Runtime (:8000)       │
│ - LLM Distillation + LanceDB Vector Index     │
└───────────────────────────────────────────────┘
```

- **Zero Runtime Dependencies**: Strictly built on Node.js `>=20.0.0` built-in standard libraries (`node:fs`, `node:child_process`, `node:readline`, native `fetch` and `crypto`). No third-party npm packages to audit.
- **Fail-Open by Design**: If EverOS is offline, unreachable, or encounters an internal fault, hooks exit in milliseconds returning `{}`. Antigravity operates uninterrupted.
- **Two-Phase Commit (2PC) Ledger**: Local observation (`observed_turn_index`) advances independently of settlement (`settled_turn_index`). Includes client-side `acked_chunks` tracking to eliminate chunk duplication during retries.
- **Detached Startup Dispatch**: Replaces synchronous SessionStart blocking with an asynchronous detached worker process, reducing SessionStart execution from >15s to **~300ms**.
- **Windows 11 Natural Drain Protocol**: Strictly enforces `process.exitCode = 0` exit semantics over `process.exit(0)`, preventing stdout pipe truncation and empty JSON parse crashes on Windows.
- **Code Generic & JSX Safety**: Uses targeted regex stripping exclusively for `<everos_memory>` and `<everos_profile>`, preserving TypeScript generics (`Array<T>`) and JSX tags.

---

## 5. Dual-Language Semantic Anchors

The rendering engine features a dual-language anchor registry (toggled via `EVEROS_AG_LOCALE=zh` or `en`):

| Data Bucket | Chinese Anchor | English Anchor | Purpose |
|---|---|---|---|
| `explicit_info` | **【既定规约】** | **[Prescriptive Covenants]** | Hard architectural constraints and tech stack mandates (L1 Profile) |
| `implicit_traits` | **【意趣默契】** | **[Tacit Affinities]** | Inferred engineering style and coding habits (L1 Profile) |
| `agent_cases` | **【曾有范例】** | **[Erstwhile Exemplars]** | Troubleshooting postmortems and breakthrough solutions (L2 Ephemeral) |
| `episodes` | **【交互脉络】** | **[Interwoven Vestiges]** | Cross-session architectural evolution and decision history (L2 Ephemeral) |

---

## 6. Native MCP Server Tools & Skills Console

### 1. Autonomous Agent Tools (MCP Tools)
- `everos_search_memory`: Search historical engineering memories and troubleshooting cases.
- `everos_get_profile`: Retrieve developer profile (covenants and tacit affinities).
- `everos_add_memory`: Explicitly record a critical postmortem, decision, or convention.
- *(Note: Flush/Seal permissions are withheld from the LLM; sealing is reserved for lifecycle hooks and human developers).*

### 2. Unified Skills Console (`/everos`)
- **/everos status** (or bare `/everos`): Run diagnostics and inspect connection status, project partition, and active sessions.
- **/everos flush** (or `/everos-flush`): Manually trigger a 2PC seal on the most recent session for knowledge distillation.
- **/everos search <query>**: Interactively search engineering memory directly from the prompt line.

---

## 7. Configuration Reference

The plugin client adapter supports optional overrides via environment variables:

| Variable | Default | Description |
|---|---|---|
| `EVEROS_AG_BASE_URL` | `http://127.0.0.1:8000` | HTTP URL of the EverOS backend server |
| `EVEROS_AG_SEARCH_METHOD` | `keyword` | Retrieval mode (`keyword`, `vector`, `hybrid`) |
| `EVEROS_AG_PROJECT_ID` | Derived from Git Remote | Canonical project partition (Agent Track) |
| `EVEROS_AG_USER_ID` | System Username (`USERNAME`) | User identity partition (User Track) |
| `EVEROS_AG_LOCALE` | `zh` | Language for semantic anchors (`zh` or `en`) |
| `EVEROS_AG_DATA_DIR` | `~/.everos/antigravity` | Path for 2PC session state and index |
| `EVEROS_AG_RECALL_TIMEOUT_MS` | `5000` | Retrieval timeout ceiling (500~10000ms) |

---

## 8. Verification & Test Suite

The repository includes a comprehensive, dependency-free test harness:

```bash
# Run 16 manifest gate checks and 120 unit/integration tests
npm test

# Run isolated live verification suite simulating full IDE lifecycle
npm run verify:live
```

The test suite covers monotonic state merges, chunk retry ledgers, Windows path casing, pipe drain semantics, detached dispatch, and dual-track search fairness.

---

## License

Apache-2.0 © 2026 Sethyrial
