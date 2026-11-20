import { brc38StructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import type { Brc38PrivateStructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import {
  brc38StructuredRestoreResourceData,
  brc38StructuredRestoreResourcesFromData,
  type Brc38StructuredRestoreResourceData
} from './Brc38StructuredRestoreResourcesNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

// Original resource DATA only; no descriptor or successful capture can enroll
// a private native owner, import, copied profile or physical resource.
const limits: KnexBrc38StagingLimits = {
  maximumRows: 1000,
  maximumLogicalBytes: 16777216,
  maximumPhysicalBytes: 16777216,
  maximumRowBytes: 1048576,
  maximumRowAllocationBytes: 65536,
  expiresAt: Date.now() + 300000
}
const resource = (): Brc38PrivateStructuredRestoreResources => ({
  sourcePolicy: {
    privateIndexParent: '/private/brc38-index-fixture',
    maximumTemporaryIndexBytes: 1048576,
    maximumIndexMembers: 1000,
    maximumStructuredBytes: 1000000,
    maximumCanonicalBytes: 1000000,
    maximumReadBytes: 1024,
    maximumIndexAllocationBytes: 16384,
    maximumGrammarAllocationBytes: 32768
  },
  projectionPolicy: {
    privateParent: '/private/brc38-index-fixture',
    maximumTemporaryFileBytes: 2097152,
    maximumMembers: 1000,
    maximumOutputBytes: 1000000,
    maximumScalarBytes: 128,
    maximumReadBytes: 1024,
    maximumIndexAllocationBytes: 8192,
    maximumGrammarAllocationBytes: 16384,
    expiresAt: limits.expiresAt
  },
  maximumCombinedTemporaryBytes: 3145728
})

test('resource capture keeps source and projection bounds across caller mutation', () => {
  const input = resource(),
    captured = brc38StructuredRestoreResources(limits, input, 65536)
  Object.assign(input.sourcePolicy, {
    maximumReadBytes: 65536,
    maximumIndexAllocationBytes: 65536,
    maximumGrammarAllocationBytes: 65536
  })
  Object.assign(input.projectionPolicy, {
    maximumReadBytes: 65536,
    maximumIndexAllocationBytes: 65536,
    maximumGrammarAllocationBytes: 65536
  })
  expect(captured.sourcePolicy.maximumReadBytes).toBe(1024)
  expect(captured.sourcePolicy.maximumIndexAllocationBytes).toBe(16384)
  expect(captured.sourcePolicy.maximumGrammarAllocationBytes).toBe(32768)
  expect(captured.projectionPolicy.maximumReadBytes).toBe(1024)
  expect(captured.projectionPolicy.maximumIndexAllocationBytes).toBe(8192)
  expect(captured.projectionPolicy.maximumGrammarAllocationBytes).toBe(16384)
  expect(Object.isFrozen(captured.sourcePolicy)).toBe(true)
  expect(Object.isFrozen(captured.projectionPolicy)).toBe(true)
})
test('original allocation cannot be widened by later source or projection limits', () => {
  const input = resource()
  expect(() =>
    brc38StructuredRestoreResources(
      limits,
      { ...input, sourcePolicy: { ...input.sourcePolicy, maximumIndexAllocationBytes: 65537 } },
      65536
    )
  ).toThrow(RangeError)
  expect(() =>
    brc38StructuredRestoreResources(
      limits,
      { ...input, projectionPolicy: { ...input.projectionPolicy, maximumIndexAllocationBytes: 65537 } },
      65536
    )
  ).toThrow(RangeError)
  expect(() =>
    brc38StructuredRestoreResources(
      limits,
      { ...input, sourcePolicy: { ...input.sourcePolicy, maximumGrammarAllocationBytes: 65537 } },
      65536
    )
  ).toThrow(RangeError)
  expect(() =>
    brc38StructuredRestoreResources(
      limits,
      { ...input, projectionPolicy: { ...input.projectionPolicy, maximumGrammarAllocationBytes: 65537 } },
      65536
    )
  ).toThrow(RangeError)
  for (const maximumReadBytes of [63, 65537, NaN])
    expect(() =>
      brc38StructuredRestoreResources(
        limits,
        { ...input, projectionPolicy: { ...input.projectionPolicy, maximumReadBytes } },
        65536
      )
    ).toThrow(RangeError)
})

test('JSON retains the original smaller ceiling without serializing its live allocation or signal', () => {
  const owner = new Brc38WorkingAllocation(49152),
    charge = owner.claim(1024),
    signal = new AbortController().signal,
    input = resource(),
    captured = brc38StructuredRestoreResources(
      limits,
      {
        ...input,
        sourcePolicy: { ...input.sourcePolicy, workingAllocation: owner, signal },
        projectionPolicy: { ...input.projectionPolicy, workingAllocation: owner, signal }
      },
      65536
    )
  try {
    const data = JSON.parse(
        JSON.stringify(brc38StructuredRestoreResourceData(captured))
      ) as Brc38StructuredRestoreResourceData,
      replay = brc38StructuredRestoreResourcesFromData(limits, data, 65536)
    expect(data.maximumWorkingAllocationBytes).toBe(49152)
    for (const policy of [data.sourcePolicy, data.projectionPolicy]) {
      expect(Object.hasOwn(policy, 'workingAllocation')).toBe(false)
      expect(Object.hasOwn(policy, 'signal')).toBe(false)
    }
    expect(replay.sourcePolicy.workingAllocation).toBeUndefined()
    expect(replay.projectionPolicy.workingAllocation).toBeUndefined()
    expect(replay.maximumWorkingAllocationBytes).toBe(49152)
    expect(owner.used).toBe(1024)
  } finally {
    charge.close()
  }
  expect(owner.used).toBe(0)
})

test('persisted resource data cannot supply a serialized owner, cancellation actor or wider ceiling', () => {
  const data = brc38StructuredRestoreResourceData(resource())
  for (const key of ['sourcePolicy', 'projectionPolicy'] as const)
    for (const field of ['workingAllocation', 'signal']) {
      const forged = JSON.parse(JSON.stringify(data)) as Brc38StructuredRestoreResourceData
      Object.assign(forged[key], { [field]: {} })
      expect(() => brc38StructuredRestoreResourcesFromData(limits, forged, 65536)).toThrow(RangeError)
    }
  for (const maximumWorkingAllocationBytes of [0, -1, 65537, 16777217, NaN, 1.5])
    expect(() =>
      brc38StructuredRestoreResourcesFromData(
        limits,
        {
          ...data,
          maximumWorkingAllocationBytes
        },
        65536
      )
    ).toThrow(RangeError)
  expect(brc38StructuredRestoreResourcesFromData(limits, data, 65536).maximumWorkingAllocationBytes).toBe(65536)
})
