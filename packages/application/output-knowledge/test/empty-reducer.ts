import { OutputProtocolError } from '@bsv/sdk'
import type { KnowledgeReducer } from '../src/KnowledgeStore.js'
import type { Currentness, JournalEntry, VerificationContext } from '../src/index.js'

/** Storage-port tests use an empty-state reducer; cryptographic runtime qualification is separate. */
export function emptyReducer(
  options: {
    before?: (entries: readonly JournalEntry[], signal: AbortSignal) => Promise<void>
    assessments?: Currentness[]
  } = {}
): KnowledgeReducer {
  return {
    async reduce(entries, signal) {
      await options.before?.(entries, signal)
      let current: VerificationContext | undefined
      for (const entry of entries) if (entry.body.kind === 'context') current = entry.body.context
      if (!current) throw new OutputProtocolError('invalid', 'Initial context required')
      const revision = entries.at(-1)!.revision
      return {
        partition: current.partition,
        generation: current.generation,
        context: current,
        revision,
        observations: [],
        facts: [],
        assessments: options.assessments ?? [],
        pendingGroups: [],
        reconciled: {
          profile: 'https://bsv.brc.dev/apps/0192#bitcoin-spend-reconciliation-v1',
          nonFinal: false,
          journalId: 'test',
          through: revision.received,
          contextId: current.id,
          transactions: [],
          memberships: [],
          replacements: [],
          pendingComponents: []
        }
      }
    }
  }
}
