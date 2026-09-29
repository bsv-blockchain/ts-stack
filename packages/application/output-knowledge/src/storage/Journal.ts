import {
  canonicalOutputJSON,
  incrementOutputU64,
  outputHex32,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  closedOutputObject,
  type OutputJSONObject,
  Hash,
  Utils
} from '@bsv/sdk'
import type { CommitResult, Mutation, StoreRevision } from '../ports.js'

/** Storage adapters persist this journal before any asynchronous verification. */
export interface JournalEntry {
  key: string
  body: Mutation['body']
  revision: StoreRevision
  /** Locally validated replay material, never a provider-supplied attestation. */
  local?: OutputJSONObject
  localDigest?: string
}
export interface JournalHead extends StoreRevision {
  bytes: number
  entries: number
}
export type MutationLookup =
  | { status: 'committed'; entry: JournalEntry }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: string }
export interface JournalStorage {
  readonly durability: 'volatile' | 'durable'
  readonly namespace: string
  head(): Promise<JournalHead>
  getMutation(key: string): Promise<MutationLookup>
  append(
    expectedReceived: string,
    mutation: Mutation,
    local?: OutputJSONObject
  ): Promise<CommitResult>
  /** Strictly after received revision, bounded and in received-revision order. */
  read(afterReceived: string, maximumEntries: number): Promise<JournalEntry[]>
  close(): Promise<void>
}
export interface JournalLimits {
  bytes: number
  entries: number
  entryBytes: number
}
export const DEFAULT_JOURNAL_LIMITS: Readonly<JournalLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  entries: 4096,
  entryBytes: 4194304
})

export function journalLimits(options: Partial<JournalLimits>): JournalLimits {
  const limits = { ...DEFAULT_JOURNAL_LIMITS, ...options }
  for (const key of Object.keys(limits) as (keyof JournalLimits)[]) {
    if (
      !Object.hasOwn(DEFAULT_JOURNAL_LIMITS, key) ||
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > DEFAULT_JOURNAL_LIMITS[key]
    )
      throw new OutputProtocolError('invalid', 'Invalid journal limit')
  }
  return limits
}

export function mutationBody(
  mutation: Mutation,
  limits: JournalLimits
): { text: string; bytes: number } {
  outputHex32(mutation.key)
  const text = canonicalOutputJSON(mutation.body, { bytes: limits.entryBytes })
  return { text, bytes: new TextEncoder().encode(text).length }
}

/** Legacy body-only records remain readable; extensions are local storage frames. */
export function journalPayload(
  mutation: Mutation,
  limits: JournalLimits,
  local?: OutputJSONObject
): { text: string; bytes: number; bodyText: string } {
  const body = mutationBody(mutation, limits)
  if (local === undefined) return { ...body, bodyText: body.text }
  const text = canonicalOutputJSON(
    {
      storageFormat: 'output-knowledge-entry/1',
      body: mutation.body,
      local,
      localDigest: localJournalDigest(local)
    },
    { bytes: limits.entryBytes }
  )
  return { text, bytes: new TextEncoder().encode(text).length, bodyText: body.text }
}

function localJournalDigest(local: OutputJSONObject): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(`BRC192/local-replay/v1\0${canonicalOutputJSON(local)}`, 'utf8'))
  )
}

export function parseJournalPayload(
  text: string,
  maximumBytes = DEFAULT_JOURNAL_LIMITS.entryBytes
): Pick<JournalEntry, 'body' | 'local' | 'localDigest'> {
  const value = parseOutputJSON(text, { bytes: maximumBytes })
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new OutputProtocolError('unavailable', 'Invalid journal payload')
  if (Object.hasOwn(value, 'kind')) return { body: value as unknown as Mutation['body'] }
  closedOutputObject(value, ['storageFormat', 'body', 'local', 'localDigest'])
  if (value.storageFormat !== 'output-knowledge-entry/1')
    throw new OutputProtocolError('unsupported', 'Unknown journal storage frame')
  if (typeof value.local !== 'object' || value.local === null || Array.isArray(value.local))
    throw new OutputProtocolError('unavailable', 'Invalid local replay material')
  if (value.localDigest !== localJournalDigest(value.local))
    throw new OutputProtocolError('unavailable', 'Local journal integrity check failed')
  return {
    body: value.body as unknown as Mutation['body'],
    local: value.local,
    localDigest: value.localDigest as string
  }
}

