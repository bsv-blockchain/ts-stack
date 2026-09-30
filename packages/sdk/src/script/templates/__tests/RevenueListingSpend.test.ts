import { createHash } from 'node:crypto'
import { RevenueListingSpend, type PreparedRevenueListingSpend } from '../RevenueListingSpend.js'
import { type RevenueListing } from '../RevenueListing.js'
import {
  accepted,
  corpus,
  transaction,
  previous,
  action,
  makeFamily
} from './RevenueListing.fixture.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import Curve from '../../../primitives/Curve.js'
import Transaction from '../../../transaction/Transaction.js'
import TransactionSignature from '../../../primitives/TransactionSignature.js'
import Spend from '../../Spend.js'
import UnlockingScript from '../../UnlockingScript.js'
import LockingScript from '../../LockingScript.js'
import { toHex } from '../../../primitives/utils.js'

let family: RevenueListing
beforeAll(() => {
  family = makeFamily()
})
const keys = Array.from({ length: 20 }, (_, index) => new PrivateKey(index + 41))
function fixture(name: string) {
  const trace = accepted.find(item => item.name === name)!
  const tx = transaction(trace.txid)
  trace.sources.forEach((source, index) => {
    tx.inputs[index].sourceTransaction = transaction(source.txid)
  })
  const spend = new RevenueListingSpend(
    family,
    corpus.descriptor,
    previous(trace),
    action(trace, family)
  )
  return { trace, tx, spend }
}
function signatures(prepared: PreparedRevenueListingSpend, count: number) {
  const result: { seller?: string; recipients: string[] }[] = Array.from({ length: count }, () => ({
    recipients: []
  }))
  for (const request of prepared.signingRequests()) {
    const key = keys.find(item => item.toPublicKey().toString() === request.identity)!
    const raw = key.sign(request.data)
    const signature = toHex(new TransactionSignature(raw.r, raw.s, 65).toChecksigFormat())
    if (request.role === 'seller') result[request.inputIndex].seller = signature
    else result[request.inputIndex].recipients.push(signature)
  }
  return result
}
function validate(tx: Transaction, index: number) {
  const input = tx.inputs[index]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  return new Spend({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    lockingScript: source.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== index),
    outputs: tx.outputs,
    inputIndex: index,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence!,
    lockTime: tx.lockTime,
    memoryLimit: 128 * 1024 * 1024
  }).validate()
}

test.each(accepted)(
  'constructs and executes every input of frozen $name',
  trace => {
    const { tx, spend } = fixture(trace.name)
    const prepared = spend.prepare(tx)
    for (const request of prepared.signingRequests()) {
      expect(request.scope).toBe(65)
      expect(request.preimage).toEqual(
        tx.inputs[request.inputIndex].unlockingScript!.chunks[0].data
      )
      expect(request.data).toEqual(
        Array.from(createHash('sha256').update(Uint8Array.from(request.preimage)).digest())
      )
    }
    const completed = prepared.complete(signatures(prepared, spend.plan().inputs.length))
    expect(completed.toHex()).toBe(tx.toHex())
    expect(() => prepared.assertFinalLayout(completed)).not.toThrow()
    completed.inputs.forEach((_, index) => {
      expect(validate(completed, index)).toBe(true)
    })
    spend.plan().inputs.forEach((_, index) => {
      expect(completed.inputs[index].unlockingScript!.chunks).toHaveLength(14)
      expect(completed.inputs[index].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
        spend.estimateUnlockingLength(index)
      )
    })
  },
  30000
)

test('owns the funded snapshot and returned requests without signing mutable caller state', () => {
  const { tx, spend } = fixture('amend-all-consent')
  const original = tx.toHex()
  const prepared = spend.prepare(tx)
  const requests = prepared.signingRequests()
  requests[0].data.fill(0)
  requests[0].preimage.fill(0)
  requests[0].identity = keys[3].toPublicKey().toString()
  tx.outputs[0].satoshis = 1
  tx.inputs[1].sourceTransaction!.outputs[0].satoshis = 1
  const completed = prepared.complete(signatures(prepared, 1))
  expect(completed.toHex()).toBe(original)
  completed.outputs[0].satoshis = 1
  expect(prepared.complete(signatures(prepared, 1)).toHex()).toBe(original)
})

