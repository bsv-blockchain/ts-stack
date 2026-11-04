import type { LookupIndexStorage } from './LookupIndexStorage.js'

/**
 * Provider-facing versioned feed. The domain owner retains mutation, retention,
 * compaction and close authority. Time advancement performs bounded domain timer
 * work before reporting a complete watermark; it is not an unrestricted write.
 */
export type LookupIndexFeed = Pick<
  LookupIndexStorage,
  | 'durability'
  | 'namespace'
  | 'configuration'
  | 'head'
  | 'group'
  | 'advanceTime'
  | 'snapshot'
  | 'changes'
>
