// One real DSH turn against a fake EverOS, judged by what the fake received.
//
// The Session, SessionStore, AgentRegistry, and message factories are the
// installed DSH's own, so the host's shapes come from the host, not from this
// file. EverOS is a stub (no LLM, no storage): this checks only the DSH side of
// the plugin - hooks, Session reads, message shapes. scripts/host-matrix.sh runs
// it once per DSH version; scripts/e2e-everos.sh covers the EverOS side.
//
//   node host-check.mjs   -> prints PASS|FAIL and the received summary; exit 1 on FAIL
import http from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as llm from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as everosPlugin from '@everos-ai/dsh-plugin'

const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    const json = body ? JSON.parse(body) : undefined
    received.push({ path: req.url, body: json })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }))
    const route = req.url.split('/').pop()
    const data =
      route === 'search'
        ? {
            episodes: [
              { id: 'e1', subject: 'deploy key', summary: 'Ops rotates it', episode: '', score: 1 },
            ],
            profiles: [],
            agent_cases: [],
            agent_skills: [],
            unprocessed_messages: [],
          }
        : route === 'add'
          ? { message_count: json.messages.length, status: 'accumulated' }
          : { status: 'no_extraction' }
    res.end(JSON.stringify({ data }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const ctx = new Context()
await ctx.plugin(SessionStore)
// DSH 0.2.x AgentRegistry injects `sessionProjections`; 0.1.x has no such package.
try {
  const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
  await ctx.plugin(SessionProjectionRegistry)
} catch {}
await ctx.plugin(AgentRegistry)
await ctx.plugin(everosPlugin, {
  baseUrl: `http://127.0.0.1:${server.address().port}`,
  userId: 'host_check_user',
  autoStart: false,
})
await new Promise((resolve) => setTimeout(resolve, 200))
// cordis loads a plugin whose inject is unmet and silently never applies it.
if (!ctx.get('agents')) {
  console.log('HARNESS: agents service missing; the plugin was never applied')
  process.exit(2)
}

const session = ctx.sessions.prepare(SessionId('host-check'), { meta: { cwd: '/work/host-check' } })
const leave = ctx.sessions.enter(session)
ctx.sessions.announce(session)
const signal = new AbortController().signal
const agent = { id: session.id, session, ctx }

const user = llm.createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'Who rotates the deploy key?' }],
})
session.append('turn/start', { turn: 1 })
session.append('user/message', user, { surfaceOp: 'append' })
const decision = await ctx.events.waterfall(
  'agent/pre-step',
  { agent, messages: [user], turn: 1, step: 1, signal },
  async () => ({ kind: 'enter', messages: [user] }),
)
const injected = decision.messages.slice(1)
// The loop appends what pre-step admitted, so Session judges the recall message.
let recallAccepted = true
try {
  for (const message of injected) session.append('user/message', message, { surfaceOp: 'append' })
} catch (error) {
  recallAccepted = String(error)
}

const callId = 'call-1'
const assistant = (step, content) => ({
  turn: 1,
  step,
  message: llm.createAssistantMessage({ source: { provider: 'stub', model: 'stub' }, content }),
})
session.append(
  'assistant/message',
  assistant(1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }]),
  { surfaceOp: 'append' },
)
session.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' })
const result = llm.createToolResultMessage({
  callId,
  isError: false,
  content: [{ type: 'text', text: 'Ops rotates the key every Tuesday' }],
})
session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append' })
session.append('assistant/message', assistant(2, [{ type: 'text', text: 'Ops does.' }]), {
  surfaceOp: 'append',
})
session.append('turn/end', { turn: 1, reason: 'completed' })

await ctx.events.serial('agent/turn-stopping', { agent, turn: 1, signal })
leave() // disposes the announced session -> the plugin seals and flushes it
await new Promise((resolve) => setTimeout(resolve, 1500))

const ofRoute = (route) => received.filter((r) => r.path.endsWith(`/memory/${route}`))
const added = ofRoute('add').flatMap((r) => r.body.messages)
const tool = added.find((m) => m.role === 'tool')
const summary = {
  searches: ofRoute('search').length,
  recallInjected: injected.length,
  recallAccepted,
  addedRoles: added.map((m) => m.role).join(','),
  assistantToolCall: added.find((m) => m.tool_calls)?.tool_calls[0]?.id,
  toolResult: tool && `${tool.tool_call_id}|${tool.sender_name}|${tool.content}`,
  flushes: ofRoute('flush').length,
}
const pass =
  summary.searches === 2 &&
  summary.recallInjected === 1 &&
  summary.recallAccepted === true &&
  summary.addedRoles === 'user,assistant,tool,assistant' &&
  summary.assistantToolCall === callId &&
  summary.toolResult === `${callId}|read_file|Ops rotates the key every Tuesday` &&
  summary.flushes === 1
console.log(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(summary)}`)
server.close()
process.exit(pass ? 0 : 1)
