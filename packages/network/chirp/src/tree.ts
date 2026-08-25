import { CHIRP_FANOUT } from './constants.js'
import { encodeBranchNode, sumLogicalLength } from './codec.js'
import { objectIdentifierForBytes, sha256 } from './hash.js'
import type { CHIRPChildReference, CHIRPObjectSink } from './types.js'

export async function buildBranchLevels(
  leaves: CHIRPChildReference[],
  sink: CHIRPObjectSink = NOOP_SINK
): Promise<{ children: CHIRPChildReference[]; branchCount: number }> {
  let references = leaves.map(cloneReference)
  let branchCount = 0
  while (references.length > CHIRP_FANOUT) {
    const next: CHIRPChildReference[] = []
    for (let offset = 0; offset < references.length; offset += CHIRP_FANOUT) {
      const children = references.slice(offset, offset + CHIRP_FANOUT)
      const logicalLength = sumLogicalLength(children)
      const bytes = encodeBranchNode({ logicalLength, children, extensions: [] })
      const objectHash = sha256(bytes)
      const objectIdentifier = objectIdentifierForBytes(bytes)
      await sink.putObject(objectIdentifier, bytes, 'branch')
      next.push({ childKind: 1, logicalLength, objectHash })
      branchCount += 1
    }
    references = next
  }
  return { children: references, branchCount }
}

function cloneReference(reference: CHIRPChildReference): CHIRPChildReference {
  return {
    childKind: reference.childKind,
    logicalLength: reference.logicalLength,
    objectHash: reference.objectHash.slice()
  }
}

const NOOP_SINK: CHIRPObjectSink = {
  async putObject() {}
}
