import { describe, expect, test } from '@jest/globals'
import { Beef, LockingScript, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { TX_UTILS_SOURCE } from '../tx-core'
import { loadGenerated } from '../../__tests__/helpers/generated-module'

// Runs the emitted txUtils.ts against the real @bsv/sdk and @bsv/wallet-helper.

interface Summary {
  txid: string
  inputs: Array<{ outpoint: string }>
  outputs: Array<{ vout: number; satoshis: number; scriptType: string; data?: string[] }>
}
interface Carried {
  outpoint: string
  satoshis: number
  lockingScript: string
  beef: string
}
interface Listed {
  outputs: Array<{ outpoint: string }>
  beef?: number[]
}
type Input = string | number[] | Uint8Array

const u = loadGenerated(TX_UTILS_SOURCE) as {
  parseTransaction: (input: Input) => Transaction
  summarizeTransaction: (tx: Transaction) => Summary
  findOutputByScript: (tx: Transaction, script: string, satoshis?: number) => number
  formatOutpoint: (txid: string, vout: number) => string
  parseOutpoint: (outpoint: string) => { txid: string; vout: number }
  encodeBeef: (beef: number[] | Uint8Array) => string
  decodeBeef: (b64: string) => number[]
  mergeBeefs: (beefs: Array<number[] | Uint8Array>) => number[] | Uint8Array
  carryOutput: (tx: Transaction, vout: number) => Carried
  listAllOutputs: (
    wallet: unknown,
    args: Record<string, unknown>,
    pageSize?: number
  ) => Promise<Listed>
  explorerTxUrl: (txid: string, network: 'main' | 'test' | 'ttn') => string | undefined
}

const PARSE_ERROR =
  'Could not parse a transaction: expected BEEF, AtomicBEEF or a raw transaction, as bytes, hex or base64'

const key = PrivateKey.fromRandom()
const p2pkh = new P2PKH().lock(key.toPublicKey().toAddress())
const opTrue = Script.fromASM('OP_TRUE') as LockingScript

function opReturn(...fields: string[]): LockingScript {
  return new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    ...fields.map(f => {
      const data = Utils.toArray(f, 'utf8')
      return { op: data.length, data }
    })
  ])
}

interface Out {
  lockingScript: LockingScript
  satoshis: number
}
const funding: Out[] = [{ lockingScript: p2pkh, satoshis: 5000 }]

// A source tx with `sourceOutputs`, and a signed spend of its output 0 paying `spendOutputs`.
async function build(
  sourceOutputs: Out[],
  spendOutputs: Out[] = sourceOutputs
): Promise<{ source: Transaction; tx: Transaction }> {
  const source = new Transaction(1, [], sourceOutputs)
  const tx = new Transaction(
    1,
    [
      {
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(key),
        sequence: 0xffffffff
      }
    ],
    spendOutputs
  )
  await tx.sign()
  return { source, tx }
}

describe('parseTransaction', () => {
  test('round-trips AtomicBEEF bytes, BEEF hex, base64 and padded raw hex', async () => {
    const { tx } = await build(funding, [{ lockingScript: p2pkh, satoshis: 100 }])
    const id = tx.id('hex')
    expect(u.parseTransaction(tx.toAtomicBEEF()).id('hex')).toBe(id)
    expect(u.parseTransaction(tx.toHexBEEF()).id('hex')).toBe(id)
    expect(u.parseTransaction(Utils.toBase64(tx.toBEEF())).id('hex')).toBe(id)
    expect(u.parseTransaction(Utils.toBase64(tx.toAtomicBEEF())).id('hex')).toBe(id)
    expect(u.parseTransaction(new Uint8Array(tx.toBEEF())).id('hex')).toBe(id)
    expect(u.parseTransaction(`\n  ${tx.toHex()}\n  `).id('hex')).toBe(id)
    expect(u.parseTransaction(tx.toBinary()).id('hex')).toBe(id)
  })

  test.each(['not a tx', '', 'zz'])('rejects %j', input => {
    expect(() => u.parseTransaction(input)).toThrow(PARSE_ERROR)
  })

  test('rejects arbitrary bytes', () => {
    expect(() => u.parseTransaction([1, 2, 3])).toThrow(PARSE_ERROR)
  })
})

