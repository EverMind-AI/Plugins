/** Convert model-visible content blocks to plain text without exposing attachments. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export function blocksToText(blocks: readonly ContentBlock[], includeReasoning = false): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        if (includeReasoning) parts.push(`[reasoning]\n${block.text}`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push('[file]')
        break
      default:
        break
    }
  }
  return parts.filter(Boolean).join('\n').trim()
}
