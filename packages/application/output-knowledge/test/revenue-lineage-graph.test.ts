import { afterEach, expect, it, jest } from '@jest/globals'
import { LockingScript, Spend, UnlockingScript, type Transaction } from '@bsv/sdk'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage
} from '../src/revenue-listing/LineagePackage.js'
import { executeListingInput, inspectLineage } from '../src/revenue-listing/LineageGraph.js'
import {
  atListing,
  changedGenesis,
  changedTarget,
  family,
  lineage
} from './revenue-lineage-fixture.js'

afterEach(() => {
  jest.restoreAllMocks()
})

function assemble(packet = lineage) {
  return assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({}))
}

function graph(change: (tx: Transaction) => void) {
  return inspectLineage(
    assembleLineage(parseRevenueListingLineagePackage(changedGenesis(change)), lineageLimits({})),
    family
  )
}

it('recognizes authorized genesis as a complete one-node graph with no covenant input', () => {
  const result = graph(() => {})
  expect(result.complete).toBe(true)
  if (!result.complete) throw new Error('Unexpected incomplete graph')
  expect(result.transitions).toHaveLength(1)
  expect(result.transitions[0].inputs).toEqual([])
  expect(result.satoshis).toBe(lineage.descriptor.reserve)
  expect(result.state).toEqual(lineage.descriptor.initialRevenue)
  expect(result.rawTransaction.length).toBeGreaterThan(0)
})

it('accepts ordinary zero-valued data and change outputs within genesis dimensions', () => {
  const result = graph(tx => {
    tx.version = 2
    tx.outputs.push({ satoshis: 0, lockingScript: LockingScript.fromASM('OP_FALSE OP_RETURN') })
    while (tx.outputs.length < 11)
      tx.outputs.push({ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') })
  })
  expect(result.complete).toBe(true)
})

it('rejects ordinary genesis outputs above the profile satoshi maximum', () => {
  expect(() =>
    graph(tx => {
      tx.outputs.push({
        satoshis: 2100000000000001,
        lockingScript: LockingScript.fromASM('OP_TRUE')
      })
    })
  ).toThrow('Invalid listing output value')
})

it.each<{ name: string; change: (tx: Transaction) => void; error: string }>([
  {
    name: 'unknown version',
    change: tx => {
      tx.version = 3
    },
    error: 'Invalid listing header'
  },
  {
    name: 'nonzero locktime',
    change: tx => {
      tx.lockTime = 1
    },
    error: 'Invalid listing header'
  },
  {
    name: 'missing input',
    change: tx => {
      tx.inputs = []
    },
    error: 'Listing dimensions exceed profile'
  },
  {
    name: 'too many inputs',
    change: tx => {
      tx.inputs = Array.from({ length: 9 }, () => ({ ...tx.inputs[0] }))
    },
    error: 'Listing dimensions exceed profile'
  },
  {
    name: 'too many outputs',
    change: tx => {
      tx.outputs = Array.from({ length: 12 }, () => ({ ...tx.outputs[0] }))
    },
    error: 'Listing dimensions exceed profile'
  },
  {
    name: 'non-final input',
    change: tx => {
      tx.inputs[0].sequence = 0xfffffffe
    },
    error: 'Non-final listing input'
  },
  {
    name: 'different anchor output',
    change: tx => {
      tx.inputs[0].sourceOutputIndex += 1
    },
    error: 'Genesis anchor mismatch'
  },
  {
    name: 'wrong reserve',
    change: tx => {
      tx.outputs[0].satoshis! += 1
    },
    error: 'Genesis issuance mismatch'
  },
  {
    name: 'wrong executable',
    change: tx => {
      tx.outputs[0].lockingScript = LockingScript.fromASM('OP_TRUE')
    },
    error: 'Genesis issuance mismatch'
  },
  {
    name: 'second listing',
    change: tx => {
      tx.outputs.push({ ...tx.outputs[0] })
    },
    error: 'Additional genesis listing'
  },
  {
    name: 'operation receipt',
    change: tx => {
      const receipt = [
        0,
        0x6a,
        0x4c,
        86,
        0x52,
        0x4f,
        0x53,
        0x4c,
        1,
        4,
        ...Array.from({ length: 80 }, () => 0)
      ]
      tx.outputs.push({ satoshis: 1, lockingScript: LockingScript.fromBinary(receipt) })
    },
    error: 'Genesis operation receipt forbidden'
  }
])('rejects $name independently of a valid genesis authorization', ({ change, error }) => {
  expect(() => graph(change)).toThrow(error)
})

it('reports incomplete ancestry without a fabricated target state', () => {
  const packet = structuredClone(lineage)
  packet.transactions = packet.transactions.filter(entry => entry.txid !== packet.target.txid)
  const result = inspectLineage(
    assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({})),
    family
  )
  expect(result).toEqual({ complete: false, missing: [packet.target] })
})

it.each([0, 1])('recognizes split successor %s with a deduplicated history', outputIndex => {
  const packet = atListing('split', outputIndex)
  const result = inspectLineage(
    assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({})),
    family
  )
  expect(result.complete).toBe(true)
  if (!result.complete) throw new Error('Unexpected incomplete graph')
  expect(result.transitions).toHaveLength(3)
  expect(result.transitions[0].inputs).toEqual([0])
  expect(result.state).toEqual(packet.descriptor.initialRevenue)
})

