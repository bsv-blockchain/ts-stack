import { jest } from '@jest/globals'
import { Hash, LockingScript, OP, P2PKH, Transaction, UnlockingScript } from '@bsv/sdk'
import { Bsv21Binary } from '@bsv/templates'
import { buildLedger, classifyAdmittedInputs, classifyOutputs, specVerdicts } from '../ledger.js'
import type { Brc162Output, TokenLedger } from '../ledger.js'

// These cases restate the pinned BRC-162 Examples and Validation rules. Layer A
// reports spec verdicts per token id and never throws for a spec-invalid output;
// what the Mandala layers do with a verdict is tested with them.

const codec = new Bsv21Binary()
const pkh = Hash.hash160([1, 2, 3])
const T = `${'ab'.repeat(32)}_0`
const U = `${'cd'.repeat(32)}_0`

const p2pkh = (): LockingScript => new P2PKH().lock(pkh)
const deploy = (amount = 0n): LockingScript => codec.lock(null, amount, pkh)
const value = (id: string, amount: bigint): LockingScript => codec.lock(id, amount, pkh)
const authority = (id: string): LockingScript => codec.lock(id, 0n, pkh)
const tokenIdOf = (tx: Transaction): string => `${tx.id('hex')}_0`

// A distinct lockTime keeps otherwise identical transactions from sharing a txid.
let nonce = 0
function makeTx(outputs: LockingScript[], spends: Array<[Transaction, number]> = []): Transaction {
  const tx = new Transaction()
  tx.lockTime = ++nonce
  for (const [sourceTransaction, sourceOutputIndex] of spends) {
    tx.addInput({ sourceTransaction, sourceOutputIndex, unlockingScript: new UnlockingScript() })
  }
  for (const lockingScript of outputs) tx.addOutput({ lockingScript, satoshis: 1 })
  return tx
}

function ledgerOf(tx: Transaction, previousCoins: number[]): Map<string, TokenLedger> {
  const { outputs } = classifyOutputs(tx)
  return buildLedger(tx.id('hex'), outputs, classifyAdmittedInputs(tx, previousCoins))
}

function only(ledger: Map<string, TokenLedger>, tokenId: string): TokenLedger {
  expect([...ledger.keys()]).toEqual([tokenId])
  return ledger.get(tokenId) as TokenLedger
}

const valid = {
  deployValid: true,
  authorityOutputsValid: true,
  valueOutputsValid: true
}

const withP2pkhTail = (...head: Array<{ op: number; data?: number[] }>): LockingScript =>
  new LockingScript([...head, ...p2pkh().chunks])
const bytes = (length: number): number[] => Array.from({ length }, () => 7)
// Token-shaped, but amount 5 must be OP_5, not a direct push.
const nonCanonicalAmount = (): LockingScript =>
  withP2pkhTail({ op: 32, data: bytes(32) }, { op: 1, data: [5] }, { op: OP.OP_2DROP })

