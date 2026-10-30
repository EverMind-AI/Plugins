/** Declares the EverOS recall context source on the DSH message-source map. */

import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'everos-memory': {
      readonly kind: 'everos-memory'
      readonly form: 'recall'
    }
  }
}

export const MEMORY_SOURCE_KIND = 'everos-memory' as const