it.each<{ name: string; change: (tx: Transaction) => void; error: string }>([
  {
    name: 'missing argument',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks.pop()
    },
    error: 'Invalid listing unlocking ABI'
  },
  {
    name: 'non-push argument',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[2] = { op: 0x76 }
    },
    error: 'Non-push listing argument'
  },
  {
    name: 'nonminimal push',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[2] = { op: 0x4c, data: [6] }
    },
    error: 'Nonminimal listing argument'
  },
  {
    name: 'noncanonical numeric zero',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[5] = { op: 1, data: [0] }
    },
    error: 'Noncanonical listing integer'
  },
  {
    name: 'unknown route',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[2] = { op: 0x57 }
    },
    error: 'Unknown listing route'
  },
  {
    name: 'short preimage',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[0].data!.pop()
    },
    error: 'Invalid listing preimage size'
  },
  {
    name: 'retirement target',
    change: tx => {
      tx.inputs[0].unlockingScript!.chunks[2] = { op: 0x55 }
    },
    error: 'Not a listing successor'
  },
  {
    name: 'missing funding',
    change: tx => {
      tx.inputs = tx.inputs.slice(0, 1)
    },
    error: 'Listing dimensions exceed profile'
  }
])('rejects $name before covenant execution', ({ change, error }) => {
  const packet = changedTarget(lineage, change)
  expect(() =>
    inspectLineage(
      assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({})),
      family
    )
  ).toThrow(error)
})

it('rejects mixed routes at the two actual merge inputs', () => {
  const packet = changedTarget(atListing('merge'), tx => {
    const chunks = tx.inputs[1].unlockingScript!.chunks
    chunks[2] = { op: 0x52 }
    tx.inputs[1].unlockingScript = new UnlockingScript(chunks)
  })
  expect(() =>
    inspectLineage(
      assembleLineage(parseRevenueListingLineagePackage(packet), lineageLimits({})),
      family
    )
  ).toThrow('Mixed listing operations')
})

it('accepts eight genesis inputs and the exact maximum ordinary output value', () => {
  const result = graph(tx => {
    while (tx.inputs.length < 8)
      tx.inputs.push({ ...tx.inputs[0], sourceOutputIndex: tx.inputs.length })
    tx.outputs.push({ satoshis: 2100000000000000, lockingScript: LockingScript.fromASM('OP_TRUE') })
  })
  expect(result.complete).toBe(true)
})

it.each([-1, 0.5, Number.NaN, undefined])(
  'rejects malformed SDK output value %s at the graph boundary',
  satoshis => {
    const assembly = assemble(changedGenesis(() => {}))
    assembly.transactions
      .get(assembly.package.target.txid)!
      .outputs.push({ satoshis, lockingScript: LockingScript.fromASM('OP_TRUE') })
    expect(() => inspectLineage(assembly, family)).toThrow('Invalid listing output value')
  }
)

it('rejects zero outputs and a substituted anchor txid with precise graph diagnostics', () => {
  expect(() =>
    graph(tx => {
      tx.outputs = []
    })
  ).toThrow('Listing dimensions exceed profile')
  expect(() =>
    graph(tx => {
      tx.inputs[0].sourceTXID = 'a'.repeat(64)
    })
  ).toThrow('Genesis anchor mismatch')
})

function receiptBytes(length: number, route: number): number[] {
  return [
    0,
    0x6a,
    0x4c,
    length - 4,
    0x52,
    0x4f,
    0x53,
    0x4c,
    1,
    route,
    ...Array.from({ length: length - 10 }, () => 0)
  ]
}

it.each([90, 171])('rejects every ROSL route in a %s-byte genesis receipt', length => {
  for (const route of [1, 2, 3, 4, 5, 6]) {
    expect(() =>
      graph(tx => {
        tx.outputs.push({
          satoshis: 1,
          lockingScript: LockingScript.fromBinary(receiptBytes(length, route))
        })
      })
    ).toThrow('Genesis operation receipt forbidden')
  }
})