describe('classifyOutputs', () => {
  it('classifies an authority deploy at vout 0 with the tx own id as token id', () => {
    const tx = makeTx([deploy(), p2pkh()])
    const { outputs, invalid } = classifyOutputs(tx)
    expect(invalid).toEqual([])
    expect(outputs).toEqual([
      {
        index: 0,
        satoshis: 1,
        role: 'deploy',
        tokenId: tokenIdOf(tx),
        amount: 0n,
        payload: undefined,
        payloadCanonical: true,
        restPubKeyHash: pkh
      }
    ])
  })

  it('names a deploy at a non-zero vout by that output so the ledger can refuse it', () => {
    const tx = makeTx([p2pkh(), deploy()])
    const { outputs } = classifyOutputs(tx)
    expect(outputs.map(o => [o.index, o.role, o.tokenId])).toEqual([
      [1, 'deploy', `${tx.id('hex')}_1`]
    ])
  })

  it('reads the wire id of authority and value outputs as the display-order string', () => {
    const { outputs } = classifyOutputs(makeTx([authority(T), value(T, 70n)]))
    expect(outputs.map(o => [o.role, o.tokenId, o.amount])).toEqual([
      ['authority', T, 0n],
      ['value', T, 70n]
    ])
  })

  it('carries a payload through, and reports a non-minimal payload push without refusing it', () => {
    const canonical = codec.lock(null, 0n, pkh, [0xa0, 0x01])
    const loose = withP2pkhTail(
      { op: OP.OP_0 },
      { op: OP.OP_0 },
      { op: OP.OP_2DROP },
      { op: OP.OP_PUSHDATA1, data: [0xa0, 0x01] },
      { op: OP.OP_DROP }
    )
    const { outputs, invalid } = classifyOutputs(makeTx([canonical, loose]))
    expect(invalid).toEqual([])
    expect(outputs.map(o => [o.payload, o.payloadCanonical])).toEqual([
      [[0xa0, 0x01], true],
      [[0xa0, 0x01], false]
    ])
  })

  it('leaves restPubKeyHash unset when the remainder is not a P2PKH', () => {
    const script = new LockingScript([
      { op: OP.OP_0 },
      { op: OP.OP_0 },
      { op: OP.OP_2DROP },
      { op: OP.OP_TRUE }
    ])
    const { outputs } = classifyOutputs(makeTx([script]))
    expect(outputs).toHaveLength(1)
    expect(outputs[0].restPubKeyHash).toBeUndefined()
  })

  it('ignores outputs that are not token-shaped', () => {
    const opReturn = new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }])
    const { outputs, invalid } = classifyOutputs(makeTx([p2pkh(), opReturn]))
    expect(outputs).toEqual([])
    expect(invalid).toEqual([])
  })

  it('records a token-shaped output the codec refuses, with the codec message, and keeps classifying', () => {
    const longId = { op: 36, data: bytes(36) }
    const tx = makeTx([
      nonCanonicalAmount(),
      value(T, 9n),
      withP2pkhTail(longId, { op: OP.OP_1 }, { op: OP.OP_2DROP })
    ])
    const { outputs, invalid } = classifyOutputs(tx)
    expect(invalid).toEqual([
      { index: 0, detail: 'amounts 0..16 must use OP_0/OP_1..OP_16' },
      { index: 2, detail: 'token id must be a direct 32-byte push' }
    ])
    expect(outputs.map(o => o.index)).toEqual([1])
  })

  it('reports 0 satoshis for an output with no amount set', () => {
    const tx = makeTx([])
    tx.outputs.push({ lockingScript: deploy() })
    expect(classifyOutputs(tx).outputs[0].satoshis).toBe(0)
  })

  it('does not swallow an error that is not a codec refusal', () => {
    const decode = jest.spyOn(Bsv21Binary, 'decode').mockImplementation(() => {
      throw new TypeError('not a codec error')
    })
    try {
      expect(() => classifyOutputs(makeTx([deploy()]))).toThrow('not a codec error')
    } finally {
      decode.mockRestore()
    }
  })
})

