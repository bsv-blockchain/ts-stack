import type { TableSettings } from '../schema/tables'
import type { SnapshotSyncContentReceipt, SnapshotSyncSource } from './SnapshotSync'
import {
  parseSnapshotSyncContentPosition,
  parseSnapshotSyncContentRevision,
  type SnapshotSyncContentPosition,
  type SnapshotSyncContentRevision
} from './SnapshotSyncContentRevision'
import {
  parseRemoteSnapshotSyncCheckpoint,
  parseRemoteSnapshotSyncSource,
  remoteSnapshotStorageKey
} from './RemoteSnapshotSyncProtocol'

/** A separate advertisement preserves the exact version-one capabilities. */
export interface RemoteSnapshotSyncContentCapabilities {
  readonly version: 1
  readonly source: boolean
  readonly destination: boolean
  readonly maxIoMs: 30000
}
export const remoteSnapshotSyncContentMethods = Object.freeze([
  'beginSnapshotSyncContent',
  'getSnapshotSyncContentReceipt',
  'confirmSnapshotSyncContentReceipt',
  'observeSnapshotSyncContent'
] as const)
export type RemoteSnapshotSyncContentMethod = (typeof remoteSnapshotSyncContentMethods)[number]
export function isRemoteSnapshotSyncContentMethod(method: string): method is RemoteSnapshotSyncContentMethod {
  return (remoteSnapshotSyncContentMethods as readonly string[]).includes(method)
}
function invalid(): never {
  throw new TypeError('Invalid authenticated snapshot content protocol value')
}
function object(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalid()
  const output: Record<string, unknown> = Object.create(null)
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    Object.defineProperty(output, name, { value: descriptor.value, enumerable: true })
  }
  return output
}
export function validateRemoteSnapshotSyncContentCapabilities(
  input: unknown
): Readonly<RemoteSnapshotSyncContentCapabilities> {
  const value = object(input, ['version', 'source', 'destination', 'maxIoMs'])
  if (
    value.version !== 1 ||
    value.maxIoMs !== 30000 ||
    typeof value.source !== 'boolean' ||
    typeof value.destination !== 'boolean' ||
    (!value.source && !value.destination)
  )
    invalid()
  return Object.freeze({ version: 1, source: value.source, destination: value.destination, maxIoMs: 30000 })
}
type ContentInput =
  | {
      method: 'beginSnapshotSyncContent'
      source: SnapshotSyncSource
      activeStorage: string | undefined
      revision: Readonly<SnapshotSyncContentRevision>
    }
  | { method: 'getSnapshotSyncContentReceipt'; sourceStorageIdentityKey: string }
  | {
      method: 'confirmSnapshotSyncContentReceipt'
      sourceStorageIdentityKey: string
      revision: Readonly<SnapshotSyncContentRevision>
    }
  | { method: 'observeSnapshotSyncContent'; since: Readonly<SnapshotSyncContentPosition> | undefined }

/** Detach all wire data before any asynchronous admission or source opening. */
export function parseRemoteSnapshotSyncContentInput(
  method: RemoteSnapshotSyncContentMethod,
  params: unknown[],
  identityKey: string,
  chain: TableSettings['chain']
): ContentInput {
  if (!Array.isArray(params) || Reflect.ownKeys(params).length !== 3) invalid()
  const length = Object.getOwnPropertyDescriptor(params, 'length'),
    first = Object.getOwnPropertyDescriptor(params, '0'),
    second = Object.getOwnPropertyDescriptor(params, '1')
  if (
    length?.value !== 2 ||
    first === undefined ||
    second === undefined ||
    !Object.hasOwn(first, 'value') ||
    !Object.hasOwn(second, 'value') ||
    !first.enumerable ||
    !second.enumerable
  )
    invalid()
  const values: readonly [unknown, unknown] = [first.value, second.value]
  switch (method) {
    case 'beginSnapshotSyncContent': {
      const options = object(values[1], ['activeStorage', 'revision'])
      return {
        method,
        source: parseRemoteSnapshotSyncSource(values[0], identityKey, chain),
        activeStorage: options.activeStorage === null ? undefined : remoteSnapshotStorageKey(options.activeStorage),
        revision: parseSnapshotSyncContentRevision(options.revision)
      }
    }
    case 'getSnapshotSyncContentReceipt':
      if (values[0] !== identityKey) invalid()
      return { method, sourceStorageIdentityKey: remoteSnapshotStorageKey(values[1]) }
    case 'confirmSnapshotSyncContentReceipt':
      return {
        method,
        sourceStorageIdentityKey: remoteSnapshotStorageKey(values[0]),
        revision: parseSnapshotSyncContentRevision(values[1])
      }
    case 'observeSnapshotSyncContent':
      if (values[0] !== identityKey) invalid()
      return { method, since: values[1] === null ? undefined : parseSnapshotSyncContentPosition(values[1]) }
  }
}

export function parseRemoteSnapshotSyncContentReceipt(
  input: unknown,
  scope: { identityKey: string; sourceStorageIdentityKey: string; destinationStorageIdentityKey: string }
): SnapshotSyncContentReceipt | undefined {
  if (input === null) return undefined
  const value = object(input, ['checkpoint', 'source']),
    checkpoint = parseRemoteSnapshotSyncCheckpoint(value.checkpoint, scope)
  if (!checkpoint.done) invalid()
  return Object.freeze({ checkpoint, source: parseSnapshotSyncContentRevision(value.source) })
}
