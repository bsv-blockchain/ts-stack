import { beforeAll, expect, it } from '@jest/globals'
import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import {
  assembleLineage,
  lineageLimits,
  type LineageAssembly
} from '../src/revenue-listing/LineagePackage.js'
import {
  inspectProfileTransition,
  inspectProfileLineage,
  executeProfileInput,
  executeProfileInputs
} from '../src/revenue-listing/ProfileLineageGraph.js'
import type { RevenueListingProfileDescriptor } from '@bsv/sdk/script/templates/RevenueListingProfile'
import {
  atGenesis,
  purchased,
  purchaseTransaction,
  construct,
  profile
} from './revenue-profile.fixture.js'

type Assembly = LineageAssembly<RevenueListingProfileDescriptor>
type Case = { assembly: Assembly; tx: Transaction }
function candidate(genesis = false): Case {
  const packet = genesis ? atGenesis() : purchased()
  const assembly = assembleLineage(packet, lineageLimits({}))
  return { assembly, tx: assembly.transactions.get(packet.target.txid)! }
}
function genesis(change: (value: Case) => void): Case {
  const value = candidate(true)
  change(value)
  // Layout inspection follows byte/authorization verification. Give a changed
  // synthetic genesis its real new identity, without asserting authorization.
  value.assembly.package.genesis.body.genesis.txid = value.tx.id('hex')
  return value
}
function receipt(tx: Transaction, index: number, change: (bytes: number[]) => void) {
  const bytes = tx.outputs[index].lockingScript.toBinary()
  change(bytes)
  tx.outputs[index].lockingScript = LockingScript.fromBinary(bytes)
}
const plain = () => LockingScript.fromASM('OP_TRUE')

it.each([
  [
    'txid',
    (v: Case) => {
      v.tx.inputs[0].sourceTXID = '00'.repeat(32)
    }
  ],
  [
    'index',
    (v: Case) => {
      v.tx.inputs[0].sourceOutputIndex++
    }
  ]
] as const)('requires the exact genesis anchor %s', (_name, change) => {
  const { tx, assembly } = genesis(change)
  expect(() => inspectProfileTransition(tx, assembly, profile)).toThrow('Genesis anchor mismatch')
})

it.each([
  [
    'value',
    (v: Case) => {
      v.tx.outputs[0].satoshis!++
    }
  ],
  [
    'program',
    (v: Case) => {
      v.tx.outputs[0].lockingScript = plain()
    }
  ]
] as const)('requires the exact genesis activation %s', (_name, change) => {
  const { tx, assembly } = genesis(change)
  expect(() => inspectProfileTransition(tx, assembly, profile)).toThrow(
    'Genesis activation issuance mismatch'
  )
})

it.each(['activation', 'active'] as const)(
  'rejects an additional frozen %s family output',
  stage => {
    const script = profile.lock(stage, atGenesis().descriptor)
    const { tx, assembly } = genesis(v => {
      v.tx.outputs.push({ satoshis: 1, lockingScript: script })
    })
    expect(() => inspectProfileTransition(tx, assembly, profile)).toThrow(
      'Additional genesis family listing'
    )
  }
)

it.each(['activation', 'active'] as const)(
  'does not confuse a %s program lookalike with the frozen family',
  stage => {
    for (const form of ['short', 'long', 'changed'] as const) {
      const script = profile.lock(stage, atGenesis().descriptor).toBinary()
      if (form === 'short') script.pop()
      else if (form === 'long') script.push(0)
      else script[script.length - 1] ^= 1
      const { tx, assembly } = genesis(v => {
        v.tx.outputs.push({ satoshis: 0, lockingScript: LockingScript.fromBinary(script) })
      })
      expect(inspectProfileTransition(tx, assembly, profile).parent).toBeUndefined()
    }
  }
)

it('forbids a purchase receipt in genesis but permits an unrelated data output', () => {
  const output = purchaseTransaction().outputs[1]
  const rejected = genesis(v => {
    v.tx.outputs.push(output)
  })
  expect(() => inspectProfileTransition(rejected.tx, rejected.assembly, profile)).toThrow(
    'Genesis purchase receipt forbidden'
  )
  const allowed = genesis(v => {
    v.tx.outputs.push({ ...output, lockingScript: LockingScript.fromBinary([0, 106, 1, 1]) })
  })
  expect(inspectProfileTransition(allowed.tx, allowed.assembly, profile).parent).toBeUndefined()
})