it.each([
  { name: 'different length', length: 89 },
  { name: 'ordinary first opcode', offset: 0, byte: 0x51 },
  { name: 'non-return output', offset: 1, byte: 0x61 },
  { name: 'non-receipt push form', offset: 2, byte: 0x61 },
  { name: 'different magic', offset: 4, byte: 0x58 },
  { name: 'route zero', offset: 9, byte: 0 },
  { name: 'another route domain', offset: 9, byte: 7 }
])(
  'allows ordinary genesis data with $name without treating it as ROSL',
  ({ length, offset, byte }) => {
    const bytes = receiptBytes(length ?? 90, 1)
    if (offset !== undefined) bytes[offset] = byte!
    expect(
      graph(tx => {
        tx.outputs.push({ satoshis: 1, lockingScript: LockingScript.fromBinary(bytes) })
      }).complete
    ).toBe(true)
  }
)

it.each([
  { name: 'zero route', index: 2, chunk: { op: 0 }, error: 'Unknown listing route' },
  {
    name: 'multibyte route',
    index: 2,
    chunk: { op: 2, data: [1, 1] },
    error: 'Unknown listing route'
  },
  {
    name: 'opcode below push-integer range',
    index: 4,
    chunk: { op: 0x50 },
    error: 'Non-push listing argument'
  }
])('rejects $name at the ABI boundary', ({ index, chunk, error }) => {
  const packet = changedTarget(lineage, tx => {
    tx.inputs[0].unlockingScript!.chunks[index] = chunk
  })
  expect(() => inspectLineage(assemble(packet), family)).toThrow(error)
})

it('recognizes canonical OP_16 numeric arguments without treating graph inspection as Script verification', () => {
  const packet = changedTarget(lineage, tx => {
    tx.inputs[0].unlockingScript!.chunks[5] = { op: 0x60 }
  })
  expect(inspectLineage(assemble(packet), family).complete).toBe(true)
})

it('rejects an absent unlocking script and a fifteenth argument explicitly', () => {
  const assembly = assemble()
  assembly.transactions.get(lineage.target.txid)!.inputs[0].unlockingScript = undefined
  expect(() => inspectLineage(assembly, family)).toThrow('Invalid listing unlocking ABI')
  const extra = changedTarget(lineage, tx => {
    tx.inputs[0].unlockingScript!.chunks.push({ op: 0 })
  })
  expect(() => inspectLineage(assemble(extra), family)).toThrow('Invalid listing unlocking ABI')
})

it('requires a separate funding input for a two-listing merge', () => {
  const packet = changedTarget(atListing('merge'), tx => {
    tx.inputs = tx.inputs.slice(0, 2)
  })
  expect(() => inspectLineage(assemble(packet), family)).toThrow('Missing external funding')
})

it('requires a split successor to exist, occupy its prescribed position and retain reserve', () => {
  const missing = changedTarget(atListing('split', 1), tx => {
    tx.outputs = tx.outputs.slice(0, 1)
  })
  expect(() => inspectLineage(assemble(missing), family)).toThrow('Missing listing output')
  const outside = atListing('split', 2)
  expect(() => inspectLineage(assemble(outside), family)).toThrow('Not a listing successor')
  const depleted = changedTarget(atListing('split', 1), tx => {
    tx.outputs[1].satoshis = 0
  })
  expect(() => inspectLineage(assemble(depleted), family)).toThrow('Listing below reserve')
})

it.each(['missing', 'wrong-identity', 'missing-output'] as const)(
  'rejects a %s actual Script predecessor before evaluation',
  mode => {
    const assembly = assemble(atListing('purchase'))
    const transaction = assembly.transactions.get(assembly.package.target.txid)!
    const sourceId = transaction.inputs[0].sourceTXID!
    if (mode === 'missing') assembly.transactions.delete(sourceId)
    else if (mode === 'wrong-identity') assembly.transactions.set(sourceId, transaction)
    else transaction.inputs[0].sourceOutputIndex = 0xffffffff
    const interpreter = jest.spyOn(Spend.prototype, 'validateJavaScript')
    expect(() => executeListingInput(assembly, { transaction, inputs: [0] }, 0, 134217728)).toThrow(
      mode === 'missing-output'
        ? 'Listing predecessor output missing'
        : 'Listing predecessor unavailable'
    )
    expect(interpreter).not.toHaveBeenCalled()
  }
)

it('preserves a false interpreter result as an explicit covenant rejection', () => {
  const assembly = assemble(atListing('purchase'))
  const transaction = assembly.transactions.get(assembly.package.target.txid)!
  jest.spyOn(Spend.prototype, 'validateJavaScript').mockReturnValue(false)
  expect(() => executeListingInput(assembly, { transaction, inputs: [0] }, 0, 134217728)).toThrow(
    'Listing covenant rejected'
  )
})
