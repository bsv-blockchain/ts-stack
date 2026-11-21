import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { assertIsoDate } from './Brc38PortableRows'
import {
  compareBrc38StructuredStringSequences,
  inspectBrc38StructuredScalarSpan,
  stringifyBrc38StructuredJsonSpan,
  verifyBrc38StructuredSourceDigest,
  visitBrc38StructuredJsonValues,
  type Brc38JsonMember,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured,
  type Brc38StructuredStringComparePolicy,
  type Brc38StructuredStringPart
} from './Brc38StructuredJson'

export interface Brc38StreamedHistoryProjectionPolicy {
  readonly maximumTemporaryIndexBytes: number
  readonly maximumMembers: number
  readonly maximumOutputBytes: number
  readonly maximumIndexAllocationBytes?: number
  readonly maximumGrammarAllocationBytes?: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly maximumReadBytes: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
interface NoteRef {
  source: 0 | 1
  ordinal: number
  start: number
  end: number
  when?: string
}
interface NoteStore {
  refs: Brc38JsonMemberIndex
  properties: Brc38JsonMemberIndex
  count: number
}
function reject(): never {
  throw new TypeError('Private request-history note or sort record differs')
}
const validInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
/** External selection and stable merge sort for EntityProvenTxReq.mergeHistory.
 * Existing duplicates survive; an older note's primitive properties form the
 * asymmetric subset predicate used by addHistoryNote. Parsed containers never
 * compare equal across distinct notes. Every span/rank here is DATA; concrete
 * hosts retain source/profile/current-row and final writer responsibilities. */
export class Brc38StreamedHistoryProjection {
  #closed = false
  #consumed = false
  #measured = false
  #measurementEnded = false
  #iterator?: AsyncGenerator<Uint8Array>
  #closing?: Promise<void>
  #active: Promise<void> = Promise.resolve()
  private constructor(
    private readonly output: Brc38JsonMemberIndex,
    private readonly sources: readonly Brc38StreamedStructured[],
    readonly noteCount: number,
    readonly addedNotes: number,
    readonly incomingNotes: number,
    private readonly policy: Readonly<Brc38StreamedHistoryProjectionPolicy>,
    private readonly checkActor: () => void,
    private readonly deadline: number,
    private readonly reservation: Brc38WorkingCharge,
    private readonly openSpellingIndex: () => Promise<Brc38JsonMemberIndex>
  ) {}