describe('summarizeTransaction', () => {
  test('classifies outputs, decodes OP_RETURN pushes and lists input outpoints', async () => {
    const { source, tx } = await build(funding, [
      { lockingScript: p2pkh, satoshis: 10 },
      { lockingScript: opReturn('hello', 'wörld 🚀'), satoshis: 0 },
      { lockingScript: opTrue, satoshis: 1 }
    ])
    const summary = u.summarizeTransaction(tx)
    expect(summary.txid).toBe(tx.id('hex'))
    expect(summary.inputs).toEqual([{ outpoint: `${source.id('hex')}.0` }])
    expect(summary.outputs[0]).toEqual({ vout: 0, satoshis: 10, scriptType: 'P2PKH' })
    expect('data' in summary.outputs[0]).toBe(false)
    expect(summary.outputs[1]).toEqual({
      vout: 1,
      satoshis: 0,
      scriptType: 'OpReturn',
      data: ['hello', 'wörld 🚀']
    })
    expect(summary.outputs[2]).toEqual({ vout: 2, satoshis: 1, scriptType: 'Custom' })
  })

  test('decodes OP_RETURN data from a transaction parsed off the wire', async () => {
    const { tx } = await build(funding, [
      { lockingScript: opReturn('hello', 'wörld 🚀'), satoshis: 0 }
    ])
    const parsed = u.parseTransaction(tx.toHexBEEF())
    expect(u.summarizeTransaction(parsed).outputs[0].data).toEqual(['hello', 'wörld 🚀'])
  })

  test('a bare OP_RETURN script is OpReturn too', async () => {
    const lockingScript = new LockingScript([{ op: OP.OP_RETURN }, { op: 2, data: [0x68, 0x69] }])
    const { tx } = await build(funding, [{ lockingScript, satoshis: 0 }])
    expect(u.summarizeTransaction(tx).outputs[0]).toMatchObject({
      scriptType: 'OpReturn',
      data: ['hi']
    })
  })
})

describe('summarizeTransaction edge cases', () => {
  test('an OP_0 push shows up as an empty string in data', async () => {
    const lockingScript = new LockingScript([
      { op: OP.OP_FALSE },
      { op: OP.OP_RETURN },
      { op: OP.OP_0 },
      { op: 2, data: [0x68, 0x69] }
    ])
    const { tx } = await build(funding, [{ lockingScript, satoshis: 0 }])
    expect(u.summarizeTransaction(tx).outputs[0].data).toEqual(['', 'hi'])
  })

  test('an input without a source transaction id names the input', async () => {
    const { tx } = await build(funding)
    const txid = tx.id('hex')
    // Strip the source after the txid is known: serialisation needs it, summarising should not.
    tx.inputs[0].sourceTransaction = undefined
    tx.inputs[0].sourceTXID = undefined
    const stub = {
      id: () => txid,
      inputs: tx.inputs,
      outputs: tx.outputs
    } as unknown as Transaction
    expect(() => u.summarizeTransaction(stub)).toThrow('input 0 has no source transaction id')
  })
})

describe('findOutputByScript', () => {
  test('returns the index of the single match, case-insensitively', async () => {
    const { tx } = await build(funding, [
      { lockingScript: opTrue, satoshis: 1 },
      { lockingScript: p2pkh, satoshis: 2 }
    ])
    expect(u.findOutputByScript(tx, p2pkh.toHex())).toBe(1)
    expect(u.findOutputByScript(tx, p2pkh.toHex().toUpperCase())).toBe(1)
  })

  test('throws when nothing matches', async () => {
    const { tx } = await build(funding, [{ lockingScript: opTrue, satoshis: 1 }])
    expect(() => u.findOutputByScript(tx, p2pkh.toHex())).toThrow(
      `expected exactly one matching output in ${tx.id('hex')}, found 0`
    )
  })

  test('throws on duplicates and lets satoshis disambiguate', async () => {
    const { tx } = await build(funding, [
      { lockingScript: p2pkh, satoshis: 1 },
      { lockingScript: p2pkh, satoshis: 2 }
    ])
    expect(() => u.findOutputByScript(tx, p2pkh.toHex())).toThrow('found 2')
    expect(u.findOutputByScript(tx, p2pkh.toHex(), 2)).toBe(1)
    expect(u.findOutputByScript(tx, p2pkh.toHex(), 1)).toBe(0)
  })
})

