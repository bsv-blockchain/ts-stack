import { createHash } from 'node:crypto'
import { brc38StagingBinding } from './Brc38StagingBinding'

describe('portable private binding preserves the original Node digest', () => {
  test.each(['ordinary identity', 'é/雪/😀', 'x'.repeat(256)])('independent UTF8 digest: %s', identity => {
    const binding = {
        archiveSha256: 'a'.repeat(64),
        identityKey: identity,
        chain: 'test' as const,
        sourceStorageIdentityKey: 'source/雪',
        targetStorageIdentityKey: 'target/😀',
        targetGeneration: Number.MAX_SAFE_INTEGER
      },
      limits = {
        maximumRows: 1000000000,
        maximumLogicalBytes: 17179869184,
        maximumPhysicalBytes: 17179869184,
        maximumRowBytes: 1048576,
        maximumRowAllocationBytes: 16777216,
        expiresAt: 1791350000000
      },
      expectedBinding = JSON.stringify(binding),
      expectedLimits = JSON.stringify([
        limits.maximumRows,
        limits.maximumLogicalBytes,
        limits.maximumPhysicalBytes,
        limits.maximumRowBytes,
        limits.maximumRowAllocationBytes,
        limits.expiresAt
      ]),
      originalNodeDigest = createHash('sha256')
        .update(JSON.stringify(['brc38-resumable-private/v1', expectedBinding, expectedLimits]), 'utf8')
        .digest('hex'),
      actual = brc38StagingBinding(binding, limits)
    expect(actual.bindingJson).toBe(expectedBinding)
    expect(actual.limitsJson).toBe(expectedLimits)
    expect(actual.digest).toBe(originalNodeDigest)
  })
})
