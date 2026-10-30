import assert from 'node:assert/strict'
import test from 'node:test'

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { mapSessionEvent, rememberToolCall } from '../src/capture.js'
import { resolveConfig } from '../src/config.js'
import type { EverosClient } from '../src/everos-client.js'
import { estimateMessageTokens, MemoryRuntime } from '../src/memory-runtime.js'
import type { AddRequest, FlushRequest, PluginLogger } from '../src/types.js'

function fakeSession(id = 'session-1', cwd = '/work/repository'): Session {
  return {
    id,
    header: { version: 4, id, createdAt: 1, cwd, agentPreset: 'coding' },
  } as unknown as Session
}

function event(type: string, seq: number, time: number, data: unknown): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** One committed turn: direct user text, plugin recall context, assistant tool call, and tool result. */
function fixtureEvents(): SessionEvent[] {
  return [
    event('user/message', 0, 10, {
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Fix the parser' }],
    }),
    event('user/message', 1, 11, {
      id: 'memory',
      role: 'user',
      source: { kind: 'everos-memory', form: 'recall' },
      content: [{ type: 'text', text: 'recalled data' }],
    }),
    event('assistant/message', 2, 12, {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'v4' },
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"x"}' },
        ],
      },
    }),
    event('tool/call', 3, 13, {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'read_file',
      arguments: '{}',
    }),
    event('tool/result', 4, 14, {
      turn: 1,
      step: 1,
      message: {
        id: 't1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'file contents' }],
      },
    }),
  ]
}

function clientSpy(): {
  client: EverosClient
  adds: AddRequest[]
  flushes: FlushRequest[]
} {
  const adds: AddRequest[] = []
  const flushes: FlushRequest[] = []
  const client: EverosClient = {
    async health() {
      return { status: 'ok' }
    },
    async add(request) {
      adds.push(request)
      return { message_count: request.messages.length, status: 'accumulated' }
    },
    async search() {
      return {
        episodes: [],
        profiles: [],
        agent_cases: [],
        agent_skills: [],
        unprocessed_messages: [],
      }
    },
    async flush(request) {
      flushes.push(request)
      return { status: 'extracted' }
    },
    resolvedApiVersion() {
      return 'v2'
    },
  }
  return { client, adds, flushes }
}

const logger: PluginLogger = { info() {}, warn() {} }

test('maps direct user, assistant tool call, and DSH 0.2 tool result without reasoning echoes', () => {
  const toolNames = new Map<string, string>()
  const fixture = fixtureEvents()
  for (const entry of fixture) rememberToolCall(entry, toolNames)
  const context = { userId: 'alice', agentId: 'dsh-coding', toolNames }
  const items = fixture
    .map((entry) => mapSessionEvent(entry, context, 10_000))
    .filter((item): item is NonNullable<ReturnType<typeof mapSessionEvent>> => item !== undefined)

  assert.equal(items.length, 3)
  assert.deepEqual(
    items.map((item) => item.role),
    ['user', 'assistant', 'tool'],
  )
  assert.equal(items[1]?.content, 'I will inspect it.')
  assert.equal(items[1]?.tool_calls?.[0]?.function.name, 'read_file')
  assert.equal(items[2]?.tool_call_id, 'call-1')
  assert.equal(items[2]?.sender_name, 'read_file')
  assert.equal(items[2]?.content, 'file contents')
  assert.doesNotMatch(JSON.stringify(items), /private reasoning/u)
})

test('token estimate treats CJK more conservatively than ASCII', () => {
  const base = { sender_id: 'alice', role: 'user' as const, timestamp: 1 }
  assert.equal(estimateMessageTokens({ ...base, content: 'abcdefghijkl' }), 3)
  assert.equal(estimateMessageTokens({ ...base, content: '请记住这个偏好' }), 7)
})