describe('outpoints', () => {
  const txid = 'ab'.repeat(32)

  test('round trip', () => {
    expect(u.formatOutpoint(txid, 3)).toBe(`${txid}.3`)
    expect(u.parseOutpoint(`${txid}.3`)).toEqual({ txid, vout: 3 })
    expect(u.parseOutpoint(u.formatOutpoint(txid, 0xffffffff))).toEqual({ txid, vout: 0xffffffff })
  })

  test.each([
    'abc.0',
    `${txid}.-1`,
    `${txid}.4294967296`,
    txid,
    `${txid}.1.2`,
    `${txid}.1x`,
    `${txid}.`,
    `${txid}.1.5`
  ])('parseOutpoint rejects %j', input => {
    expect(() => u.parseOutpoint(input)).toThrow(`invalid outpoint: ${input}`)
  })

  test('uppercase txids are normalised to lowercase', () => {
    const upper = txid.toUpperCase()
    expect(u.formatOutpoint(upper, 2)).toBe(`${txid}.2`)
    expect(u.parseOutpoint(`${upper}.2`)).toEqual({ txid, vout: 2 })
  })

  test('formatOutpoint rejects bad parts', () => {
    expect(() => u.formatOutpoint('abc', 0)).toThrow('invalid outpoint')
    expect(() => u.formatOutpoint(txid, -1)).toThrow('invalid outpoint')
    expect(() => u.formatOutpoint(txid, 1.5)).toThrow('invalid outpoint')
    expect(() => u.formatOutpoint(txid, 4294967296)).toThrow('invalid outpoint')
  })
})

describe('beef helpers', () => {
  test('encodeBeef / decodeBeef round trip', async () => {
    const { tx } = await build(funding)
    const beef = tx.toBEEF()
    expect(u.decodeBeef(u.encodeBeef(beef))).toEqual(beef)
    expect(u.decodeBeef(u.encodeBeef(new Uint8Array(beef)))).toEqual(beef)
  })

  test('mergeBeefs returns a single input by reference and rejects an empty list', async () => {
    const { tx } = await build(funding)
    const a = tx.toBEEF()
    expect(u.mergeBeefs([a])).toBe(a)
    expect(() => u.mergeBeefs([])).toThrow()
  })

  test('mergeBeefs combines two BEEFs', async () => {
    const one = (await build(funding, [{ lockingScript: p2pkh, satoshis: 1 }])).tx
    const two = (
      await build(
        [{ lockingScript: p2pkh, satoshis: 7000 }],
        [{ lockingScript: p2pkh, satoshis: 2 }]
      )
    ).tx
    const merged = Beef.fromBinary(Array.from(u.mergeBeefs([one.toBEEF(), two.toBEEF()])))
    expect(merged.findTxid(one.id('hex'))).toBeDefined()
    expect(merged.findTxid(two.id('hex'))).toBeDefined()
  })
})

describe('carryOutput', () => {
  test('returns the output with a BEEF that parses back to the transaction', async () => {
    const { tx } = await build(funding, [{ lockingScript: p2pkh, satoshis: 321 }])
    const carried = u.carryOutput(tx, 0)
    expect(carried.outpoint).toBe(`${tx.id('hex')}.0`)
    expect(carried.satoshis).toBe(321)
    expect(carried.lockingScript).toBe(p2pkh.toHex())
    expect(u.parseTransaction(carried.beef).id('hex')).toBe(tx.id('hex'))
  })

  test('rejects a missing output', async () => {
    const { tx } = await build(funding, [{ lockingScript: p2pkh, satoshis: 1 }])
    expect(() => u.carryOutput(tx, 5)).toThrow(`output 5 does not exist in ${tx.id('hex')}`)
  })
})

