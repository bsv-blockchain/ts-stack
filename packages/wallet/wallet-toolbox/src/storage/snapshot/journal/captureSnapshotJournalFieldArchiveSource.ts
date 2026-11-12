import { createHash } from 'node:crypto'
import type { KnexSnapshotArchiveStore } from '../archive/KnexSnapshotArchiveStore'
import type { SnapshotArchiveWriter } from '../archive/SnapshotArchive'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { closeSnapshotJournalSource } from './closeSnapshotJournalSource'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import type { SnapshotJournalReconciliationSource } from './SnapshotJournalProvider'
import type { SnapshotJournalPosition } from './SnapshotJournalTypes'
import type { SnapshotJournalHashedFieldPage, SnapshotJournalHashedFieldDelta } from './SnapshotJournalFieldTypes'
import { parseSnapshotJournalArchivePosition, type SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'
import {
  parseSnapshotJournalFieldArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalFieldArchiveManifest
} from './SnapshotJournalArchiveBinding'
import { encodeSnapshotJournalFieldFrame, decodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import {
  encodeSnapshotJournalFieldArchiveFrame,
  encodeSnapshotJournalFieldArchiveContent,
  encodeSnapshotJournalFieldArchiveIdentities,
  snapshotJournalFieldArchiveEncoding
} from './SnapshotJournalArchivePacket'

export type SnapshotJournalFieldArchiveCaptureStore = Pick<
  KnexSnapshotArchiveStore,
  'beginJournalFields' | 'appendJournalFields' | 'sealJournalFields'
> & {
  close: (identityKey: string, archiveId: string, error?: unknown) => Promise<void>
}
/** Genuine pinned source -> immutable field artifact. Hash every original field,
 * replay each distinct content value into bounded packets, and rehash that replay.
 * Prefixes are provisional until their exact metadata frame; physical source
 * close still precedes READY. No source SQL actor/fence or financial ACK escapes. */
export async function captureSnapshotJournalFieldArchiveSource(
  source: SnapshotJournalReconciliationSource,
  store: SnapshotJournalFieldArchiveCaptureStore,
  position?: SnapshotJournalArchivePosition,
  inputOptions: { lifetimeMs?: number; maxBytes?: number; signal?: AbortSignal } = {}
): Promise<SnapshotJournalFieldArchiveManifest> {
  const options = Object.freeze({ ...inputOptions }),
    reader = source.fieldDeltaReader,
    identities = source.readFieldIdentities,
    seen = new Map<string, number>()
  let writer: SnapshotArchiveWriter | undefined, failure: { error: unknown } | undefined
  const active = () => {
    if (options.signal?.aborted) throw new SnapshotCancelledError('Journal field capture cancelled')
  }
  try {
    active()
    if (reader === undefined || identities === undefined)
      throw new TypeError('Actual journal field and identity producers are required')
    const previous = parseSnapshotJournalArchivePosition(position ?? null)
    await source.verifyLive()
    if (
      previous?.binding === source.receipt.binding &&
      compareSnapshotJournalRevisions(previous.highWater, source.receipt.highWater) > 0
    )
      throw new TypeError('Journal field position exceeds the actual source high-water')
    const incremental =
        previous !== undefined &&
        previous.binding === source.receipt.binding &&
        compareSnapshotJournalRevisions(previous.highWater, source.receipt.floor) >= 0,
      low = incremental ? previous.highWater : snapshotJournalRevision('0'),
      revision = await source.readContentRevision?.(),
      binding = parseSnapshotJournalFieldArchiveBinding({
        version: 4,
        encoding: snapshotJournalFieldArchiveEncoding,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        sourceSchema: source.sourceSchema,
        user: source.user,
        journal: {
          source: source.receiptBinding,
          receipt: source.receipt,
          low,
          bootstrap: !incremental,
          primary: source.primary,
          ...(revision === undefined ? {} : { contentRevision: revision })
        }
      })
    writer = await store.beginJournalFields(binding, options)
    if (!incremental) await source.validateClosure()
    let sequence = 0
    const append = async (
      table: (typeof snapshotJournalArchiveStreams)[number]['table'],
      bytes: Uint8Array,
      rows: number,
      done: boolean
    ) => {
      active()
      if (sequence >= snapshotArchiveLimits.pages)
        throw new SnapshotResourceLimitError('Journal field packet count exhausted')
      await store.appendJournalFields(writer!, { sequence, table, bytes, rows, done })
      sequence++
    }
    for (const stream of snapshotJournalArchiveStreams) {
      const context = { stream: stream.stream, tableId: stream.tableId }
      let after: SnapshotJournalPosition | undefined,
        complete = false
      while (!complete) {
        active()
        const request = {
            ...context,
            low,
            ...(incremental ? {} : { bootstrap: true as const }),
            after,
            maximumRows: 8,
            maximumBytes: 262144
          },
          page = await reader.readPage(request),
          changes: SnapshotJournalHashedFieldDelta[] = []
        for (const change of page.changes) {
          if (!change.present) {
            changes.push(change)
            continue
          }
          const fields: Record<
            string,
            Readonly<import('./SnapshotJournalFieldTypes').SnapshotJournalHashedFieldDescriptor>
          > = Object.create(null)
          for (const [field, descriptor] of Object.entries(change.fields)) {
            if (descriptor.bytes > (options.maxBytes ?? snapshotArchiveLimits.archiveBytes))
              throw new SnapshotResourceLimitError('Journal field exceeds the actual artifact reservation')
            const hash = createHash('sha256'),
              utf8 = descriptor.kind === 'utf8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
            let offset = 0
            do {
              active()
              const length = Math.min(65536, descriptor.bytes - offset),
                bytes = await reader.readExtent(request, change.metadata, field, offset, length, descriptor)
              try {
                active()
                if (bytes.length !== length) throw new TypeError('Actual journal field extent differs')
                utf8?.decode(bytes, { stream: true })
                hash.update(bytes)
                offset += length
              } finally {
                bytes.fill(0)
              }
            } while (offset < descriptor.bytes)
            utf8?.decode()
            const sha256 = hash.digest('hex')
            if (descriptor.sha256 !== undefined && descriptor.sha256 !== sha256)
              throw new TypeError('Journal field differs from its actual stored digest')
            fields[field] = Object.freeze({ kind: descriptor.kind, bytes: descriptor.bytes, sha256 })
          }
          changes.push({ ...change, fields: Object.freeze(fields) })
        }
        const measured: SnapshotJournalHashedFieldPage = { ...page, changes },
          encoded = encodeSnapshotJournalFieldFrame(measured, context),
          frame = decodeSnapshotJournalFieldFrame(encoded, context),
          frameDigest = createHash('sha256').update(encoded).digest('hex')
        await identities.call(source, request, frame, async (index, values) => {
          await append(
            stream.table,
            encodeSnapshotJournalFieldArchiveIdentities(
              context,
              frameDigest,
              index,
              values,
              binding.journal.receipt.highWater
            ),
            0,
            false
          )
        })
        for (const [changeIndex, change] of frame.changes.entries()) {
          if (!change.present) continue
          const original = page.changes[changeIndex]
          if (!original.present) throw new TypeError('Original journal field row changed')
          for (const [field, descriptor] of Object.entries(change.fields)) {
            const prior = seen.get(descriptor.sha256)
            if (prior !== undefined) {
              if (prior !== descriptor.bytes) throw new TypeError('Repeated journal content length differs')
              continue
            }
            if (seen.size >= snapshotArchiveLimits.pages)
              throw new SnapshotResourceLimitError('Journal field content index exhausted')
            const hash = createHash('sha256')
            let offset = 0
            do {
              active()
              const length = Math.min(65536, descriptor.bytes - offset),
                bytes = await reader.readExtent(
                  request,
                  original.metadata,
                  field,
                  offset,
                  length,
                  original.fields[field]
                )
              try {
                active()
                if (bytes.length !== length) throw new TypeError('Replayed journal field extent differs')
                hash.update(bytes)
                await append(
                  stream.table,
                  encodeSnapshotJournalFieldArchiveContent(
                    context,
                    frameDigest,
                    changeIndex,
                    field,
                    descriptor,
                    offset,
                    bytes
                  ),
                  0,
                  false
                )
                offset += length
              } finally {
                bytes.fill(0)
              }
            } while (offset < descriptor.bytes)
            if (hash.digest('hex') !== descriptor.sha256) throw new TypeError('Journal field replay digest differs')
            seen.set(descriptor.sha256, descriptor.bytes)
          }
        }
        await append(
          stream.table,
          encodeSnapshotJournalFieldArchiveFrame(context, frame),
          frame.changes.length,
          frame.complete
        )
        if (!frame.complete && (frame.after === undefined || JSON.stringify(frame.after) === JSON.stringify(after)))
          throw new TypeError('Journal field keyset did not advance')
        after = frame.after
        complete = frame.complete
      }
    }
    await source.verifyLive()
  } catch (error) {
    failure = { error }
  }
  try {
    await closeSnapshotJournalSource(source, options.signal)
  } catch (error) {
    if (failure !== undefined && failure.error !== error)
      throw new AggregateError([failure.error, error], 'Journal field capture and physical cleanup failed', {
        cause: failure.error
      })
    throw error
  }
  if (failure === undefined) {
    try {
      active()
      if (writer === undefined) throw new TypeError('Journal field writer was not admitted')
      const manifest = await store.sealJournalFields(writer)
      active()
      return manifest
    } catch (error) {
      failure = { error }
    }
  }
  if (writer !== undefined) {
    try {
      await store.close(source.user.identityKey, writer.archiveId, failure.error)
    } catch (error) {
      throw new AggregateError([failure.error, error], 'Journal field failure and staged cleanup failed', {
        cause: failure.error
      })
    }
  }
  throw failure.error
}
