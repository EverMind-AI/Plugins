/** The DSH 0.1.x / 0.2.x differences this plugin has to read across. */

import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The event-read member DSH 0.2 added in place of the `events` accessor.
 *
 * Declared structurally instead of imported: this package compiles against the
 * 0.1.x type surface, which has no such member, and probing it at runtime is
 * what lets one build serve both lines.
 */
interface SnapshotCapableSession {
  snapshotEvents?: () => readonly SessionEvent[]
}

/**
 * The session's full immutable event log.
 *
 * DSH 0.1.x exposed the whole append-only log as `session.events`. 0.2 removed
 * that accessor for `snapshotEvents()`, documented as the same immutable
 * snapshot reused until the next append — the same read, so callers do not
 * branch on the harness version.
 *
 * @param session - the session to read.
 * @returns the session's events in log order.
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const snapshotEvents = (session as Session & SnapshotCapableSession).snapshotEvents
  if (typeof snapshotEvents === 'function') return snapshotEvents.call(session)
  return session.events
}

/** One tool result's correlation, failure flag, and model-facing blocks. */
export interface ToolResultFields {
  /** Provider-issued id of the tool call this result answers. */
  callId: string
  /** Whether the tool invocation failed. */
  isError: boolean
  /** The result content a model would see. */
  blocks: readonly ContentBlock[]
}

/**
 * Read a tool result across both DSH message shapes.
 *
 * 0.1.x carried the correlation and the error flag on a `tool-result` content
 * block and nested the result blocks inside it. 0.2 removed that block: the
 * message is `role: 'tool'`, `toolCallId` and `isError` sit on the message
 * itself, and `content` holds the result blocks directly.
 *
 * Both readings agree on `content`, so only the two scalar fields differ.
 *
 * @param message - the tool-role message carried by a `tool/result` event.
 * @returns the call id, error flag, and result blocks.
 */
export function toolResultFields(message: ToolResultMessage): ToolResultFields {
  const block = message.content[0]
  if (block?.type === 'tool-result') {
    return {
      callId: String(block.toolCallId),
      isError: Boolean(block.isError),
      blocks: block.content,
    }
  }
  const current = message as ToolResultMessage & { toolCallId?: string; isError?: boolean }
  return {
    callId: String(current.toolCallId ?? message.source.callId ?? ''),
    isError: Boolean(current.isError),
    blocks: message.content,
  }
}