it('preserves one-input/one-output genesis and the exact monetary ceiling on unrelated outputs', () => {
  for (const amount of [0, 2100000000000000]) {
    const { tx, assembly } = genesis(v => {
      v.tx.inputs.splice(1)
      v.tx.outputs.splice(1)
      v.tx.outputs.push({ satoshis: amount, lockingScript: plain() })
    })
    expect(inspectProfileTransition(tx, assembly, profile).parent).toBeUndefined()
  }
  const one = genesis(v => {
    v.tx.inputs.splice(1)
    v.tx.outputs.splice(1)
  })
  expect(inspectProfileTransition(one.tx, one.assembly, profile).parent).toBeUndefined()
  const over = genesis(v => {
    v.tx.outputs.push({ satoshis: 2100000000000001, lockingScript: plain() })
  })
  expect(() => inspectProfileTransition(over.tx, over.assembly, profile)).toThrow(
    'Invalid listing output value'
  )
})

it.each([
  [
    'one input',
    (v: Case) => {
      v.tx.inputs.splice(1)
    }
  ],
  [
    'nine inputs',
    (v: Case) => {
      while (v.tx.inputs.length < 9) v.tx.inputs.push({ ...v.tx.inputs[1] })
    }
  ],
  [
    'zero outputs',
    (v: Case) => {
      v.tx.outputs.length = 0
    }
  ],
  [
    'twelve outputs',
    (v: Case) => {
      while (v.tx.outputs.length < 12) v.tx.outputs.push({ satoshis: 1, lockingScript: plain() })
    }
  ]
] as const)('bounds non-genesis dimensions: %s', (_name, change) => {
  const v = candidate()
  change(v)
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'Listing dimensions exceed profile'
  )
})

it.each([
  [
    'missing',
    (v: Case) => {
      v.tx.outputs[1].lockingScript = plain()
    }
  ],
  [
    'duplicate',
    (v: Case) => {
      v.tx.outputs.push({ ...v.tx.outputs[1] })
    }
  ],
  [
    'wrong prefix',
    (v: Case) => {
      receipt(v.tx, 1, bytes => {
        bytes[4] ^= 1
      })
    }
  ]
] as const)('requires exactly one authenticated operation receipt: %s', (_name, change) => {
  const v = candidate()
  change(v)
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'Exactly one listing operation receipt required'
  )
})

it('rejects an unknown receipt operation before planning a transition', () => {
  const v = candidate()
  receipt(v.tx, 1, bytes => {
    bytes[9] = 99
  })
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'Unknown immutable listing route'
  )
})

let split: Transaction, payout: Transaction, retired: Transaction
beforeAll(async () => {
  split = await construct(purchaseTransaction(), 0, { operation: 'split', firstAmount: '501' })
  payout = await construct(purchaseTransaction(), 0, { operation: 'payout', units: '99' })
  retired = await construct(purchaseTransaction(), 0, { operation: 'retire', authority: 'seller' })
})

it.each(['purchase', 'split', 'payout', 'retirement'] as const)(
  'binds %s receipt position and size',
  operation => {
    const original =
      operation === 'purchase'
        ? purchaseTransaction()
        : operation === 'split'
          ? split
          : operation === 'payout'
            ? payout
            : retired
    const index = operation === 'split' ? 2 : operation === 'retirement' ? 0 : 1
    const reason = `Invalid ${operation === 'retirement' ? 'retirement' : operation} receipt position`
    for (const change of ['position', 'size'] as const) {
      const v = candidate()
      v.tx = Transaction.fromHex(original.toHex())
      if (change === 'position')
        [v.tx.outputs[index], v.tx.outputs[index + 1]] = [
          v.tx.outputs[index + 1],
          v.tx.outputs[index]
        ]
      else
        receipt(v.tx, index, bytes => {
          const length = bytes.length === 171 ? 90 : 171
          bytes.length = length
          for (let i = 0; i < length; i++) bytes[i] ??= 0
          bytes.splice(
            0,
            9,
            ...(length === 171
              ? [0, 106, 76, 167, 82, 79, 83, 76, 1]
              : [0, 106, 76, 86, 82, 79, 83, 76, 1])
          )
        })
      expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(reason)
    }
  }
)