test.each([
  'seller-missing',
  'seller-wrong-input',
  'recipient-missing',
  'recipient-order',
  'recipient-extra',
  'wrong-hashtype',
  'wrong-encoding',
  'wrong-input-count'
])('rejects signature mismatch %s', kind => {
  const { tx, spend } = fixture('amend-all-consent')
  const prepared = spend.prepare(tx),
    signed = signatures(prepared, 1)
  if (kind === 'seller-missing') delete signed[0].seller
  if (kind === 'seller-wrong-input') signed[0].seller = signed[0].recipients[0]
  if (kind === 'recipient-missing') signed[0].recipients.pop()
  if (kind === 'recipient-order') signed[0].recipients.reverse()
  if (kind === 'recipient-extra') signed[0].recipients.push(signed[0].recipients[0])
  if (kind === 'wrong-hashtype') signed[0].seller = signed[0].seller!.slice(0, -2) + 'c1'
  if (kind === 'wrong-encoding') signed[0].seller = signed[0].seller!.toUpperCase()
  if (kind === 'wrong-input-count') signed.push(signed[0])
  expect(() => prepared.complete(signed)).toThrow()
})

test('merge requires an independently bound seller signature for each listing input', () => {
  const { tx, spend } = fixture('merge')
  const prepared = spend.prepare(tx),
    signed = signatures(prepared, 2)
  expect(signed[0].seller).not.toBe(signed[1].seller)
  signed[1].seller = signed[0].seller
  expect(() => prepared.complete(signed)).toThrow('authorize')
})

test.each([
  'version',
  'locktime',
  'sequence',
  'duplicate',
  'input-order',
  'no-funding',
  'missing-source',
  'wrong-source',
  'missing-index',
  'extra-output',
  'changed-output',
  'change-script',
  'zero-change',
  'negative-fee'
])('rejects funded layout change %s before requesting signatures', kind => {
  const { tx, spend } = fixture('purchase')
  if (kind === 'version') tx.version = 3
  if (kind === 'locktime') tx.lockTime = 1
  if (kind === 'sequence') tx.inputs[1].sequence = 1
  if (kind === 'duplicate') tx.inputs[1] = { ...tx.inputs[0] }
  if (kind === 'input-order') tx.inputs.reverse()
  if (kind === 'no-funding') tx.inputs.pop()
  if (kind === 'missing-source') delete tx.inputs[1].sourceTransaction
  if (kind === 'wrong-source') tx.inputs[1].sourceTransaction = tx.inputs[0].sourceTransaction
  if (kind === 'missing-index') tx.inputs[1].sourceOutputIndex = 99
  if (kind === 'extra-output') tx.outputs.push(tx.outputs[1])
  if (kind === 'changed-output') tx.outputs[0].satoshis!++
  if (kind === 'change-script') tx.outputs[2].lockingScript = tx.outputs[1].lockingScript
  if (kind === 'zero-change') tx.outputs[2].satoshis = 0
  if (kind === 'negative-fee') tx.outputs[2].satoshis = 1000000
  expect(() => spend.prepare(tx)).toThrow()
})

test.each(['version', 'change', 'funding-sequence', 'funding-input', 'output-order'])(
  'final wallet result must preserve the complete signed layout: %s',
  kind => {
    const { tx, spend } = fixture('purchase')
    const prepared = spend.prepare(tx)
    const complete = prepared.complete([{ recipients: [] }])
    if (kind === 'version') complete.version = 2
    if (kind === 'change') complete.outputs[2].satoshis!--
    if (kind === 'funding-sequence') complete.inputs[1].sequence!--
    if (kind === 'funding-input') {
      complete.inputs[1].sourceTransaction = transaction(accepted[1].sources[1].txid)
      complete.inputs[1].sourceTXID = complete.inputs[1].sourceTransaction!.id('hex')
    }
    if (kind === 'output-order') complete.outputs.reverse()
    expect(() => prepared.assertFinalLayout(complete)).toThrow()
  }
)

test('change may be absent, and final funding signatures do not alter the committed layout', () => {
  const { tx, spend } = fixture('purchase')
  tx.outputs.pop()
  const prepared = spend.prepare(tx)
  const completed = prepared.complete([{ recipients: [] }])
  expect(validate(completed, 0)).toBe(true)
  completed.inputs[1].unlockingScript = new UnlockingScript()
  expect(() => prepared.assertFinalLayout(completed)).not.toThrow()
  // Layout validation deliberately does not validate signatures on funding inputs.
})

test('family outputs cannot be silently used as external funding', () => {
  const { tx, spend } = fixture('purchase')
  const other = transaction(accepted[1].sources[0].txid)
  tx.inputs[1].sourceTransaction = other
  tx.inputs[1].sourceTXID = other.id('hex')
  tx.inputs[1].sourceOutputIndex = 0
  expect(() => spend.prepare(tx)).toThrow('Additional family')
})