  static async prepare(
    selectedOwners: Brc38StructuredProjectionOwners,
    selectedIncoming: Brc38StreamedStructured,
    selected: Brc38StreamedHistoryProjectionPolicy,
    selectedExisting: Brc38StreamedStructured,
    incomingDefaultWhen?: string
  ): Promise<Brc38StreamedHistoryProjection> {
    const owners = Object.freeze({ ...selectedOwners }),
      policy = Object.freeze({ ...selected, workingAllocation: brc38WorkingAllocation(selected.workingAllocation) }),
      sources = Object.freeze([Object.freeze({ ...selectedExisting }), Object.freeze({ ...selectedIncoming })]),
      lifetime = policy.expiresAt - Date.now(),
      deadline = performance.now() + lifetime
    // Portable import supplies the actual archived request timestamp so the
    // same missing-time note is stable across repeat imports and recovery.
    // Existing sync callers omit it and retain their historical clock policy.
    if (incomingDefaultWhen !== undefined) assertIsoDate(incomingDefaultWhen, 'request history default timestamp')
    if (
      policy.workingAllocation === undefined ||
      !validInteger(policy.expiresAt, 0, Number.MAX_SAFE_INTEGER) ||
      lifetime < 1 ||
      lifetime > 3600000 ||
      !validInteger(policy.maximumTemporaryIndexBytes, 6291456, 17179869184) ||
      !validInteger(policy.maximumMembers, 1, 2000000000) ||
      !validInteger(policy.maximumOutputBytes, 2, 1000000000) ||
      !validInteger(policy.maximumReadBytes, 64, 65536) ||
      (policy.maximumIndexAllocationBytes !== undefined &&
        !validInteger(policy.maximumIndexAllocationBytes, 4096, 16777216)) ||
      (policy.maximumGrammarAllocationBytes !== undefined &&
        !validInteger(policy.maximumGrammarAllocationBytes, 4096, 16777216))
    )
      throw new RangeError('Invalid original private request-history projection policy')
    const check = (): void => {
      policy.signal?.throwIfAborted()
      owners.check()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Private request-history projection reached its original deadline')
    }
    check()
    const reservation = policy.workingAllocation.claim(16384),
      owned = new Set<Brc38JsonMemberIndex>(),
      failures = new Set<Brc38StagingCleanupError>(),
      maximumSource = Math.max(32, ...sources.map(source => source.length)),
      indexPolicy = Object.freeze({
        sourceBytes: maximumSource,
        maximumTemporaryIndexBytes: Math.floor(policy.maximumTemporaryIndexBytes / 6),
        maximumTemporaryPhysicalBytes: Math.floor(policy.maximumTemporaryIndexBytes / 6),
        maximumMembers: policy.maximumMembers,
        maximumAllocationBytes: policy.maximumIndexAllocationBytes,
        workingAllocation: policy.workingAllocation,
        expiresAt: policy.expiresAt,
        signal: policy.signal
      }),
      grammarPolicy = Object.freeze({
        maximumInputBytes: 1000000000,
        maximumOutputBytes: 1000000000,
        maximumChunkBytes: policy.maximumReadBytes,
        maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
        workingAllocation: policy.workingAllocation,
        signal: policy.signal
      }),
      comparePolicy: Brc38StructuredStringComparePolicy = Object.freeze({
        maximumInputBytes: 1000000000,
        maximumDecodedCodeUnits: 1000000000,
        maximumReadBytes: policy.maximumReadBytes,
        maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
        workingAllocation: policy.workingAllocation,
        expiresAt: policy.expiresAt,
        signal: policy.signal,
        check
      })
    const open = async (): Promise<Brc38JsonMemberIndex> => {
        check()
        const index = await owners.openIndex(indexPolicy)
        owned.add(index)
        check()
        return index
      },
      closeIndex = async (index: Brc38JsonMemberIndex): Promise<void> => {
        await index.close()
        owned.delete(index)
      },
      cleanup = async (): Promise<void> => {
        const causes: unknown[] = []
        for (const index of owned)
          try {
            await closeIndex(index)
          } catch (cause) {
            causes.push(cause)
          }
        for (const failure of failures)
          try {
            await failure.retryCleanup()
            failures.delete(failure)
          } catch (cause) {
            causes.push(cause)
          }
        if (causes.length !== 0)
          throw new Brc38StagingCleanupError(
            causes,
            'Private request-history selection retains actual physical indexes',
            cleanup
          )
        reservation.close()
      }
    try {
      const stores: NoteStore[] = []
      for (const sourceId of [0, 1] as const) {
        const refs = await open(),
          properties = await open(),
          store: NoteStore = { refs, properties, count: 0 }
        stores.push(store)
        let note: { ordinal: number; start: number; what: boolean; whenTruthy: boolean } | undefined
        const inNote = (path: readonly (string | number)[]): boolean =>
          path.length === 3 && path[0] === 'notes' && note !== undefined && path[1] === note.ordinal
        await visitBrc38StructuredJsonValues(sources[sourceId], grammarPolicy, {
          enter: (path, kind, offset) => {
            check()
            if (path.length === 1 && path[0] === 'notes' && kind !== 'array' && kind !== 'null') reject()
            if (path.length === 2 && path[0] === 'notes') {
              if (
                kind !== 'object' ||
                path[1] !== store.count ||
                note !== undefined ||
                store.count >= policy.maximumMembers
              )
                reject()
              note = { ordinal: store.count, start: offset, what: false, whenTruthy: false }
            }
            if (inNote(path) && path[2] === 'what') {
              if (kind !== 'string') reject()
              note!.what = true
            }
            if (inNote(path) && path[2] === 'when') {
              // Incoming archive dates are validated independently by source
              // admission. Legacy current dates may be primitive spellings.
              if (kind === 'object' || kind === 'array') note!.whenTruthy = true
            }
          },
          member: async (path, member) => {
            check()
            if (inNote(path)) await properties.put(note!.start, { ...member })
            check()
          },
          text: (path, value) => {
            check()
            if (inNote(path) && path[2] === 'when' && value.length !== 0) note!.whenTruthy = true
          },
          number: (path, value) => {
            check()
            if (inNote(path) && path[2] === 'when' && value !== 0) note!.whenTruthy = true
          },
          boolean: (path, value) => {
            check()
            if (inNote(path) && path[2] === 'when' && value) note!.whenTruthy = true
          },
          end: async (path, end) => {
            check()
            if (path.length === 2 && path[0] === 'notes') {
              if (note === undefined || path[1] !== note.ordinal || !note.what) reject()
              const ref: NoteRef = { source: sourceId, ordinal: note.ordinal, start: note.start, end }
              if (sourceId === 1 && !note.whenTruthy) ref.when = incomingDefaultWhen ?? new Date().toISOString()
              await Brc38StreamedHistoryProjection.put(refs, store.count++, ref, maximumSource)
              note = undefined
            }
            check()
          }
        })
        if (note !== undefined) reject()
        check()
        await refs.seal()
        await properties.seal()
        check()
      }
      const lookup = async (ref: NoteRef, key: string): Promise<Brc38JsonMember | undefined> => {
          check()
          const index = stores[ref.source].properties
          if (index.lookup === undefined) throw new Error('Request-history properties require actual indexed lookup')
          const result = await index.lookup(ref.start, key)
          check()
          return result
        },
        primitive = async (ref: NoteRef, member: Brc38JsonMember) =>
          await inspectBrc38StructuredScalarSpan(sources[ref.source], member, comparePolicy),
        equalProperty = async (older: NoteRef, candidate: NoteRef, member: Brc38JsonMember): Promise<boolean> => {
          const oldDefault = member.key === 'when' ? older.when : undefined,
            newDefault = member.key === 'when' ? candidate.when : undefined,
            other = await lookup(candidate, member.key)
          if (other === undefined && newDefault === undefined) return false
          const a = oldDefault === undefined ? await primitive(older, member) : undefined,
            b = newDefault === undefined ? await primitive(candidate, other!) : undefined
          check()
          if (oldDefault !== undefined || a?.kind === 'string') {
            if (newDefault === undefined && b?.kind !== 'string') return false
            return (
              (await compareBrc38StructuredStringSequences(
                [oldDefault !== undefined ? { literal: oldDefault } : { source: sources[older.source], span: member }],
                [
                  newDefault !== undefined
                    ? { literal: newDefault }
                    : { source: sources[candidate.source], span: other! }
                ],
                comparePolicy
              )) === 0
            )
          }
          if (newDefault !== undefined || a?.kind !== b?.kind) return false
          if ((a?.kind === 'number' && b?.kind === 'number') || (a?.kind === 'boolean' && b?.kind === 'boolean'))
            return a.value === b.value
          return a?.kind === 'null' && b?.kind === 'null'
        },
        subset = async (older: NoteRef, candidate: NoteRef): Promise<boolean> => {
          let sawWhen = false
          for await (const member of stores[older.source].properties.entries(older.start)) {
            check()
            if (member.key === 'when') sawWhen = true
            if (!(await equalProperty(older, candidate, member))) return false
          }
          if (older.when !== undefined && !sawWhen) {
            const other = await lookup(candidate, 'when')
            if (candidate.when !== undefined) return older.when === candidate.when
            if (other === undefined || (await primitive(candidate, other)).kind !== 'string') return false
            return (
              (await compareBrc38StructuredStringSequences(
                [{ literal: older.when }],
                [{ source: sources[candidate.source], span: other }],
                comparePolicy
              )) === 0
            )
          }
          check()
          return true
        }
      let output = await open(),
        count = 0,
        added = 0
      for (let position = 0; position < stores[0].count; position++) {
        check()
        await Brc38StreamedHistoryProjection.put(
          output,
          count++,
          await Brc38StreamedHistoryProjection.get(stores[0].refs, position, sources),
          maximumSource
        )
      }
      for (let position = 0; position < stores[1].count; position++) {
        check()
        const candidate = await Brc38StreamedHistoryProjection.get(stores[1].refs, position, sources)
        let duplicate = false
        for (const sourceId of [0, 1] as const) {
          const limit = sourceId === 0 ? stores[0].count : position
          for (let previous = 0; previous < limit; previous++) {
            check()
            if (
              await subset(
                await Brc38StreamedHistoryProjection.get(stores[sourceId].refs, previous, sources),
                candidate
              )
            ) {
              duplicate = true
              break
            }
          }
          if (duplicate) break
        }
        // The primitive subset relation is transitive. A rejected preceding
        // incoming note can be compared without retaining an accepted-verdict
        // cache: the older note which rejected it also rejects this candidate.
        if (!duplicate) {
          if (count >= policy.maximumMembers)
            throw new SnapshotResourceLimitError('History union exceeds its original note limit')
          await Brc38StreamedHistoryProjection.put(output, count++, candidate, maximumSource)
          added++
        }
      }
      check()
      await output.seal()
      check()
      const sortKey = async (ref: NoteRef): Promise<readonly Brc38StructuredStringPart[]> => {
        const what = await lookup(ref, 'what'),
          when = await lookup(ref, 'when')
        if (what === undefined || (await primitive(ref, what)).kind !== 'string') reject()
        let first: Brc38StructuredStringPart
        if (ref.when !== undefined) first = { literal: ref.when }
        else if (when === undefined) first = { literal: 'undefined' }
        else {
          const value = await primitive(ref, when)
          if (value.kind === 'string') first = { source: sources[ref.source], span: when }
          else if (value.kind === 'number' || value.kind === 'boolean') first = { literal: String(value.value) }
          else if (value.kind === 'null') first = { literal: 'null' }
          else first = { source: sources[ref.source], span: when, coerce: true }
        }
        return [first, { literal: ' ' }, { source: sources[ref.source], span: what }]
      }
      // Sorting happens only when legacy addHistoryNote actually added a note.
      // Two sealed/pending external banks give O(n log n) stable sorting with
      // at most two note heads and no whole rank array or materialized key.
      if (added !== 0)
        for (let width = 1; width < count; width *= 2) {
          const next = await open()
          for (let start = 0; start < count; start += 2 * width) {
            let left = start,
              right = Math.min(count, start + width),
              out = start
            const middle = right,
              end = Math.min(count, start + 2 * width)
            while (left < middle || right < end) {
              check()
              const a = left < middle ? await Brc38StreamedHistoryProjection.get(output, left, sources) : undefined,
                b = right < end ? await Brc38StreamedHistoryProjection.get(output, right, sources) : undefined
              let takeLeft = b === undefined
              if (a !== undefined && b !== undefined)
                takeLeft =
                  (await compareBrc38StructuredStringSequences(await sortKey(a), await sortKey(b), comparePolicy)) <= 0
              const chosen = takeLeft ? a : b
              if (chosen === undefined) reject()
              await Brc38StreamedHistoryProjection.put(next, out++, chosen, maximumSource)
              if (takeLeft) left++
              else right++
            }
          }
          check()
          await next.seal()
          check()
          await closeIndex(output)
          output = next
        }
      for (const store of stores) {
        await closeIndex(store.refs)
        await closeIndex(store.properties)
      }
      for (const source of sources) {
        check()
        await verifyBrc38StructuredSourceDigest(
          source,
          1000000000,
          policy.signal,
          policy.maximumReadBytes,
          policy.maximumGrammarAllocationBytes,
          policy.workingAllocation
        )
        check()
      }
      owned.delete(output)
      return new Brc38StreamedHistoryProjection(
        output,
        sources,
        count,
        added,
        stores[1].count,
        policy as Readonly<Brc38StreamedHistoryProjectionPolicy>,
        owners.check,
        deadline,
        reservation,
        async () => {
          check()
          return await owners.openIndex(indexPolicy)
        }
      )
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Request-history preparation retains actual cleanup',
          cleanup
        )
      }
      throw cause
    }
  }
  /** Complete legacy history spelling, replacing only the notes property.
   * An empty incoming history leaves absent/null notes untouched. This owns
   * the notes generator and all composer indexes through EOF or revocation. */
  static async prepareField(
    owners: Brc38StructuredProjectionOwners,
    incoming: Brc38StreamedStructured,
    policy: Brc38StreamedHistoryProjectionPolicy,
    existing: Brc38StreamedStructured,
    incomingDefaultWhen?: string
  ): Promise<
    Readonly<{
      addedNotes: number
      measureChunks(width?: number): AsyncIterable<Uint8Array>
      chunks(width?: number): AsyncIterable<Uint8Array>
      close(): Promise<void>
    }>
  > {
    const projection = await Brc38StreamedHistoryProjection.prepare(
      owners,
      incoming,
      policy,
      existing,
      incomingDefaultWhen
    )
    let closed = false,
      consumed = false,
      measured = false,
      measurementEnded = false,
      iterator: AsyncGenerator<Uint8Array> | undefined,
      closing: Promise<void> | undefined
    const check = (): void => {
        projection.policy.signal?.throwIfAborted()
        projection.checkActor()
        if (closed || Date.now() >= projection.policy.expiresAt || performance.now() >= projection.deadline)
          throw new SnapshotResourceLimitError('Request-history field is revoked or expired')
      },
      cleanup = async (): Promise<void> => {
        await projection.close()
      },
      produce = async function* (width: number, measurement = false): AsyncGenerator<Uint8Array> {
        let original: unknown,
          failed = false,
          completed = false
        const cleanupScope1 = new Brc38CleanupScope(async () => {
          if (!measurement || !completed) closed = true
          try {
            if (!measurement || !completed) await cleanup()
          } catch (cause) {
            throw new Brc38StagingCleanupError(
              failed ? [original, cause] : [cause],
              'Complete request-history spelling retains physical cleanup',
              cleanup
            )
          }
        })
        try {
          check()
          const notes =
            projection.incomingNotes === 0
              ? undefined
              : {
                  chunks: (maximum: number) =>
                    measurement ? projection.measureChunks(maximum) : projection.chunks(maximum),
                  check,
                  close: measurement ? () => promiseFromSync(() => undefined) : cleanup
                }
          for await (const bytes of stringifyBrc38StructuredJsonSpan(
            projection.sources[0],
            { start: 0, end: projection.sources[0].length },
            {
              maximumInputBytes: 1000000000,
              maximumOutputBytes: projection.policy.maximumOutputBytes,
              maximumChunkBytes: width,
              maximumAllocationBytes: projection.policy.maximumGrammarAllocationBytes,
              workingAllocation: projection.policy.workingAllocation,
              signal: projection.policy.signal
            },
            undefined,
            notes
          )) {
            check()
            yield bytes
          }
          check()
          completed = true
          if (measurement) measurementEnded = true
        } catch (cause) {
          failed = true
          original = cause
          {
            await cleanupScope1.close()
            throw cause
          }
        } finally {
          await cleanupScope1.close()
        }
      }
    return Object.freeze({
      addedNotes: projection.addedNotes,
      measureChunks: (width = projection.policy.maximumReadBytes): AsyncIterable<Uint8Array> => {
        check()
        if (measured || consumed)
          throw new Error('Request-history measurement was already requested or output consumed')
        if (!validInteger(width, 64, projection.policy.maximumReadBytes))
          throw new RangeError('History measurement exceeds its original transfer window')
        measured = true
        iterator = produce(width, true)
        return iterator
      },
      chunks: (width = projection.policy.maximumReadBytes): AsyncIterable<Uint8Array> => {
        check()
        if (consumed) throw new Error('Complete request-history field was already consumed')
        if (measured && !measurementEnded)
          throw new Error('Request-history measurement must reach actual EOF before replay')
        if (!validInteger(width, 64, projection.policy.maximumReadBytes))
          throw new RangeError('History field exceeds its original transfer window')
        consumed = true
        iterator = produce(width)
        return iterator
      },
      close: async (): Promise<void> => {
        closed = true
        if (closing !== undefined) return await closing
        closing = (async () => {
          let original: unknown,
            failed = false
          try {
            await iterator?.return(undefined)
          } catch (cause) {
            original = cause
            failed = true
          }
          try {
            await cleanup()
          } catch (cause) {
            throw new Brc38StagingCleanupError(
              failed ? [original, cause] : [cause],
              'Revoked request-history field retains physical cleanup',
              cleanup
            )
          }
          if (failed) throw original
        })()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  }
  private static async put(
    index: Brc38JsonMemberIndex,
    position: number,
    ref: NoteRef,
    maximum: number
  ): Promise<void> {
    if (!validInteger(position, 0, maximum - 3)) reject()
    await index.put(position, {
      key: JSON.stringify(ref),
      keyOffset: position + 1,
      start: position + 2,
      end: position + 3
    })
  }
  private static async get(
    index: Brc38JsonMemberIndex,
    position: number,
    sources: readonly Brc38StreamedStructured[]
  ): Promise<NoteRef> {
    let result: NoteRef | undefined
    for await (const member of index.entries(position)) {
      if (
        result !== undefined ||
        member.key.length > 256 ||
        member.keyOffset !== position + 1 ||
        member.start !== position + 2 ||
        member.end !== position + 3
      )
        reject()
      const value = JSON.parse(member.key) as NoteRef
      if (
        value === null ||
        typeof value !== 'object' ||
        ![0, 1].includes(value.source) ||
        !validInteger(value.ordinal, 0, 2000000000) ||
        !validInteger(value.start, 0, sources[value.source].length - 1) ||
        !validInteger(value.end, value.start + 1, sources[value.source].length) ||
        (value.when !== undefined &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.when) || value.source !== 1)) ||
        JSON.stringify(value) !== member.key
      )
        reject()
      result = Object.freeze({ ...value })
    }
    if (result === undefined) reject()
    return result
  }
  private check(): void {
    this.policy.signal?.throwIfAborted()
    this.checkActor()
    if (this.#closed || Date.now() >= this.policy.expiresAt || performance.now() >= this.deadline)
      throw new SnapshotResourceLimitError('Private request-history output is revoked or expired')
  }
  chunks(width = this.policy.maximumReadBytes): AsyncGenerator<Uint8Array> {
    this.check()
    if (!validInteger(width, 64, this.policy.maximumReadBytes))
      throw new RangeError('History output exceeds its original transfer window')
    if (this.#consumed) throw new Error('Request-history notes were already consumed')
    if (this.#measured && !this.#measurementEnded)
      throw new Error('Request-history notes measurement must reach actual EOF')
    this.#consumed = true
    this.#iterator = this.produce(width)
    return this.#iterator
  }
  /** One optional measurement traversal over the same sealed span/timestamp
   * DATA, followed by one fresh final replay. Progress never admits a source;
   * both traversals independently read and hash actual original fields. */
  private measureChunks(width: number): AsyncGenerator<Uint8Array> {
    this.check()
    if (!validInteger(width, 64, this.policy.maximumReadBytes) || this.#consumed || this.#measured)
      throw new Error('Request-history notes measurement is unavailable')
    this.#measured = true
    this.#iterator = this.produceMeasurement(width)
    return this.#iterator
  }
  private async *produceMeasurement(width: number): AsyncGenerator<Uint8Array> {
    yield* this.produce(width)
    this.check()
    this.#measurementEnded = true
  }
  private async *produce(width: number): AsyncGenerator<Uint8Array> {
    let drain!: () => void
    this.#active = new Promise<void>(resolve => {
      drain = resolve
    })
    let charge: Brc38WorkingCharge | undefined
    const encoder = new TextEncoder()
    let total = 0
    const admit = (bytes: Uint8Array): Uint8Array => {
      this.check()
      if (bytes.length > this.policy.maximumOutputBytes - total)
        throw new SnapshotResourceLimitError('Request-history notes exceed their original output allowance')
      total += bytes.length
      return bytes
    }
    try {
      charge = this.policy.workingAllocation.claim(4096 + 2 * width)
      this.check()
      yield admit(encoder.encode('['))
      for (let position = 0; position < this.noteCount; position++) {
        this.check()
        const ref = await Brc38StreamedHistoryProjection.get(this.output, position, this.sources)
        this.check()
        if (position !== 0) yield admit(encoder.encode(','))
        for await (const bytes of stringifyBrc38StructuredJsonSpan(
          // The outer complete-field spelling retains that source's two
          // grammar/order indexes. Note spelling uses the projection scratch
          // whose four preparation banks have already drained; its output
          // plus these two banks stay inside the original six-bank allowance.
          { ...this.sources[ref.source], openIndex: this.openSpellingIndex },
          ref,
          {
            maximumInputBytes: 1000000000,
            maximumOutputBytes: this.policy.maximumOutputBytes,
            maximumChunkBytes: width,
            maximumAllocationBytes: this.policy.maximumGrammarAllocationBytes,
            workingAllocation: this.policy.workingAllocation,
            signal: this.policy.signal
          },
          ref.when === undefined ? undefined : { value: ref.when }
        ))
          yield admit(bytes)
      }
      for (const source of this.sources) {
        this.check()
        await verifyBrc38StructuredSourceDigest(
          source,
          1000000000,
          this.policy.signal,
          width,
          this.policy.maximumGrammarAllocationBytes,
          this.policy.workingAllocation
        )
        this.check()
      }
      yield admit(encoder.encode(']'))
      this.check()
    } finally {
      charge?.close()
      drain()
    }
  }
  async close(): Promise<void> {
    this.#closed = true
    if (this.#closing !== undefined) return await this.#closing
    this.#closing = (async () => {
      let original: unknown,
        failed = false
      try {
        await this.#iterator?.return(undefined)
      } catch (cause) {
        original = cause
        failed = true
      }
      await this.#active
      try {
        await this.output.close()
        this.reservation.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          failed ? [original, error_] : [error_],
          'Private request-history output retains actual physical cleanup',
          () => this.close()
        )
      }
      if (failed) throw original
    })()
    try {
      await this.#closing
    } catch (cause) {
      this.#closing = undefined
      throw cause
    }
  }
}
