import { createHash } from 'node:crypto'
import { semanticStageFixture, options } from './Brc38SemanticStageFixture'
import type { Brc38StagingBinding } from './Brc38StagingBinding'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'

export function resumeBinding(): Brc38StagingBinding {
  return {
    archiveSha256: createHash('sha256').update(JSON.stringify(semanticStageFixture())).digest('hex'),
    identityKey: options.expectedIdentityKey,
    chain: options.expectedChain,
    sourceStorageIdentityKey: options.expectedSourceStorageIdentityKey,
    targetStorageIdentityKey: 'synthetic target',
    targetGeneration: 7
  }
}
export function resumeLimits(): KnexBrc38StagingLimits {
  return {
    maximumRows: 10000,
    maximumLogicalBytes: 1048576,
    maximumPhysicalBytes: 4194304,
    maximumRowBytes: 65536,
    maximumRowAllocationBytes: 65536,
    expiresAt: Date.now() + 60000
  }
}