test.each([-1, 1, 0.5, Number.NaN])('estimate rejects nonexistent input %s', index => {
  const { spend } = fixture('purchase')
  expect(() => spend.estimateUnlockingLength(index)).toThrow()
})

function eightRecipientSpend(operation: 'payout' | 'amend') {
  const { tx } = fixture('purchase')
  const ordered = (start: number) =>
    Array.from({ length: 8 }, (_, index) => ({
      identity: new PrivateKey(start + index).toPublicKey().toString(),
      weight: 1
    })).sort((a, b) => a.identity.localeCompare(b.identity, 'en'))
  const descriptor = {
    ...corpus.descriptor,
    initialRevenue: { revision: '0', recipients: ordered(41) }
  }
  const source = tx.inputs[0].sourceTransaction!
  source.outputs[0].satoshis = 100
  source.outputs[0].lockingScript = family.lock(descriptor)
  const sources = [{ rawTransaction: source.toHex(), outputIndex: 0 }]
  const action =
    operation === 'payout'
      ? { operation, units: '1' }
      : { operation, state: { revision: '1', recipients: ordered(50) } }
  const spend = new RevenueListingSpend(family, descriptor, sources, action)
  tx.inputs[0].sourceTXID = source.id('hex')
  const change = tx.outputs[2]
  tx.outputs = spend.plan().outputs.map(item => ({
    satoshis: Number(item.satoshis),
    lockingScript: LockingScript.fromHex(item.lockingScript)
  }))
  change.satoshis = 99000
  tx.outputs.push(change)
  // Source mutation isolates construction; no assertion of valid genesis ancestry.
  return { tx, spend }
}

test('eight old recipients all sign an amendment with eight new curve witnesses', () => {
  const { tx, spend } = eightRecipientSpend('amend')
  const prepared = spend.prepare(tx)
  expect(prepared.signingRequests()).toHaveLength(9)
  const completed = prepared.complete(signatures(prepared, 1))
  expect(completed.inputs[0].unlockingScript!.chunks[11].data).toHaveLength(584)
  expect(completed.inputs[0].unlockingScript!.chunks[9].data).toHaveLength(256)
  expect(validate(completed, 0)).toBe(true)
  expect(completed.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
    spend.estimateUnlockingLength(0)
  )
})

test('maximum eight inputs and eleven outputs retain the exact funded commitment', () => {
  const { tx, spend } = eightRecipientSpend('payout')
  const root = tx.inputs[0].sourceTransaction!.inputs[0].sourceTXID!
  const funding = transaction(root)
  tx.inputs = [
    tx.inputs[0],
    ...Array.from({ length: 7 }, (_, index) => ({
      sourceTXID: funding.id('hex'),
      sourceTransaction: funding,
      sourceOutputIndex: index + 1,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript()
    }))
  ]
  const prepared = spend.prepare(tx)
  expect(tx.inputs).toHaveLength(8)
  expect(tx.outputs).toHaveLength(11)
  const completed = prepared.complete(signatures(prepared, 1))
  expect(validate(completed, 0)).toBe(true)
  expect(() => prepared.assertFinalLayout(completed)).not.toThrow()
  expect(completed.inputs[0].unlockingScript!.toBinary().length).toBeLessThanOrEqual(
    spend.estimateUnlockingLength(0)
  )
})

function padTransaction(tx: Transaction, index: number, size: number): void {
  tx.inputs[index].unlockingScript = new UnlockingScript()
  const base = tx.toBinary().length
  tx.inputs[index].unlockingScript = UnlockingScript.fromBinary(
    Array<number>(size - base - 4).fill(0)
  )
  expect(tx.toBinary()).toHaveLength(size)
}

test('funding predecessor has an inclusive one-MiB raw limit', () => {
  const { tx, spend } = fixture('purchase')
  const parent = tx.inputs[1].sourceTransaction!
  padTransaction(parent, 0, 1048576)
  tx.inputs[1].sourceTXID = parent.id('hex')
  expect(() => spend.prepare(tx)).not.toThrow()
  padTransaction(parent, 0, 1048577)
  tx.inputs[1].sourceTXID = parent.id('hex')
  expect(() => spend.prepare(tx)).toThrow('predecessor exceeds local byte limit')
}, 30000)

test('funded raw layout has an inclusive four-MiB limit', () => {
  const { tx, spend } = fixture('purchase')
  padTransaction(tx, 1, 4194304)
  expect(() => spend.prepare(tx)).not.toThrow()
  padTransaction(tx, 1, 4194305)
  expect(() => spend.prepare(tx)).toThrow('Funded transaction exceeds local byte limit')
}, 30000)