it.each([0n, 1n, 11n])('refuses payout outside a positive complete quantum: %s', amount => {
  const v = candidate()
  v.tx = Transaction.fromHex(payout.toHex())
  receipt(v.tx, 1, bytes => {
    const data = Uint8Array.from(bytes)
    new DataView(data.buffer).setBigUint64(50, amount, true)
    bytes.splice(0, bytes.length, ...data)
  })
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'Invalid payout quantum'
  )
})

it.each([
  [
    'listing predecessor',
    (v: Case) => {
      v.assembly.transactions.delete(v.tx.inputs[0].sourceTXID!)
    },
    'Listing predecessor raw bytes unavailable'
  ],
  [
    'listing output',
    (v: Case) => {
      v.tx.inputs[0].sourceOutputIndex = 999
    },
    'Listing predecessor output missing'
  ],
  [
    'duplicate input',
    (v: Case) => {
      v.tx.inputs.push({ ...v.tx.inputs[1] })
    },
    'Duplicate listing input'
  ],
  [
    'funding predecessor',
    (v: Case) => {
      v.assembly.transactions.delete(v.tx.inputs[1].sourceTXID!)
    },
    'Funding predecessor raw bytes unavailable'
  ],
  [
    'funding identity',
    (v: Case) => {
      v.assembly.transactions.set(v.tx.inputs[1].sourceTXID!, new Transaction())
    },
    'Funding predecessor raw bytes unavailable'
  ],
  [
    'funding output',
    (v: Case) => {
      v.tx.inputs[1].sourceOutputIndex = 999
    },
    'Invalid funding output'
  ],
  [
    'mandatory value',
    (v: Case) => {
      v.tx.outputs[0].satoshis!++
    },
    'Listing mandatory output differs'
  ],
  [
    'mandatory program',
    (v: Case) => {
      v.tx.outputs[0].lockingScript = plain()
    },
    'Listing mandatory output differs'
  ],
  [
    'zero change',
    (v: Case) => {
      v.tx.outputs[v.tx.outputs.length - 1].satoshis = 0
    },
    'Listing outputs must be positive'
  ],
  [
    'excess outputs',
    (v: Case) => {
      v.tx.outputs.push({ satoshis: 1, lockingScript: plain() })
    },
    'Listing output count differs'
  ],
  [
    'change type',
    (v: Case) => {
      v.tx.outputs[v.tx.outputs.length - 1].lockingScript = plain()
    },
    'Only one final P2PKH change output is allowed'
  ],
  [
    'inflation',
    (v: Case) => {
      v.tx.outputs[v.tx.outputs.length - 1].satoshis! += 1000000
    },
    'Listing transaction does not conserve value'
  ]
] as const)('rejects inconsistent transition %s', (_name, change, reason) => {
  const v = candidate()
  change(v)
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(reason)
})

it.each([-1, 0.5, 0x100000000])('rejects invalid input sequence %s', sequence => {
  const v = candidate()
  v.tx.inputs[1].sequence = sequence
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'sequence must be an unsigned 32-bit integer'
  )
})

it.each([
  ['inputs', 8, 'Duplicate listing input'],
  ['outputs', 11, 'Listing output count differs']
] as const)('admits the inclusive %s dimension before enforcing layout', (kind, size, reason) => {
  const v = candidate()
  if (kind === 'inputs') while (v.tx.inputs.length < size) v.tx.inputs.push({ ...v.tx.inputs[1] })
  else while (v.tx.outputs.length < size) v.tx.outputs.push({ satoshis: 1, lockingScript: plain() })
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(reason)
})

