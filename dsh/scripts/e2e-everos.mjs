// One DSH session against a real EverOS, driven through real cordis.
//
// The plugin under test is the PACKED artifact installed into node_modules,
// not ../src: what npm would ship is what this runs. The Session is a real
// @deepseek-ai/dsh-session Session and the three lifecycle points are dispatched
// through real cordis events, so nothing here defines the host's shapes for it.
//
//   node e2e-everos.mjs store   - state a fact, capture the turn, seal
//   node e2e-everos.mjs recall  - fresh session, ask for it back
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as everosPlugin from '@everos-ai/dsh-plugin'

const BASE = process.env.DSH_E2E_BASE ?? 'http://127.0.0.1:8892'
const USER = process.env.DSH_E2E_USER ?? 'dsh_e2e_user'
const CWD = process.env.DSH_E2E_CWD ?? '/work/dsh-e2e-project'
const FACT = process.env.DSH_E2E_FACT ?? 'the staging cluster deploy key is rotated every Tuesday, and Ops owns that rotation'
const PHASE = process.argv[2] ?? 'store'

const ctx = new Context()
// The plugin declares inject = ['agents']. Without that service cordis loads it
// and never applies it: no listeners, no requests, and nothing says so.
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(everosPlugin, { baseUrl: BASE, userId: USER, autoStart: false })
await new Promise((r) => setTimeout(r, 200))

const session = ctx.sessions.prepare(SessionId(`dsh-e2e-${PHASE}`), { meta: { cwd: CWD } })
const leave = ctx.sessions.enter(session)
// session/disposed fires only for an ANNOUNCED session. enter + leave alone is
// silent, and the seal would never run - a green run that sealed nothing.
ctx.sessions.announce(session)

const prompt =
  PHASE === 'store'
    ? `Remember this: ${FACT}.`
    : 'Who owns the staging deploy key rotation, and on which day?'
// payload.messages is UserMessage[] by the host's contract. Do not pass
// session.deriveMessages(): that is Message[], and its assistant entries carry
// no `source`, which is not what this hook is handed.
const first = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }

session.append('turn/start', { turn: 1 })
session.append('user/message', first, { surfaceOp: 'append' })

const signal = new AbortController().signal
const agent = { id: session.id, session, ctx }

const decision = await ctx.events.waterfall(
  'agent/pre-step',
  { agent, messages: [first], turn: 1, step: 1, signal },
  async () => ({ kind: 'enter', messages: [first] }),
)
const injected = decision.messages.length - 1
console.log(`INJECTED=${injected}`)
if (injected > 0) console.log(`INJECTED_TEXT=${JSON.stringify(decision.messages.at(-1))}`)

session.append(
  'assistant/message',
  { turn: 1, step: 1,
    message: { id: 'a1', role: 'assistant', source: { kind: 'model' },
      content: [{ type: 'text', text: PHASE === 'store' ? 'Understood.' : 'Answering.' }] } },
  { surfaceOp: 'append' },
)
session.append('turn/end', { turn: 1, reason: 'completed' })

await ctx.events.serial('agent/turn-stopping', { agent, turn: 1, signal })
leave()
await new Promise((r) => setTimeout(r, 4000))
console.log('DONE')