describe('classifyAdmittedInputs', () => {
  it('reads a value input from the source output, keyed by outpoint', () => {
    const source = makeTx([p2pkh(), value(T, 1000n)])
    const tx = makeTx([], [[source, 1]])
    expect(classifyAdmittedInputs(tx, [0])).toEqual([
      { index: 0, role: 'value', tokenId: T, amount: 1000n, outpoint: `${source.id('hex')}.1` }
    ])
  })

  it('treats an authority deploy source as an authority input of <sourceTxid>_0', () => {
    const source = makeTx([deploy()])
    const tx = makeTx([], [[source, 0]])
    expect(classifyAdmittedInputs(tx, [0])).toEqual([
      {
        index: 0,
        role: 'authority',
        tokenId: tokenIdOf(source),
        amount: 0n,
        outpoint: `${source.id('hex')}.0`
      }
    ])
  })

  it('treats a fixed-supply deploy source as a value input, never an authority', () => {
    const source = makeTx([deploy(10_000n)])
    const tx = makeTx([], [[source, 0]])
    expect(classifyAdmittedInputs(tx, [0])).toEqual([
      {
        index: 0,
        role: 'value',
        tokenId: tokenIdOf(source),
        amount: 10_000n,
        outpoint: `${source.id('hex')}.0`
      }
    ])
  })

  it('does not credit a deploy-shaped source output at a non-zero vout to the real deploy', () => {
    const source = makeTx([deploy(), deploy(5000n)])
    const tx = makeTx([], [[source, 1]])
    expect(classifyAdmittedInputs(tx, [0])).toEqual([])
  })

  it('returns only the listed inputs, ascending and without duplicates', () => {
    const source = makeTx([value(T, 1n), value(T, 2n), value(T, 3n)])
    const tx = makeTx(
      [],
      [
        [source, 0],
        [source, 1],
        [source, 2]
      ]
    )
    expect(classifyAdmittedInputs(tx, [2, 0, 2]).map(i => [i.index, i.amount])).toEqual([
      [0, 1n],
      [2, 3n]
    ])
    expect(classifyAdmittedInputs(tx, [])).toEqual([])
  })

  it('skips inputs it cannot read as a token output', () => {
    const plain = makeTx([p2pkh()])
    const refused = makeTx([nonCanonicalAmount()])
    const real = makeTx([value(T, 4n)])
    const tx = makeTx(
      [],
      [
        [plain, 0],
        [refused, 0],
        [real, 0],
        [real, 7]
      ]
    )
    tx.inputs.push({ sourceTXID: 'ff'.repeat(32), sourceOutputIndex: 0 })
    expect(classifyAdmittedInputs(tx, [0, 1, 2, 3, 4, 99]).map(i => i.index)).toEqual([2])
  })
})

