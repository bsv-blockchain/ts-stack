import {
  CHIRP_CHUNK_SIZE,
  CHIRP_MAJOR_VERSION,
  CHIRP_MINOR_VERSION,
  CHIRP_PROFILE_FIXED_4_MIB
} from './constants.js'
import { encodeRootNode, mediaTypeExtension } from './codec.js'
import { createSHA256, objectIdentifierForBytes, sha256 } from './hash.js'
import { chirpURLForIdentifier } from './uri.js'
import { toAsyncBytes } from './sources.js'
import { buildBranchLevels } from './tree.js'
import type {
  CHIRPBuildOptions,
  CHIRPBuildResult,
  CHIRPByteSource,
  CHIRPChildReference,
  CHIRPObjectSink,
  CHIRPRootNode
} from './types.js'

export class CHIRPBuilder {
  async build(source: CHIRPByteSource, options: CHIRPBuildOptions = {}): Promise<CHIRPBuildResult> {
    const snapshot = snapshotBuildInputs(source, options)
    source = snapshot.source
    const { mediaType, sink, putObject, signal } = snapshot
    const stableSink: CHIRPObjectSink = Object.freeze({
      putObject: async (identifier: string, bytes: Uint8Array, kind: 'blob' | 'branch' | 'root') =>
        await raceWithSignal(
          Promise.resolve(Reflect.apply(putObject, sink, [identifier, bytes, kind])),
          signal
        )
    })
    const contentHasher = createSHA256()
    const leaves: CHIRPChildReference[] = []
    let pending = new Uint8Array(CHIRP_CHUNK_SIZE)
    let pendingLength = 0
    let logicalLength = 0n
    let objectCount = 0

    const flush = async (): Promise<void> => {
      if (pendingLength === 0) return
      const blob = pending.slice(0, pendingLength)
      const objectHash = sha256(blob)
      const objectIdentifier = objectIdentifierForBytes(blob)
      await stableSink.putObject(objectIdentifier, blob.slice(), 'blob')
      leaves.push({ childKind: 0, logicalLength: BigInt(blob.byteLength), objectHash })
      objectCount += 1
      pending = new Uint8Array(CHIRP_CHUNK_SIZE)
      pendingLength = 0
    }

    for await (const sourceChunk of toAsyncBytes(source, signal)) {
      let offset = 0
      while (offset < sourceChunk.byteLength) {
        const take = Math.min(CHIRP_CHUNK_SIZE - pendingLength, sourceChunk.byteLength - offset)
        const slice = sourceChunk.subarray(offset, offset + take)
        pending.set(slice, pendingLength)
        contentHasher.update(slice)
        pendingLength += take
        logicalLength += BigInt(take)
        offset += take
        if (pendingLength === CHIRP_CHUNK_SIZE) await flush()
      }
    }
    await flush()

    const { children, branchCount } = await buildBranchLevels(leaves, stableSink)
    objectCount += branchCount
    const extensions = mediaType == null ? [] : [mediaTypeExtension(mediaType)]
    const contentHash = contentHasher.digest()
    const rootBytes = encodeRootNode({
      chunkingProfile: CHIRP_PROFILE_FIXED_4_MIB,
      logicalLength,
      contentHash,
      children,
      extensions
    })
    const rootIdentifier = objectIdentifierForBytes(rootBytes)
    await stableSink.putObject(rootIdentifier, rootBytes.slice(), 'root')
    objectCount += 1
    const root: CHIRPRootNode = {
      majorVersion: CHIRP_MAJOR_VERSION,
      minorVersion: CHIRP_MINOR_VERSION,
      nodeKind: 0,
      chunkingProfile: CHIRP_PROFILE_FIXED_4_MIB,
      logicalLength,
      contentHash: contentHash.slice(),
      children: children.map(child => ({ ...child, objectHash: child.objectHash.slice() })),
      extensions: extensions.map(extension => ({ ...extension, value: extension.value.slice() }))
    }
    return {
      chirpURL: chirpURLForIdentifier(rootIdentifier),
      rootIdentifier,
      rootBytes,
      root,
      contentHash: contentHash.slice(),
      logicalLength,
      objectCount
    }
  }
}

function snapshotBuildInputs(
  source: CHIRPByteSource,
  options: CHIRPBuildOptions
): {
  source: CHIRPByteSource
  mediaType?: string
  sink: CHIRPObjectSink
  putObject: CHIRPObjectSink['putObject']
  signal?: AbortSignal
} {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  ) {
    throw new TypeError('CHIRP build options must be a plain object.')
  }
  const values = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'mediaType' && key !== 'sink' && key !== 'signal')) {
      throw new TypeError('CHIRP build options contain an unsupported property.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key)!
    if (!('value' in descriptor)) throw new TypeError('CHIRP build options cannot use accessors.')
    values[key] = descriptor.value
  }
  if (values.mediaType !== undefined && typeof values.mediaType !== 'string') {
    throw new TypeError('mediaType must be a string.')
  }
  if (values.signal !== undefined && !isAbortSignal(values.signal)) {
    throw new TypeError('signal must be an AbortSignal.')
  }
  const sink = (values.sink ?? NOOP_SINK) as CHIRPObjectSink
  const putObject = sink?.putObject
  if (sink === null || typeof sink !== 'object' || typeof putObject !== 'function') {
    throw new TypeError('CHIRP sink must implement putObject.')
  }
  if (source instanceof Uint8Array) source = source.slice()
  else if (Array.isArray(source)) {
    const copy: number[] = []
    for (let index = 0; index < source.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('CHIRP number-array sources must use own data properties.')
      }
      copy.push(descriptor.value as number)
    }
    source = copy
  }
  return {
    source,
    mediaType: values.mediaType as string | undefined,
    sink,
    putObject,
    signal: values.signal as AbortSignal | undefined
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The CHIRP build was aborted.', 'AbortError')
  }
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (signal == null) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The CHIRP build was aborted.', 'AbortError')
      )
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

const NOOP_SINK: CHIRPObjectSink = {
  async putObject() {}
}