describe('listAllOutputs', () => {
  const all = Array.from({ length: 5 }, (_, i) => ({
    outpoint: `${'cd'.repeat(32)}.${i}`,
    satoshis: 1,
    spendable: true
  }))

  function stub(beefs: Array<number[] | undefined> = []): {
    wallet: { listOutputs: (a: { limit: number; offset: number }) => Promise<unknown> }
    calls: unknown[]
  } {
    const calls: unknown[] = []
    const wallet = {
      listOutputs: async (args: { limit: number; offset: number }) => {
        calls.push(args)
        const outputs = all.slice(args.offset, args.offset + args.limit)
        const beef = beefs[Math.floor(args.offset / args.limit)]
        return { totalOutputs: all.length, outputs, ...(beef != null ? { BEEF: beef } : {}) }
      }
    }
    return { wallet, calls }
  }

  test('pages through every output', async () => {
    const { wallet, calls } = stub()
    const result = await u.listAllOutputs(wallet, { basket: 'b' }, 2)
    expect(result.outputs).toEqual(all)
    expect('beef' in result).toBe(false)
    expect(calls).toEqual([
      { basket: 'b', limit: 2, offset: 0 },
      { basket: 'b', limit: 2, offset: 2 },
      { basket: 'b', limit: 2, offset: 4 }
    ])
  })

  test('an empty first page ends after one call', async () => {
    const calls: unknown[] = []
    const wallet = {
      listOutputs: async (a: unknown) => {
        calls.push(a)
        return { totalOutputs: 0, outputs: [] }
      }
    }
    expect(await u.listAllOutputs(wallet, { basket: 'b' })).toEqual({ outputs: [] })
    expect(calls).toHaveLength(1)
  })

  test('stops on an empty page even if totalOutputs overstates', async () => {
    let n = 0
    const wallet = {
      listOutputs: async () => {
        n++
        return { totalOutputs: 99, outputs: n === 1 ? [all[0]] : [] }
      }
    }
    expect((await u.listAllOutputs(wallet, { basket: 'b' }, 1)).outputs).toEqual([all[0]])
    expect(n).toBe(2)
  })

  test('merges page BEEFs into one', async () => {
    const one = (await build(funding, [{ lockingScript: p2pkh, satoshis: 1 }])).tx
    const two = (
      await build(
        [{ lockingScript: p2pkh, satoshis: 7000 }],
        [{ lockingScript: p2pkh, satoshis: 2 }]
      )
    ).tx
    const { wallet } = stub([one.toBEEF(), undefined, two.toBEEF()])
    const result = await u.listAllOutputs(wallet, { basket: 'b' }, 2)
    const merged = Beef.fromBinary(result.beef as number[])
    expect(merged.findTxid(one.id('hex'))).toBeDefined()
    expect(merged.findTxid(two.id('hex'))).toBeDefined()
  })

  test.each([0, 10001, 1.5, -1])('rejects pageSize %p', async size => {
    const { wallet } = stub()
    await expect(u.listAllOutputs(wallet, { basket: 'b' }, size)).rejects.toThrow(
      'pageSize must be 1..10000'
    )
  })
})

describe('explorerTxUrl', () => {
  const txid = 'ab'.repeat(32)
  test('main and test link to whatsonchain', () => {
    expect(u.explorerTxUrl(txid, 'main')).toBe(`https://whatsonchain.com/tx/${txid}`)
    expect(u.explorerTxUrl(txid, 'test')).toBe(`https://test.whatsonchain.com/tx/${txid}`)
  })
  test('an uppercase txid links to the lowercase one', () => {
    expect(u.explorerTxUrl(txid.toUpperCase(), 'main')).toBe(`https://whatsonchain.com/tx/${txid}`)
  })
  test('ttn has no explorer', () => {
    expect(u.explorerTxUrl(txid, 'ttn')).toBeUndefined()
  })
  test.each(['', 'abc', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), txid + '/../x'])(
    'rejects a bad txid %j',
    bad => {
      expect(u.explorerTxUrl(bad, 'main')).toBeUndefined()
    }
  )
})
