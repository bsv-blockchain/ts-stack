import { awaitFromSync } from '../../../utility/promiseFromSync'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import {
  parseSnapshotJournalFieldArchiveReference,
  type SnapshotJournalFieldArchiveReference
} from './SnapshotJournalReceiptData'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { retrySnapshotArchiveOperation } from '../archive/SnapshotArchiveTransportFailure'
import { runInSeries } from '../../../utility/runInSeries'
import { OwnedRemoteSnapshotLease } from '../archive/RemoteSnapshotLease'
import { RemoteSnapshotOpeningCleanupError } from '../archive/openRemoteSnapshot'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import type { WalletReadSnapshotOptions } from '../WalletReadSnapshot'
import {
  parseSnapshotJournalFieldArchiveReaderRequest,
  type SnapshotJournalFieldArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import {
  parseSnapshotJournalFieldArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalFieldArchiveManifest
} from './SnapshotJournalArchiveBinding'
import { decodeSnapshotJournalFieldArchivePacket } from './SnapshotJournalArchivePacket'
import type { SnapshotJournalFieldContentIndex } from './SnapshotJournalArchivePacket'
import type { SnapshotJournalFieldArchiveTransport } from './SnapshotJournalFieldArchiveTransport'
import { parseSnapshotJournalArchivePosition, type SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'
import { decodeSnapshotJournalFieldFrame } from './SnapshotJournalDeltaFrame'
import type { SnapshotJournalHashedFieldPage } from './SnapshotJournalFieldTypes'
import type { SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'

export interface RemoteSnapshotJournalFieldFrame {
  readonly ordinal: number
  readonly frameDigest: string
  readonly stream: 'scope' | 'physical'
  readonly tableId: number
  /** Detached metadata DATA. Editing it cannot alter this frame's actual owner. */
  readonly page: SnapshotJournalHashedFieldPage
}
export interface RemoteSnapshotJournalFieldArchive {
  readonly manifest: SnapshotJournalFieldArchiveManifest
  readonly frameCount: number
  readonly expiresAt: number
  readonly isOpen: boolean
  readonly closed: Promise<void>
  close: () => Promise<void>
  readFrame: (
    ordinal: number,
    captureIdentities: (
      frameDigest: string,
      changeIndex: number,
      identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
    ) => void | Promise<void>
  ) => Promise<RemoteSnapshotJournalFieldFrame>
  readFieldExtent: (
    frame: RemoteSnapshotJournalFieldFrame,
    changeIndex: number,
    field: string,
    offset: number,
    length: number
  ) => Promise<Uint8Array>
}
interface IssuedFrame {
  readonly owner: RemoteSnapshotJournalFieldArchive
  readonly bytes: Uint8Array
  readonly stream: 'scope' | 'physical'
  readonly tableId: number
}
const issued = new WeakMap<RemoteSnapshotJournalFieldFrame, IssuedFrame>()
const opened = new WeakSet<RemoteSnapshotJournalFieldArchive>()
/** Actual opened archive membership before any target prefix is persisted.
 * An archive-shaped DATA object cannot enroll an intake callback. */
export function assertRemoteSnapshotJournalFieldArchive(owner: RemoteSnapshotJournalFieldArchive): void {
  if (!opened.has(owner) || !owner.isOpen)
    throw new WERR_INVALID_OPERATION('Field archive differs from its actual opened artifact')
}

/** Concrete actual artifact/frame membership only. This cannot enroll an SQL
 * source, writer, commit fence, activation or financial acknowledgement. */
export function assertRemoteSnapshotJournalFieldFrame(
  owner: RemoteSnapshotJournalFieldArchive,
  frame: RemoteSnapshotJournalFieldFrame
): void {
  assertRemoteSnapshotJournalFieldArchive(owner)
  if (issued.get(frame)?.owner !== owner)
    throw new WERR_INVALID_OPERATION('Field frame differs from its actual opened artifact')
}

export async function openRemoteSnapshotJournalFieldArchive(
  transport: SnapshotJournalFieldArchiveTransport,
  inputPosition?: SnapshotJournalArchivePosition,
  options: WalletReadSnapshotOptions = {},
  inputReference?: SnapshotJournalFieldArchiveReference
): Promise<RemoteSnapshotJournalFieldArchive | undefined> {
  const reference =
      inputReference === undefined ? undefined : parseSnapshotJournalFieldArchiveReference(inputReference),
    reopenedAt = performance.now(),
    reopenOriginal = async () => {
      if (reference === undefined) return undefined
      // Own preflight I/O before an artifact reader exists. There is no new
      // server request to cancel, but the actual pending fetch must settle.
      const opening = new OwnedRemoteSnapshotLease<SnapshotJournalFieldArchiveReaderRequest>(
          transport,
          options,
          parseSnapshotJournalFieldArchiveReaderRequest
        ),
        timer = setTimeout(() => {
          void opening
            .close(new SnapshotResourceLimitError('Field recovery original I/O deadline reached'))
            .catch(() => undefined)
        }, 30000)
      try {
        return await opening.runIdempotent(signal => transport.reopen(reference, signal))
      } finally {
        clearTimeout(timer)
        await opening.close()
        await opening.closed
      }
    },
    reopened = await reopenOriginal(),
    reopenElapsed = reference === undefined ? 0 : Math.ceil(performance.now() - reopenedAt)
  if (reference !== undefined && reopened === undefined) return undefined
  const position = parseSnapshotJournalArchivePosition(reopened?.request.position ?? inputPosition ?? null),
    lease = new OwnedRemoteSnapshotLease<SnapshotJournalFieldArchiveReaderRequest>(
      transport,
      reopened === undefined
        ? options
        : {
            ...options,
            lifetimeMs: Math.max(
              1,
              Math.min(
                options.lifetimeMs ?? 300000,
                reopened.request.notAfter - reopened.offer.serverTime - reopenElapsed
              )
            )
          },
      parseSnapshotJournalFieldArchiveReaderRequest
    )
  try {
    const offered =
      reopened ??
      (await lease.run(signal =>
        transport.offer(
          { lifetimeMs: lease.lifetimeMs, maxBytes: snapshotArchiveLimits.archiveBytes },
          position,
          signal
        )
      ))
    if (offered.outcome === 'resource-limited') {
      await lease.close()
      return undefined
    }
    const { offer, request } = offered
    lease.bindServerTime(offer.serverTime + reopenElapsed)
    lease.own(request)
    const admitted = await lease.runIdempotent(signal => transport.admit(request, signal))
    if (admitted.outcome === 'resource-limited') {
      await lease.close()
      return undefined
    }
    let receipt = admitted.receipt
    function* polling() {
      let delay = 100
      while (receipt.state === 'building') {
        yield delay
        delay = Math.min(delay * 2, 1000)
      }
    }
    await runInSeries(polling(), async delay => {
      await lease.wait(delay)
      receipt = await lease.runIdempotent(signal => transport.status(request, signal))
    })
    if (receipt.state === 'resource-limited') {
      await lease.close()
      return undefined
    }
    if (receipt.state !== 'ready') throw new WERR_INVALID_OPERATION(`Journal field capture is ${receipt.state}`)
    const directory = await lease.runIdempotent(signal =>
        transport.directory(request, receipt, offer, lease.now(), signal)
      ),
      content = new Map<string, Array<{ sequence: number; index: Readonly<SnapshotJournalFieldContentIndex> }>>()
    if (
      reference !== undefined &&
      (JSON.stringify(directory.manifest.binding.journal.source) !== JSON.stringify(reference.source) ||
        JSON.stringify(directory.manifest.binding.journal.receipt) !== JSON.stringify(reference.receipt))
    )
      throw new TypeError('Actual reopened field archive differs from its original receipt')
    let contentBytes = 0
    for (const entry of directory.receipts) {
      if (entry.content === null) continue
      const index = entry.content,
        group = content.get(index.descriptor.sha256) ?? []
      group.push({ sequence: entry.sequence, index })
      content.set(index.descriptor.sha256, group)
      contentBytes += index.length
      if (!Number.isSafeInteger(contentBytes) || contentBytes > request.maxBytes)
        throw new TypeError('Field content index exceeds its actual reservation')
    }
    for (const group of content.values()) {
      group.sort((a, b) => a.index.offset - b.index.offset)
      let end = 0
      const first = group[0].index
      for (const { index } of group) {
        if (
          index.offset !== end ||
          index.descriptor.bytes !== first.descriptor.bytes ||
          index.descriptor.kind !== first.descriptor.kind ||
          index.frameDigest !== first.frameDigest ||
          index.changeIndex !== first.changeIndex ||
          index.field !== first.field
        )
          throw new TypeError('Field content index is incomplete or mixed')
        end += index.length
      }
      if (end !== first.descriptor.bytes || (end === 0 && group.length !== 1))
        throw new TypeError('Field content index has missing or repeated extents')
    }
    const fresh = () => {
      lease.assertOpen()
      if (lease.now() >= directory.manifest.expiresAt)
        throw new WERR_INVALID_OPERATION('Remote journal field artifact expired')
    }
    const read = async (sequence: number, signal: AbortSignal) => {
      const receipt = directory.receipts[sequence],
        packet = decodeSnapshotJournalFieldArchivePacket(
          await retrySnapshotArchiveOperation(() =>
            awaitFromSync(() => transport.page(request, directory, sequence, signal))
          ),
          { stream: receipt.stream, tableId: receipt.tableId },
          directory.manifest.binding.journal.receipt.highWater
        )
      if (packet.kind === 'field-content') {
        const expected = receipt.content
        if (
          expected === null ||
          packet.frameDigest !== expected.frameDigest ||
          packet.changeIndex !== expected.changeIndex ||
          packet.field !== expected.field ||
          packet.offset !== expected.offset ||
          packet.bytes.length !== expected.length ||
          JSON.stringify(packet.descriptor) !== JSON.stringify(expected.descriptor)
        )
          throw new TypeError('Actual content packet differs from its verified index')
      }
      return packet
    }
    let owner!: RemoteSnapshotJournalFieldArchive
    owner = Object.freeze({
      get manifest() {
        return {
          ...directory.manifest,
          binding: parseSnapshotJournalFieldArchiveBinding(JSON.parse(directory.bindingJson))
        }
      },
      frameCount: directory.frames.length,
      expiresAt: lease.expiresAt,
      get isOpen() {
        return lease.isOpen
      },
      closed: lease.closed,
      close: () => lease.close(),
      readFrame: async (
        ordinal: number,
        captureIdentities: (
          frameDigest: string,
          changeIndex: number,
          identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
        ) => void | Promise<void>
      ) =>
        await lease.run(async signal => {
          fresh()
          if (
            !Number.isSafeInteger(ordinal) ||
            ordinal < 0 ||
            ordinal >= directory.frames.length ||
            typeof captureIdentities !== 'function'
          )
            throw new TypeError('Invalid field frame request')
          const index = directory.frames[ordinal],
            context = snapshotJournalArchiveStreams[index.streamIndex],
            bytes = await transport.page(request, directory, index.sequence, signal),
            frame = decodeSnapshotJournalFieldArchivePacket(
              bytes,
              { stream: context.stream, tableId: context.tableId },
              directory.manifest.binding.journal.receipt.highWater
            )
          if (
            frame.kind !== 'field-frame' ||
            frame.page.changes.length !== directory.receipts[index.sequence].rows ||
            frame.page.complete !== directory.receipts[index.sequence].done
          )
            throw new TypeError('Field metadata differs from its actual directory')
          for (const change of frame.page.changes)
            if (change.present)
              for (const descriptor of Object.values(change.fields)) {
                if (content.get(descriptor.sha256)?.[0].index.descriptor.bytes !== descriptor.bytes)
                  throw new TypeError('Declared field content is missing from this artifact')
              }
          for (let sequence = index.firstPrefix; sequence < index.sequence; sequence++) {
            const prefix = directory.receipts[sequence]
            if (prefix.packet === 'content') {
              const value = prefix.content,
                change = value === null ? undefined : frame.page.changes[value.changeIndex],
                descriptor = change?.present && value !== null ? change.fields[value.field] : undefined
              if (
                value === null ||
                value.frameDigest !== frame.frameDigest ||
                descriptor === undefined ||
                JSON.stringify(descriptor) !== JSON.stringify(value.descriptor)
              )
                throw new TypeError('Content index differs from its actual field frame')
              continue
            }
            const value = await read(sequence, signal)
            if (
              value.kind !== 'field-identities' ||
              value.frameDigest !== frame.frameDigest ||
              value.changeIndex >= frame.page.changes.length
            )
              throw new TypeError('Field identity prefix differs from its actual frame')
            fresh()
            const pending = captureIdentities(frame.frameDigest, value.changeIndex, value.identities)
            if (pending !== undefined) await pending
          }
          fresh()
          const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false),
            encoded = new Uint8Array(bytes.subarray(4 + header)),
            result = Object.freeze({
              ordinal,
              frameDigest: frame.frameDigest,
              stream: context.stream,
              tableId: context.tableId,
              get page() {
                return decodeSnapshotJournalFieldFrame(encoded, { stream: context.stream, tableId: context.tableId })
              }
            })
          issued.set(result, { owner, bytes: encoded, stream: context.stream, tableId: context.tableId })
          return result
        }),
      readFieldExtent: async (
        frame: RemoteSnapshotJournalFieldFrame,
        changeIndex: number,
        field: string,
        offset: number,
        length: number
      ) =>
        await lease.run(async signal => {
          fresh()
          assertRemoteSnapshotJournalFieldFrame(owner, frame)
          if (
            !Number.isSafeInteger(changeIndex) ||
            typeof field !== 'string' ||
            field.length < 1 ||
            field.length > 128 ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > 65536
          )
            throw new TypeError('Invalid actual field extent coordinates')
          const original = issued.get(frame)!,
            page = decodeSnapshotJournalFieldFrame(original.bytes, {
              stream: original.stream,
              tableId: original.tableId
            }),
            change = page.changes[changeIndex],
            descriptor = change?.present ? change.fields[field] : undefined
          if (
            !Number.isSafeInteger(changeIndex) ||
            descriptor === undefined ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > 65536 ||
            offset > descriptor.bytes - length
          )
            throw new TypeError('Invalid actual field extent')
          const group = content.get(descriptor.sha256)
          if (group === undefined || group[0].index.descriptor.bytes !== descriptor.bytes)
            throw new TypeError('Field content does not belong to this artifact')
          if (length === 0) {
            const current = await retrySnapshotArchiveOperation(() =>
              awaitFromSync(() => transport.status(request, signal))
            )
            if (
              current.state !== 'ready' ||
              current.archiveId !== directory.manifest.archiveId ||
              current.digest !== directory.manifest.digest ||
              current.expiresAt !== directory.manifest.expiresAt
            )
              throw new TypeError('Field artifact is no longer actually ready')
            fresh()
            return new Uint8Array(0)
          }
          const result = new Uint8Array(length)
          try {
            let accepted = 0
            for (const candidate of group) {
              if (accepted === length) break
              const start = candidate.index.offset,
                end = start + candidate.index.length
              if (offset + accepted >= end || offset + accepted < start) continue
              const packet = await read(candidate.sequence, signal)
              if (packet.kind !== 'field-content') throw new TypeError('Indexed field packet is missing')
              const at = offset + accepted - start,
                count = Math.min(length - accepted, packet.bytes.length - at)
              result.set(packet.bytes.subarray(at, at + count), accepted)
              accepted += count
            }
            if (accepted !== length) throw new TypeError('Actual field extent has missing bytes')
            fresh()
            return result
          } catch (cause) {
            result.fill(0)
            throw cause
          }
        })
    })
    fresh()
    opened.add(owner)
    return owner
  } catch (error) {
    try {
      await lease.close()
    } catch (cleanup) {
      throw new RemoteSnapshotOpeningCleanupError(error, cleanup)
    }
    throw error
  }
}
