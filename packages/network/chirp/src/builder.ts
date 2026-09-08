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
    const sink = options.sink ?? NOOP_SINK
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
      await sink.putObject(objectIdentifier, blob, 'blob')
      leaves.push({ childKind: 0, logicalLength: BigInt(blob.byteLength), objectHash })
      objectCount += 1
      pending = new Uint8Array(CHIRP_CHUNK_SIZE)
      pendingLength = 0
    }

    for await (const sourceChunk of toAsyncBytes(source)) {
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

    const { children, branchCount } = await buildBranchLevels(leaves, sink)
    objectCount += branchCount
    const extensions = options.mediaType == null ? [] : [mediaTypeExtension(options.mediaType)]
    const contentHash = contentHasher.digest()
    const rootBytes = encodeRootNode({
      chunkingProfile: CHIRP_PROFILE_FIXED_4_MIB,
      logicalLength,
      contentHash,
      children,
      extensions
    })
    const rootIdentifier = objectIdentifierForBytes(rootBytes)
    await sink.putObject(rootIdentifier, rootBytes, 'root')
    objectCount += 1
    const root: CHIRPRootNode = {
      majorVersion: CHIRP_MAJOR_VERSION,
      minorVersion: CHIRP_MINOR_VERSION,
      nodeKind: 0,
      chunkingProfile: CHIRP_PROFILE_FIXED_4_MIB,
      logicalLength,
      contentHash,
      children,
      extensions
    }
    return {
      chirpURL: chirpURLForIdentifier(rootIdentifier),
      rootIdentifier,
      rootBytes,
      root,
      contentHash,
      logicalLength,
      objectCount
    }
  }
}

const NOOP_SINK: CHIRPObjectSink = {
  async putObject() {}
}
