/** Lossless-enough DSH 0.2 event mapping for EverOS user and agent extraction. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { blocksToText } from './content.js'
import type { MessageItem, ToolCall } from './types.js'

export interface CaptureContext {
  userId: string
  agentId: string
  toolNames: ReadonlyMap<string, string>
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n[truncated by everos-memory]'
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

function boundedArguments(argumentsText: string, maxChars: number): string {
  if (argumentsText.length <= maxChars) return argumentsText
  return JSON.stringify({
    everos_truncated: true,
    preview: argumentsText.slice(0, Math.max(0, maxChars - 100)),
  })
}

function toolCalls(blocks: readonly ContentBlock[], maxChars: number): ToolCall[] | undefined {
  const calls = blocks.flatMap((block) => {
    if (block.type !== 'tool-call') return []
    return [
      {
        id: String(block.id),
        type: 'function',
        function: {
          name: block.name,
          arguments: boundedArguments(block.arguments, maxChars),
        },
      },
    ]
  })
  return calls.length === 0 ? undefined : calls
}

/** Record a tool name so its later result can be attributed. */
export function rememberToolCall(event: SessionEvent, toolNames: Map<string, string>): void {
  if (event.type !== 'tool/call') return
  toolNames.set(String(event.data.callId), event.data.name)
}

/**
 * Map one live DSH 0.2 session event to an EverOS message.
 *
 * Raw reasoning chunks and plugin-injected context are intentionally excluded.
 * Assistant tool calls and tool results are retained because EverOS uses them to
 * extract reusable agent cases and skills.
 */
export function mapSessionEvent(
  event: SessionEvent,
  context: CaptureContext,
  maxChars: number,
): MessageItem | undefined {
  const timestamp = Number.isSafeInteger(event.time) && event.time > 0 ? event.time : Date.now()

  switch (event.type) {
    case 'user/message': {
      if (event.data.source.kind !== 'user') return undefined
      const content = clipText(blocksToText(event.data.content), maxChars)
      if (!content) return undefined
      return {
        sender_id: context.userId,
        role: 'user',
        timestamp,
        content,
      }
    }

    case 'assistant/message': {
      const message = event.data.message
      const calls = toolCalls(message.content, maxChars)
      const content = clipText(blocksToText(message.content), maxChars)
      if (!content && !calls) return undefined
      return {
        sender_id: context.agentId,
        sender_name: `${message.source.provider}/${message.source.model}`,
        role: 'assistant',
        timestamp,
        content,
        ...(calls ? { tool_calls: calls } : {}),
      }
    }

    case 'tool/result': {
      const message = event.data.message
      const callId = String(message.toolCallId)
      const status = message.isError || event.data.error ? '[tool error]\n' : ''
      const content =
        clipText(`${status}${blocksToText(message.content)}`, maxChars).trim() ||
        '[empty tool result]'
      return {
        sender_id: context.agentId,
        sender_name: context.toolNames.get(callId) ?? 'tool',
        role: 'tool',
        timestamp,
        content,
        tool_call_id: callId,
      }
    }

    default:
      return undefined
  }
}