describe('BRC-162 examples', () => {
  it('authority deploy at vout 0: token id is <txid>_0 and the deploy is valid', () => {
    const tx = makeTx([deploy(), p2pkh()])
    const id = tokenIdOf(tx)
    const ledger = only(ledgerOf(tx, []), id)
    expect(ledger).toEqual({
      tokenId: id,
      deployIndex: 0,
      authorityIn: [],
      authorityOut: [0],
      valueIn: 0n,
      valueOut: 0n,
      valueInIndices: [],
      valueOutIndices: []
    })
    expect(specVerdicts(ledger)).toEqual(valid)
  })

  it('deploy at vout 1 is not a valid deploy', () => {
    const tx = makeTx([p2pkh(), deploy()])
    const id = `${tx.id('hex')}_1`
    const ledger = only(ledgerOf(tx, []), id)
    expect(ledger.deployIndex).toBe(1)
    expect(specVerdicts(ledger)).toEqual({
      deployValid: false,
      authorityOutputsValid: false,
      valueOutputsValid: true
    })
  })

  it('mint: spending the authority, value 1,000,000 plus a continuing authority', () => {
    const deployTx = makeTx([deploy()])
    const id = tokenIdOf(deployTx)
    const tx = makeTx([value(id, 1_000_000n), authority(id)], [[deployTx, 0]])
    const ledger = only(ledgerOf(tx, [0]), id)
    expect(ledger).toEqual({
      tokenId: id,
      authorityIn: [0],
      authorityOut: [1],
      valueIn: 0n,
      valueOut: 1_000_000n,
      valueInIndices: [],
      valueOutIndices: [0]
    })
    expect(specVerdicts(ledger)).toEqual(valid)
  })

  it('valid transfer: 1000 + 500 in, 800 + 600 + 100 out', () => {
    const source = makeTx([value(T, 1000n), value(T, 500n)])
    const tx = makeTx(
      [value(T, 800n), value(T, 600n), value(T, 100n)],
      [
        [source, 0],
        [source, 1]
      ]
    )
    const ledger = only(ledgerOf(tx, [0, 1]), T)
    expect(ledger).toMatchObject({
      valueIn: 1500n,
      valueOut: 1500n,
      valueInIndices: [0, 1],
      valueOutIndices: [0, 1, 2]
    })
    expect(specVerdicts(ledger)).toEqual(valid)
  })

  it('invalid transfer: 500 in, 300 + 400 out', () => {
    const source = makeTx([value(T, 500n)])
    const tx = makeTx([value(T, 300n), value(T, 400n)], [[source, 0]])
    const ledger = only(ledgerOf(tx, [0]), T)
    expect(specVerdicts(ledger)).toEqual({ ...valid, valueOutputsValid: false })
  })

  it('implicit burn: 1000 in, 250 out is valid under the spec', () => {
    const source = makeTx([value(T, 1000n)])
    const tx = makeTx([value(T, 250n)], [[source, 0]])
    const ledger = only(ledgerOf(tx, [0]), T)
    expect(ledger).toMatchObject({ valueIn: 1000n, valueOut: 250n })
    expect(specVerdicts(ledger)).toEqual(valid)
  })

  it('an authority output with no authority input is invalid', () => {
    const noInputs = only(ledgerOf(makeTx([authority(T)]), []), T)
    expect(specVerdicts(noInputs)).toEqual({ ...valid, authorityOutputsValid: false })

    const source = makeTx([value(T, 5n)])
    const valueOnly = only(ledgerOf(makeTx([authority(T)], [[source, 0]]), [0]), T)
    expect(specVerdicts(valueOnly)).toEqual({ ...valid, authorityOutputsValid: false })
  })

  it('authority split and combine are valid', () => {
    const one = makeTx([authority(T)])
    const split = only(ledgerOf(makeTx([authority(T), authority(T)], [[one, 0]]), [0]), T)
    expect(split).toMatchObject({ authorityIn: [0], authorityOut: [0, 1] })
    expect(specVerdicts(split)).toEqual(valid)

    const two = makeTx([authority(T), authority(T)])
    const combine = only(
      ledgerOf(
        makeTx(
          [authority(T)],
          [
            [two, 0],
            [two, 1]
          ]
        ),
        [0, 1]
      ),
      T
    )
    expect(combine).toMatchObject({ authorityIn: [0, 1], authorityOut: [0] })
    expect(specVerdicts(combine)).toEqual(valid)
  })

  it('ending an authority still yields a ledger entry, with an authority in and none out', () => {
    const source = makeTx([authority(T)])
    const ledger = only(ledgerOf(makeTx([p2pkh()], [[source, 0]]), [0]), T)
    expect(ledger).toMatchObject({ authorityIn: [0], authorityOut: [], valueOut: 0n })
    expect(specVerdicts(ledger)).toEqual(valid)
  })

  it('a token that is only spent still yields a ledger entry', () => {
    const source = makeTx([value(T, 40n)])
    const ledger = only(ledgerOf(makeTx([p2pkh()], [[source, 0]]), [0]), T)
    expect(ledger).toMatchObject({ valueIn: 40n, valueOut: 0n, valueInIndices: [0] })
  })

  it('keeps two tokens in one transaction in separate ledgers', () => {
    const source = makeTx([value(T, 100n), value(U, 100n)])
    const tx = makeTx(
      [value(T, 100n), value(U, 101n)],
      [
        [source, 0],
        [source, 1]
      ]
    )
    const ledger = ledgerOf(tx, [0, 1])
    expect([...ledger.keys()]).toEqual([T, U])
    expect(ledger.get(T)).toMatchObject({ valueIn: 100n, valueOut: 100n, valueInIndices: [0] })
    expect(ledger.get(U)).toMatchObject({ valueIn: 100n, valueOut: 101n, valueInIndices: [1] })
    expect(specVerdicts(ledger.get(T) as TokenLedger)).toEqual(valid)
    expect(specVerdicts(ledger.get(U) as TokenLedger)).toEqual({
      ...valid,
      valueOutputsValid: false
    })
  })

  it('an input outside previousCoins contributes nothing', () => {
    const source = makeTx([value(T, 1000n), authority(U)])
    const tx = makeTx(
      [value(T, 800n), authority(U)],
      [
        [source, 0],
        [source, 1]
      ]
    )
    const ledger = ledgerOf(tx, [])
    expect(ledger.get(T)).toMatchObject({ valueIn: 0n, valueInIndices: [] })
    expect(specVerdicts(ledger.get(T) as TokenLedger).valueOutputsValid).toBe(false)
    expect(specVerdicts(ledger.get(U) as TokenLedger).authorityOutputsValid).toBe(false)

    const listed = ledgerOf(tx, [0, 1])
    expect(specVerdicts(listed.get(T) as TokenLedger).valueOutputsValid).toBe(true)
    expect(specVerdicts(listed.get(U) as TokenLedger).authorityOutputsValid).toBe(true)
  })
})

