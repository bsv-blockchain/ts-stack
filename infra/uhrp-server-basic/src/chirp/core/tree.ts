import { CHIRP_PROFILE_1_FANOUT } from './constants.js'
import { encodeBranchNode, sumLogicalLength } from './codec.js'
import { CHIRPError } from './errors.js'
import { objectIdentifierForBytes, sha256 } from './hash.js'
import type { CHIRPChildReference, CHIRPObjectSink } from './types.js'

export async function buildBranchLevels(
  leaves: CHIRPChildReference[],
  sink: CHIRPObjectSink = NOOP_SINK
): Promise<{ children: CHIRPChildReference[]; branchCount: number }> {
  if (!Array.isArray(leaves)) {
    throw new CHIRPError('ERR_CHIRP_FANOUT', 'CHIRP leaves must be an array.')
  }
  const putObject = sink?.putObject
  if (sink === null || typeof sink !== 'object' || typeof putObject !== 'function') {
    throw new TypeError('CHIRP sink must implement putObject.')
  }
  const referencesAtLeafLevel: CHIRPChildReference[] = []
  for (let index = 0; index < leaves.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(leaves, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new CHIRPError('ERR_CHIRP_FANOUT', 'CHIRP leaves must be a dense data array.')
    }
    referencesAtLeafLevel.push(cloneReference(descriptor.value as CHIRPChildReference))
  }
  let references = referencesAtLeafLevel
  let branchCount = 0
  while (references.length > CHIRP_PROFILE_1_FANOUT) {
    const next: CHIRPChildReference[] = []
    for (let offset = 0; offset < references.length; offset += CHIRP_PROFILE_1_FANOUT) {
      const children = references.slice(offset, offset + CHIRP_PROFILE_1_FANOUT)
      const logicalLength = sumLogicalLength(children)
      const bytes = encodeBranchNode({ logicalLength, children, extensions: [] })
      const objectHash = sha256(bytes)
      const objectIdentifier = objectIdentifierForBytes(bytes)
      await Reflect.apply(putObject, sink, [objectIdentifier, bytes.slice(), 'branch'])
      next.push({ childKind: 1, logicalLength, objectHash })
      branchCount += 1
    }
    references = next
  }
  return { children: references, branchCount }
}

function cloneReference(reference: CHIRPChildReference): CHIRPChildReference {
  if (
    reference === null ||
    typeof reference !== 'object' ||
    (reference.childKind !== 0 && reference.childKind !== 1) ||
    typeof reference.logicalLength !== 'bigint' ||
    reference.logicalLength < 0n ||
    reference.logicalLength > 0xffffffffffffffffn ||
    !(reference.objectHash instanceof Uint8Array) ||
    reference.objectHash.byteLength !== 32
  ) {
    throw new CHIRPError('ERR_CHIRP_CHILD_KIND', 'Invalid CHIRP child reference.')
  }
  return {
    childKind: reference.childKind,
    logicalLength: reference.logicalLength,
    objectHash: reference.objectHash.slice()
  }
}

const NOOP_SINK: CHIRPObjectSink = {
  async putObject() {}
}
