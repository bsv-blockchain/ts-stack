import { Hash, Utils } from '@bsv/sdk'
import { parseJsonRpc, stringifyJsonRpc } from './BinaryJson'

/** Versioned transport framing; the reconstructed BRC-40 request/response is unchanged. */
export interface SyncTransferCapabilities {
  version: 1
  maxBytes: number
  partBytes: number
  inlineBytes?: number
}

export interface SyncTransferManifest {
  transferId: string
  digest: string
  totalBytes: number
  partBytes: number
  expiresAt: number
}

export interface SyncTransferPart {
  offset: number
  bytes: Uint8Array
}

export const SYNC_TRANSFER_MAX_BYTES = 64 * 1024 * 1024
export const SYNC_TRANSFER_PART_BYTES = 256 * 1024

export function syncTransferDigest(bytes: Uint8Array): string {
  return Utils.toHex(Hash.sha256(bytes))
}

interface BinaryField {
  path: Array<string | number>
  length: number
}

/** A length-prefixed JSON metadata header followed by raw byte fields, without base64 expansion. */
export function encodeSyncTransfer(value: unknown): Uint8Array {
  const fields: BinaryField[] = []
  const parts: Uint8Array[] = []
  const ancestors = new Set<object>()
  const visit = (value: unknown, path: Array<string | number>): unknown => {
    if (path.length > 64) throw new RangeError('Wallet sync transfer nesting exceeds 64 levels')
    if (value instanceof Uint8Array) {
      fields.push({ path, length: value.length })
      parts.push(value)
      return null
    }
    if (value == null || typeof value !== 'object' || value instanceof Date) return value
    if (ancestors.has(value)) throw new TypeError('Cyclic wallet sync transfer data')
    ancestors.add(value)
    const copy = Array.isArray(value)
      ? value.map((entry, index) => visit(entry, [...path, index]))
      : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]))
    ancestors.delete(value)
    return copy
  }
  const metadata = visit(value, [])
  if (fields.length > 4096) throw new RangeError('Too many binary fields in wallet sync transfer')
  const header = new TextEncoder().encode(stringifyJsonRpc({ version: 1, value: metadata, fields }, true))
  const length = 4 + header.length + parts.reduce((sum, part) => sum + part.length, 0)
  if (length > SYNC_TRANSFER_MAX_BYTES) throw new RangeError('Wallet sync record exceeds the transfer size limit')
  const frame = new Uint8Array(length)
  new DataView(frame.buffer).setUint32(0, header.length, false)
  frame.set(header, 4)
  let offset = 4 + header.length
  for (const part of parts) { frame.set(part, offset); offset += part.length }
  return frame
}

export function decodeSyncTransfer(bytes: Uint8Array): unknown {
  const invalid = (): never => { throw new TypeError('Invalid wallet sync transfer frame') }
  if (bytes.length < 4 || bytes.length > SYNC_TRANSFER_MAX_BYTES) invalid()
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  if (headerLength > bytes.length - 4) invalid()
  const header = parseJsonRpc(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headerLength)), true)
  if (header?.version !== 1 || !Array.isArray(header.fields) || header.fields.length > 4096) invalid()
  const holder: { value: unknown } = { value: header.value }
  let offset = 4 + headerLength
  for (const field of header.fields as BinaryField[]) {
    if (field == null || !Array.isArray(field.path) || field.path.length > 64 ||
      !Number.isSafeInteger(field.length) || field.length < 0 || field.length > bytes.length - offset) invalid()
    let target: Record<string | number, unknown> = holder
    const path: Array<string | number> = ['value', ...field.path]
    for (let i = 0; i < path.length; i++) {
      const key = path[i]
      if ((typeof key !== 'string' && (!Number.isSafeInteger(key) || key < 0)) ||
        target == null || typeof target !== 'object' || !Object.hasOwn(target, key)) invalid()
      if (i === path.length - 1) {
        if (target[key] !== null) invalid()
        Object.defineProperty(target, key, { value: bytes.subarray(offset, offset + field.length),
          enumerable: true, writable: true, configurable: true })
      } else target = target[key] as Record<string | number, unknown>
    }
    offset += field.length
  }
  if (offset !== bytes.length) invalid()
  return holder.value
}

export function validateSyncTransferCapabilities(value: SyncTransferCapabilities): SyncTransferCapabilities {
  if (value?.version !== 1 || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 ||
    value.maxBytes > SYNC_TRANSFER_MAX_BYTES || !Number.isSafeInteger(value.partBytes) ||
    value.partBytes < 1024 || value.partBytes > SYNC_TRANSFER_PART_BYTES ||
    (value.inlineBytes != null && (!Number.isSafeInteger(value.inlineBytes) || value.inlineBytes < 1024 || value.inlineBytes > SYNC_TRANSFER_MAX_BYTES))) {
    throw new TypeError('Unsupported wallet sync transfer capabilities')
  }
  return value
}

export function validateSyncTransferManifest(
  value: SyncTransferManifest, capabilities: SyncTransferCapabilities
): SyncTransferManifest {
  if (value == null || !/^[a-f0-9]{64}$/.test(value.transferId) || !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > capabilities.maxBytes ||
    value.partBytes !== capabilities.partBytes || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new TypeError('Invalid wallet sync transfer manifest')
  }
  return value
}

/** Read-only part retries never advance the wallet's durable BRC-40 checkpoint. */
export async function receiveSyncTransfer(
  manifest: SyncTransferManifest,
  read: (offset: number) => Promise<SyncTransferPart>
): Promise<unknown> {
  const bytes = new Uint8Array(manifest.totalBytes)
  for (let offset = 0; offset < bytes.length;) {
    const part = await read(offset)
    const length = Math.min(manifest.partBytes, bytes.length - offset)
    if (part.offset !== offset || !(part.bytes instanceof Uint8Array) || part.bytes.length !== length) {
      throw new TypeError('Invalid wallet sync transfer part')
    }
    bytes.set(part.bytes, offset)
    offset += length
  }
  if (syncTransferDigest(bytes) !== manifest.digest) throw new Error('Wallet sync transfer integrity check failed')
  return decodeSyncTransfer(bytes)
}