test('completion must also respect the raw limit after adding listing unlocks', () => {
  const { tx, spend } = fixture('purchase')
  tx.inputs[0].unlockingScript = new UnlockingScript()
  padTransaction(tx, 1, 4194304)
  const prepared = spend.prepare(tx)
  expect(() => prepared.complete([{ recipients: [] }])).toThrow(
    'Completed transaction exceeds local byte limit'
  )
}, 30000)

test.each(accepted)(
  'funding estimate matches an independent maximum ABI serializer for $name',
  trace => {
    const { tx, spend } = fixture(trace.name)
    spend.plan().inputs.forEach((_, index) => {
      const fields = tx.inputs[index].unlockingScript!.chunks.map(chunk =>
        chunk.data === undefined ? [] : [...chunk.data]
      )
      fields[1] = Array<number>(8 * 36).fill(0)
      fields[2] = [trace.operation] // Conservative one-byte push rather than the shorter numeric opcode.
      fields[5] = Array<number>(8).fill(1)
      fields[6] = Array<number>(8).fill(1)
      fields[13] = Array<number>(8).fill(1)
      fields[10] = trace.operation === 1 ? [] : Array<number>(72).fill(0)
      const bound = new UnlockingScript()
      for (const field of fields) bound.writeBin(field)
      expect(spend.estimateUnlockingLength(index)).toBe(bound.toBinary().length)
    })
  }
)

test('signing requests identify the seller and every old recipient with their distinct roles', () => {
  const { tx, spend } = fixture('amend-all-consent')
  const requests = spend.prepare(tx).signingRequests()
  expect(
    requests.map(item => ({ identity: item.identity, role: item.role, index: item.inputIndex }))
  ).toEqual([
    { identity: corpus.descriptor.seller, role: 'seller', index: 0 },
    ...corpus.descriptor.initialRevenue.recipients.map(item => ({
      identity: item.identity,
      role: 'recipient',
      index: 0
    }))
  ])
})

test.each([
  null,
  1234,
  {},
  '',
  '00'.repeat(8),
  '00'.repeat(73),
  '0'.repeat(19),
  'z' + '0'.repeat(19),
  '0'.repeat(19) + 'z'
])('rejects signature framing before cryptographic verification: %#', value => {
  const { tx, spend } = fixture('split')
  expect(() => spend.prepare(tx).complete([{ seller: value, recipients: [] }])).toThrow(
    'Expected canonical transaction signature'
  )
})

test('minimum length DER is parsed but cannot authorize the seller without a valid signature', () => {
  const { tx, spend } = fixture('split')
  expect(() =>
    spend.prepare(tx).complete([{ seller: '300602010102010141', recipients: [] }])
  ).toThrow('Transaction signature does not authorize this input')
})

test('unrequested seller signatures and incomplete merge signature groups are rejected explicitly', () => {
  const { tx, spend } = fixture('purchase')
  expect(() =>
    spend.prepare(tx).complete([{ seller: '300602010102010141', recipients: [] }])
  ).toThrow('Exact seller and recipient signatures required')
  expect(() => spend.prepare(tx).complete([{ recipients: [] }, { recipients: [] }])).toThrow(
    'Wrong signature input count'
  )
  const merge = fixture('merge'),
    prepared = merge.spend.prepare(merge.tx)
  const signed = signatures(prepared, 2)
  expect(() => prepared.complete(signed.slice(0, 1))).toThrow('Wrong signature input count')
})

test('low-S is checked separately from valid ECDSA authority', () => {
  const { tx, spend } = fixture('amend-all-consent')
  const prepared = spend.prepare(tx),
    signed = signatures(prepared, 1)
  const order = new Curve().n
  const candidates = [signed[0].seller!, ...signed[0].recipients]
  const high = candidates.map(value => {
    const sig = TransactionSignature.fromChecksigFormat(Array.from(Buffer.from(value, 'hex')))
    return toHex(new TransactionSignature(sig.r, order.sub(sig.s), 65).toChecksigFormat())
  })
  const index = high.findIndex(value => value.length <= 144)
  expect(index).toBeGreaterThanOrEqual(0)
  if (index === 0) signed[0].seller = high[index]
  else signed[0].recipients[index - 1] = high[index]
  expect(() => prepared.complete(signed)).toThrow('strict DER, low-S and ALL|FORKID')
})