describe('BRC-162 fixed supply', () => {
  it('lifecycle: deploy 10,000, split into two 5,000, then pay 4,900 plus 100 change', () => {
    const deployTx = makeTx([deploy(10_000n)])
    const id = tokenIdOf(deployTx)
    const genesis = only(ledgerOf(deployTx, []), id)
    expect(genesis).toMatchObject({ deployIndex: 0, authorityOut: [], valueOut: 10_000n })
    expect(specVerdicts(genesis)).toEqual(valid)

    const splitTx = makeTx([value(id, 5000n), value(id, 5000n)], [[deployTx, 0]])
    const split = only(ledgerOf(splitTx, [0]), id)
    expect(split).toMatchObject({ authorityIn: [], valueIn: 10_000n, valueOut: 10_000n })
    expect(specVerdicts(split)).toEqual(valid)

    const payTx = makeTx([value(id, 4900n), value(id, 100n)], [[splitTx, 0]])
    const pay = only(ledgerOf(payTx, [0]), id)
    expect(specVerdicts(pay)).toEqual(valid)
  })

  it('spending a fixed-supply deploy gives no authority to mint more', () => {
    const deployTx = makeTx([deploy(10_000n)])
    const id = tokenIdOf(deployTx)
    const tx = makeTx([value(id, 10_001n)], [[deployTx, 0]])
    const ledger = only(ledgerOf(tx, [0]), id)
    expect(specVerdicts(ledger)).toEqual({ ...valid, valueOutputsValid: false })
  })

  it('a fixed-supply deploy at vout 1 is not a valid genesis', () => {
    const tx = makeTx([p2pkh(), deploy(10_000n)])
    const ledger = only(ledgerOf(tx, []), `${tx.id('hex')}_1`)
    expect(specVerdicts(ledger)).toEqual({
      deployValid: false,
      authorityOutputsValid: true,
      valueOutputsValid: false
    })
  })

  it('a deploy-shaped output at vout 1 gives no coverage for value of <txid>_0', () => {
    const real = makeTx([deploy(), deploy(5000n)])
    const id = tokenIdOf(real)
    const tx = makeTx([value(id, 5000n)], [[real, 1]])
    const ledger = only(ledgerOf(tx, [0]), id)
    expect(ledger).toMatchObject({ valueIn: 0n, authorityIn: [] })
    expect(specVerdicts(ledger).valueOutputsValid).toBe(false)
  })
})

describe('buildLedger', () => {
  it('keys a deploy output by its own txid and index, whatever token id the caller carried', () => {
    const txid = 'ee'.repeat(32)
    const output: Brc162Output = {
      index: 0,
      satoshis: 1,
      role: 'deploy',
      tokenId: 'stale',
      amount: 0n,
      payloadCanonical: true
    }
    const ledger = buildLedger(txid, [output], [])
    expect([...ledger.keys()]).toEqual([`${txid}_0`])
    expect(ledger.get(`${txid}_0`)?.tokenId).toBe(`${txid}_0`)
  })

  it('returns an empty map when nothing is token-shaped', () => {
    expect(buildLedger('ee'.repeat(32), [], []).size).toBe(0)
  })
})