test('runtime captures incrementally from the event feed and seals after the pending queue', async () => {
  const { client, adds, flushes } = clientSpy()
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({ autoStart: false }),
    userId: 'alice',
    logger,
  })
  const session = fakeSession()

  for (const entry of fixtureEvents()) runtime.feed(session, entry)
  await runtime.capture(session)
  await runtime.capture(session)
  assert.equal(adds.length, 1)
  assert.equal(adds[0]?.messages.length, 3)
  assert.equal(adds[0]?.defer_extraction, true)

  runtime.feed(
    session,
    event('assistant/message', 5, 15, {
      turn: 1,
      step: 2,
      message: {
        id: 'a2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'v4' },
        content: [{ type: 'text', text: 'The parser is fixed.' }],
      },
    }),
  )
  await runtime.seal(session)

  assert.equal(adds.length, 2)
  assert.equal(adds[1]?.messages.length, 1)
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0]?.session_id, 'session-1')
})

test('runtime splits the 500-message API limit', async () => {
  const { client, adds } = clientSpy()
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({
      autoStart: false,
      flushMessageThreshold: 1_000,
      flushTokenThreshold: 1_000_000,
    }),
    userId: 'alice',
    logger,
  })
  const session = fakeSession('resumed-session')

  for (let seq = 0; seq < 506; seq += 1) {
    runtime.feed(
      session,
      event('user/message', seq, seq + 1, {
        id: `u-${seq}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `message ${seq}` }],
      }),
    )
  }
  await runtime.capture(session)

  assert.deepEqual(
    adds.map((request) => request.messages.length),
    [500, 6],
  )
  assert.equal(adds[0]?.messages[0]?.content, 'message 0')
  assert.equal(adds[1]?.messages[0]?.content, 'message 500')
  await runtime.seal(session)
})

test('runtime flushes immediately at the configured batch threshold', async () => {
  const { client, flushes } = clientSpy()
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({
      autoStart: false,
      flushMessageThreshold: 3,
      flushTokenThreshold: 1_000_000,
    }),
    userId: 'alice',
    logger,
  })

  for (const entry of fixtureEvents()) runtime.feed(fakeSession(), entry)
  await runtime.capture(fakeSession())

  assert.equal(flushes.length, 1)
})

test('runtime debounce-flushes after the configured idle window', async () => {
  const { client, flushes } = clientSpy()
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({
      autoStart: false,
      flushIdleMs: 10,
      flushMaxDelayMs: 1_000,
      flushMessageThreshold: 100,
      flushTokenThreshold: 1_000_000,
    }),
    userId: 'alice',
    logger,
  })
  const session = fakeSession()

  for (const entry of fixtureEvents()) runtime.feed(session, entry)
  await runtime.capture(session)
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(flushes.length, 1)
})

test('failed background flush is rearmed instead of losing the pending batch', async () => {
  const { adds } = clientSpy()
  let attempts = 0
  const client = {
    async add(request: AddRequest) {
      return { message_count: request.messages.length, status: 'accumulated' as const }
    },
    async flush() {
      attempts += 1
      if (attempts === 1) throw new Error('temporary failure')
      return { status: 'extracted' as const }
    },
  } as unknown as EverosClient
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({
      autoStart: false,
      flushIdleMs: 10,
      flushMaxDelayMs: 1_000,
      flushMessageThreshold: 100,
      flushTokenThreshold: 1_000_000,
    }),
    userId: 'alice',
    logger,
  })

  for (const entry of fixtureEvents()) runtime.feed(fakeSession(), entry)
  await runtime.capture(fakeSession())
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(attempts, 2)
  void adds
})

test('new session recall waits for pending sessions in the same workspace', async () => {
  const { client, flushes } = clientSpy()
  const runtime = new MemoryRuntime({
    client,
    config: resolveConfig({
      autoStart: false,
      flushIdleMs: 60_000,
      flushMessageThreshold: 100,
      flushTokenThreshold: 1_000_000,
    }),
    userId: 'alice',
    logger,
  })
  const previous = fakeSession('session-previous')
  const current = fakeSession('session-current')

  for (const entry of fixtureEvents()) runtime.feed(previous, entry)
  await runtime.capture(previous)
  assert.equal(flushes.length, 0)

  await runtime.flushBeforeRecall(current)

  assert.deepEqual(
    flushes.map((request) => request.session_id),
    ['session-previous'],
  )
})
