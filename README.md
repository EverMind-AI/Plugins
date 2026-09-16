# EverMind AI — Integrations

Official host and workflow integrations for
[EverOS](https://github.com/EverMind-AI/EverOS), the md-first memory framework.
They connect agents and applications to persistent, cross-session memory —
**one EverOS, many agents**: the same store serves every host, partitioned per
app.

## Plugins

| Plugin | Host | Install | Status |
|---|---|---|---|
| [`openclaw/`](./openclaw) | [OpenClaw](https://docs.openclaw.ai) | [`@everos-ai/openclaw-plugin`](https://www.npmjs.com/package/@everos-ai/openclaw-plugin) on npm — one-command setup: `npx --yes --package @everos-ai/openclaw-plugin everos-setup` | 🚚 scope move — first `@everos-ai` publish pending (previously `@evermind-ai/openclaw-plugin`, 3.0.2) |
| [`claude-code/`](./claude-code) | [Claude Code](https://code.claude.com) | `claude plugin marketplace add EverMind-AI/Plugins` then `claude plugin install everos@everos --scope user` | 🧪 built — pre-release verification |
| [`hermes/`](./hermes) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `hermes plugins install EverMind-AI/plugins/hermes` | 🧪 built — pre-release verification |
| [`dsh/`](./dsh) | [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) | `dsh plugin --profile web add @everos-ai/dsh-plugin` | 🧪 built — pre-release verification |
| [`dify/`](./dify) | [Dify](https://dify.ai) | Package with the Dify CLI, then upload the `.difypkg` in Dify | 🧪 built — Marketplace submission pending |
| [`dify_cloud/`](./dify_cloud) | [Dify](https://dify.ai) | Configure an EverOS Cloud API URL and API Key after installation | 🧪 built — Marketplace submission pending |

## Integration models

- **Agent hosts** such as Claude Code, OpenClaw, Hermes, and DSH automate the
  recall → capture → seal lifecycle and fail open when EverOS is unavailable.
- **Workflow platforms** such as Dify expose explicit search and add tools, so
  builders decide exactly where memory runs in a workflow.

Each integration's own README documents its lifecycle, setup, security model,
and troubleshooting.

## EverMind Ecosystem

EverMind connects memory research, production-ready products, and practical
integrations into one open-source ecosystem.

<table>
<tr>
<th colspan="2">Products</th>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverOS">EverOS</a></strong></td>
<td>A local-first, Markdown-native long-term memory runtime for agents and users.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/Raven">Raven</a></strong></td>
<td>A memory-first, self-improving agent harness with proactivity, context control, and skill evolution.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverMe">EverMe (CLI)</a></strong></td>
<td>A CLI and agent plugin suite for cross-device, cross-agent personal memory.</td>
</tr>
<tr>
<th colspan="2">Research &amp; Evaluation</th>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/SkillCorpus">SkillCorpus</a></strong></td>
<td>Curated, retrieval-ready agent skill corpora with retrieval and evaluation tooling.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverAlgo">EverAlgo</a></strong></td>
<td>Stateless extraction, ranking, parsing, and memory operators that power EverOS.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/HyperMem">HyperMem</a></strong></td>
<td>Hypergraph-based hierarchical memory for coarse-to-fine long-term conversation retrieval.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/MSA">MSA</a></strong></td>
<td>Memory Sparse Attention for scalable latent memory and 100M-token contexts.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EverMemBench">EverMemBench</a></strong></td>
<td>Evaluation of factual recall, applied reasoning, and personalized generalization in memory systems.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/EverMind-AI/EvoAgentBench">EvoAgentBench</a></strong></td>
<td>Longitudinal evaluation of agent self-evolution, transfer efficiency, error avoidance, and skill use.</td>
</tr>
<tr>
<th colspan="2"><a href="https://github.com/EverMind-AI/plugins">Integrations</a></th>
</tr>
<tr>
<td><strong><a href="https://code.claude.com">Claude Code</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/claude-code">Claude Code plugin</a> for automatic recall, full-trajectory capture, and session sealing.</td>
</tr>
<tr>
<td><strong><a href="https://docs.openclaw.ai">OpenClaw</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/openclaw">OpenClaw plugin</a> for automatic recall, capture, and session-memory lifecycle management.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/hermes">Hermes plugin</a> for persistent memory across Hermes sessions.</td>
</tr>
<tr>
<td><strong><a href="https://github.com/deepseek-ai/DeepSeek-Harness">DeepSeek Harness</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/dsh">DSH plugin</a> for memory-aware DeepSeek Harness agents.</td>
</tr>
<tr>
<td><strong><a href="https://dify.ai">Dify</a></strong></td>
<td><a href="https://github.com/EverMind-AI/plugins/tree/main/dify">Self-hosted</a> and <a href="https://github.com/EverMind-AI/plugins/tree/main/dify_cloud">cloud</a> tools for explicit memory search and storage in workflows and agents.</td>
</tr>
</table>

Together, these projects form EverMind's research-to-runtime stack: methods
and benchmarks become reusable memory infrastructure, products, and agent
integrations.

## License

[Apache-2.0](./LICENSE)