export function journalEntryBytes(entry: JournalEntry): number {
  return journalPayload(entry, DEFAULT_JOURNAL_LIMITS, entry.local).bytes
}

export function planAppend(
  head: JournalHead,
  expected: string,
  mutation: Mutation,
  bytes: number,
  limits: JournalLimits
): CommitResult {
  outputU64(expected)
  if (head.received !== expected) return { status: 'conflict', reason: 'Received revision changed' }
  if (outputPacketDigest('knowledge-mutation', mutation.body) !== mutation.key)
    throw new OutputProtocolError('invalid', 'Mutation digest mismatch')
  if (head.entries >= limits.entries || head.bytes + bytes > limits.bytes)
    return { status: 'limited', reason: 'Journal retention limit; explicit reset required' }
  try {
    return {
      status: 'committed',
      revision: {
        received: incrementOutputU64(head.received),
        accepted:
          mutation.body.kind === 'receive' ? head.accepted : incrementOutputU64(head.accepted)
      }
    }
  } catch (error) {
    if (error instanceof OutputProtocolError && error.code === 'limited')
      return { status: 'limited', reason: error.message }
    throw error
  }
}

export function checkJournalRead(after: string, maximumEntries: number): void {
  outputU64(after)
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 4096)
    throw new OutputProtocolError('invalid', 'Invalid journal read bound')
}

export function cloneEntry(entry: JournalEntry): JournalEntry {
  if (
    entry.local === undefined
      ? entry.localDigest !== undefined
      : entry.localDigest !== localJournalDigest(entry.local)
  )
    throw new OutputProtocolError('unavailable', 'Local journal integrity check failed')
  // The enclosing storage row is local metadata and may slightly exceed the
  // protocol body limit; each body has already been independently bounded.
  return JSON.parse(
    JSON.stringify({
      key: entry.key,
      body: entry.body,
      revision: entry.revision,
      ...(entry.local !== undefined ? { local: entry.local, localDigest: entry.localDigest } : {})
    })
  ) as JournalEntry
}

/** Freeze trusted local provenance once and reuse this exact mutation on retry. */
export function knowledgeMutation(body: Mutation['body']): Mutation {
  const snapshot = JSON.parse(canonicalOutputJSON(body)) as Mutation['body']
  return { key: outputPacketDigest('knowledge-mutation', snapshot), body: snapshot }
}

/** Resolve an uncertain append before permitting another attempt of the same key. */
export async function appendJournalWithRecovery(
  storage: JournalStorage,
  expectedReceived: string,
  mutation: Mutation,
  local?: OutputJSONObject
): Promise<CommitResult> {
  const frozen: Mutation = {
    key: mutation.key,
    body: JSON.parse(canonicalOutputJSON(mutation.body)) as Mutation['body']
  }
  const ownedLocal =
    local === undefined ? undefined : (JSON.parse(canonicalOutputJSON(local)) as OutputJSONObject)
  try {
    return await storage.append(expectedReceived, frozen, ownedLocal)
  } catch (error) {
    // Input errors are definitive and are not storage uncertainty.
    if (error instanceof OutputProtocolError && !['unavailable', 'limited'].includes(error.code))
      throw error
    const saved = await storage.getMutation(frozen.key)
    if (saved.status === 'unavailable')
      throw new OutputProtocolError('unavailable', saved.reason, true)
    if (saved.status === 'absent') throw error
    if (canonicalOutputJSON(saved.entry.body) !== canonicalOutputJSON(frozen.body))
      return { status: 'equivocation', reason: 'Recovered mutation body differs' }
    return { status: 'replayed', revision: { ...saved.entry.revision } }
  }
}
