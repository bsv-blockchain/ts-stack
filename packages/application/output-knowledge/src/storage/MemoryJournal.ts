import { OutputProtocolError, outputString, outputU64, type OutputJSONObject } from '@bsv/sdk'
import type { CommitResult, Mutation } from '../ports.js'
import {
  checkJournalRead,
  cloneEntry,
  journalLimits,
  journalPayload,
  parseJournalPayload,
  planAppend,
  type JournalEntry,
  type JournalHead,
  type JournalLimits,
  type JournalStorage,
  type MutationLookup
} from './Journal.js'

/** Volatile port implementation. It never advertises restart recovery. */
export class MemoryJournal implements JournalStorage {
  readonly durability = 'volatile' as const
  private readonly entries: JournalEntry[] = []
  private readonly keys = new Map<string, { entry: JournalEntry; text: string; bytes: number }>()
  private current: JournalHead = { received: '0', accepted: '0', bytes: 0, entries: 0 }
  private readonly limits: JournalLimits
  private closed = false

  constructor(
    readonly namespace: string,
    limits: Partial<JournalLimits> = {}
  ) {
    outputString(namespace)
    this.limits = journalLimits(limits)
  }
  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Journal is closed')
  }
  async head(): Promise<JournalHead> {
    this.ready()
    return { ...this.current }
  }
  async getMutation(key: string): Promise<MutationLookup> {
    this.ready()
    const saved = this.keys.get(key)
    return saved === undefined
      ? { status: 'absent' }
      : { status: 'committed', entry: cloneEntry(saved.entry) }
  }
  async append(
    expectedReceived: string,
    mutation: Mutation,
    local?: OutputJSONObject
  ): Promise<CommitResult> {
    this.ready()
    const body = journalPayload(mutation, this.limits, local)
    const previous = this.keys.get(mutation.key)
    if (previous !== undefined)
      return previous.text === body.bodyText
        ? { status: 'replayed', revision: { ...previous.entry.revision } }
        : { status: 'equivocation', reason: 'Mutation key reused with different body' }
    const result = planAppend(this.current, expectedReceived, mutation, body.bytes, this.limits)
    if (result.status !== 'committed') return result
    const entry: JournalEntry = {
      key: mutation.key,
      ...parseJournalPayload(body.text, this.limits.entryBytes),
      revision: { ...result.revision }
    }
    // There is no await between CAS and all writes: one synchronous commit.
    this.entries.push(entry)
    this.keys.set(entry.key, { entry, text: body.bodyText, bytes: body.bytes })
    this.current = {
      ...entry.revision,
      bytes: this.current.bytes + body.bytes,
      entries: this.current.entries + 1
    }
    return { status: 'committed', revision: { ...entry.revision } }
  }
  async read(afterReceived: string, maximumEntries: number): Promise<JournalEntry[]> {
    this.ready()
    checkJournalRead(afterReceived, maximumEntries)
    const after = outputU64(afterReceived)
    const result: JournalEntry[] = []
    let bytes = 0
    for (const entry of this.entries) {
      if (outputU64(entry.revision.received) <= after) continue
      const length = this.keys.get(entry.key)!.bytes
      if (
        result.length >= maximumEntries ||
        (result.length > 0 && bytes + length > this.limits.entryBytes)
      )
        break
      bytes += length
      result.push(cloneEntry(entry))
    }
    return result
  }
  async close(): Promise<void> {
    this.closed = true
  }
}