it('permits sequence zero as a bounded header without claiming Script authorization', () => {
  const v = candidate()
  v.tx.inputs[1].sequence = 0
  expect(inspectProfileTransition(v.tx, v.assembly, profile).parent).toEqual({
    chain: v.assembly.package.descriptor.chain,
    txid: v.tx.inputs[0].sourceTXID,
    outputIndex: v.tx.inputs[0].sourceOutputIndex
  })
})

it.each(['short-receipt', 'other-operation', 'different-prefix'] as const)(
  'permits unrelated genesis metadata without interpreting it as a purchase: %s',
  kind => {
    const bytes = purchaseTransaction().outputs[1].lockingScript.toBinary()
    if (kind === 'short-receipt') {
      bytes.length = 90
      bytes.splice(0, 9, 0, 106, 76, 86, 82, 79, 83, 76, 1)
    } else if (kind === 'other-operation') bytes[9] = 2
    else bytes[4] ^= 1
    const v = genesis(value => {
      value.tx.outputs.push({ satoshis: 0, lockingScript: LockingScript.fromBinary(bytes) })
    })
    expect(inspectProfileTransition(v.tx, v.assembly, profile).parent).toBeUndefined()
  }
)

it('rejects an independently retained family output used as additional route funding', () => {
  const v = candidate(),
    anchor = v.assembly.package.genesis.body.genesis
  v.tx.inputs.push({
    ...v.tx.inputs[1],
    sourceTXID: anchor.txid,
    sourceOutputIndex: anchor.outputIndex
  })
  expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
    'Additional family listing cannot fund a route'
  )
})

it.each(['prefix', 'suffix'] as const)(
  'rejects extra opcodes around final P2PKH change: %s',
  side => {
    const v = candidate(),
      output = v.tx.outputs.at(-1)!,
      bytes = output.lockingScript.toBinary()
    if (side === 'prefix') bytes.unshift(97)
    else bytes.push(97)
    output.lockingScript = LockingScript.fromBinary(bytes)
    expect(() => inspectProfileTransition(v.tx, v.assembly, profile)).toThrow(
      'Only one final P2PKH change output is allowed'
    )
  }
)

it('permits exact input/output conservation without requiring a positive fee', () => {
  const v = candidate(),
    inputTotal = v.tx.inputs.reduce((sum, input) => {
      const source = v.assembly.transactions.get(input.sourceTXID!)!
      return sum + source.outputs[input.sourceOutputIndex].satoshis!
    }, 0),
    mandatory = v.tx.outputs.slice(0, -1).reduce((sum, output) => sum + output.satoshis!, 0)
  v.tx.outputs.at(-1)!.satoshis = inputTotal - mandatory
  expect(inspectProfileTransition(v.tx, v.assembly, profile).plan?.operation).toBe('purchase')
})

it('rejects unrelated declared history and out-of-range successor selection', () => {
  const unrelated = candidate()
  unrelated.assembly.entries.add('00'.repeat(32))
  expect(() => inspectProfileLineage(unrelated.assembly, profile)).toThrow(
    'Unrelated listing entries'
  )
  const successor = candidate()
  successor.assembly.package.target.outputIndex = 1
  expect(() => inspectProfileLineage(successor.assembly, profile)).toThrow(
    'Not a listing successor'
  )
})

it.each(['predecessor', 'output', 'unlocking', 'signature'] as const)(
  'executes every actual input and refuses missing/invalid %s',
  kind => {
    const v = candidate()
    if (kind === 'predecessor') v.assembly.transactions.delete(v.tx.inputs[1].sourceTXID!)
    else if (kind === 'output')
      v.assembly.transactions.get(v.tx.inputs[1].sourceTXID!)!.outputs.length = 0
    else if (kind === 'unlocking') v.tx.inputs[1].unlockingScript = undefined
    else v.tx.inputs[1].unlockingScript = UnlockingScript.fromASM('OP_FALSE')
    const reason =
      kind === 'predecessor'
        ? 'Input predecessor raw bytes unavailable'
        : kind === 'signature'
          ? 'Script evaluation error:'
          : 'Input Script unavailable'
    expect(() => executeProfileInput(v.assembly, v.tx, 1, 134217728)).toThrow(reason)
    expect(() => executeProfileInputs(v.assembly, v.tx, 134217728)).toThrow(reason)
  }
)