test('listing source evidence is retained by the plan while funding evidence must match the supplied prevout', () => {
  const { tx, spend } = fixture('purchase')
  delete tx.inputs[0].sourceTransaction
  expect(() => spend.prepare(tx)).not.toThrow()
  delete tx.inputs[1].sourceTransaction
  expect(() => spend.prepare(tx)).toThrow('Funding predecessor evidence required')
  tx.inputs[1].sourceTransaction = transaction(accepted[1].sources[1].txid)
  expect(() => spend.prepare(tx)).toThrow('Funding predecessor identity mismatch')
  tx.inputs[1].sourceTXID = tx.inputs[1].sourceTransaction!.id('hex')
  tx.inputs[1].sourceOutputIndex = 99
  expect(() => spend.prepare(tx)).toThrow('Funding predecessor output missing')
})

test('merge still needs an external funding input and preserves distinct same-parent input order', () => {
  const { tx } = fixture('merge')
  const source = transaction(accepted.find(item => item.name === 'split')!.txid)
  const previous = [0, 1].map(outputIndex => ({ rawTransaction: source.toHex(), outputIndex }))
  const spend = new RevenueListingSpend(family, corpus.descriptor, previous, { operation: 'merge' })
  tx.inputs[0] = {
    ...tx.inputs[0],
    sourceTXID: source.id('hex'),
    sourceTransaction: source,
    sourceOutputIndex: 0
  }
  tx.inputs[1] = {
    ...tx.inputs[1],
    sourceTXID: source.id('hex'),
    sourceTransaction: source,
    sourceOutputIndex: 1
  }
  tx.outputs[0].satoshis = 1002
  expect(() => spend.prepare(tx)).not.toThrow()
  tx.inputs[0].sourceOutputIndex = 1
  tx.inputs[1].sourceOutputIndex = 0
  expect(() => spend.prepare(tx)).toThrow('Listing input order changed')
  tx.inputs[0].sourceOutputIndex = 0
  tx.inputs[1].sourceOutputIndex = 1
  tx.inputs.pop()
  expect(() => spend.prepare(tx)).toThrow('External funding input required')
})

test.each(['no-outputs', 'nine-inputs', 'twelve-outputs'])(
  'invalid funded dimensions fail at the layout boundary: %s',
  kind => {
    const { tx, spend } = fixture('purchase')
    if (kind === 'no-outputs') tx.outputs = []
    if (kind === 'nine-inputs') tx.inputs = Array.from({ length: 9 }, () => ({ ...tx.inputs[0] }))
    if (kind === 'twelve-outputs')
      tx.outputs = Array.from({ length: 12 }, () => ({ ...tx.outputs[0] }))
    expect(() => spend.prepare(tx)).toThrow('Funded transaction layout exceeds profile')
  }
)

test('mandatory scripts and exact output counts cannot be replaced by other bounded outputs', () => {
  const { tx, spend } = fixture('purchase')
  tx.outputs[0].lockingScript = tx.outputs[2].lockingScript
  expect(() => spend.prepare(tx)).toThrow('Required listing output changed')
  tx.outputs = tx.outputs.slice(0, 1)
  expect(() => spend.prepare(tx)).toThrow('Funded output count changed')
})

test.each(['prefix', 'suffix'])('change must be exactly P2PKH without a %s', side => {
  const { tx, spend } = fixture('purchase')
  const raw = tx.outputs[2].lockingScript.toHex()
  tx.outputs[2].lockingScript = LockingScript.fromHex(side === 'prefix' ? '00' + raw : raw + '00')
  expect(() => spend.prepare(tx)).toThrow('Only one final P2PKH change output is allowed')
})

test('external funding is not mistaken for the family based only on script size', () => {
  const { tx, spend } = fixture('purchase')
  const source = tx.inputs[1].sourceTransaction!
  source.outputs[0].lockingScript = LockingScript.fromHex('51'.repeat(40008))
  tx.inputs[1].sourceTXID = source.id('hex')
  expect(() => spend.prepare(tx)).not.toThrow()
})

test('zero fee and total supply boundary are inclusive; excess totals are rejected', () => {
  const { tx, spend } = fixture('purchase')
  tx.outputs[2].satoshis = 98998
  expect(() => spend.prepare(tx)).not.toThrow()
  const parent = tx.inputs[1].sourceTransaction!
  parent.outputs[0].satoshis = 2099999999999999
  tx.inputs[1].sourceTXID = parent.id('hex')
  expect(() => spend.prepare(tx)).not.toThrow()
  parent.outputs[0].satoshis = 2100000000000000
  tx.inputs[1].sourceTXID = parent.id('hex')
  expect(() => spend.prepare(tx)).toThrow('Funded transaction does not conserve value')
  parent.outputs[0].satoshis = 2100000000000001
  tx.inputs[1].sourceTXID = parent.id('hex')
  expect(() => spend.prepare(tx)).toThrow('Invalid funded amount')
})
