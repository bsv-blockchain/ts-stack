import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { expect, it } from '@jest/globals'
import { Beef, Hash, MerklePath, Utils } from '@bsv/sdk'
import { RevenueListingLineageVerifier } from '../src/revenue-listing/RevenueListingLineageVerifier.js'
import {
  assembleLineage,
  lineageLimits,
  parseRevenueListingLineagePackage
} from '../src/revenue-listing/LineagePackage.js'
import { executeListingInput, inspectLineage } from '../src/revenue-listing/LineageGraph.js'
import {
  boundary,
  chains,
  compact,
  context,
  family,
  lineage,
  minedChain
} from './revenue-lineage-fixture.js'

it('verifies the frozen full DAG through both merge parents, Bitcoin evidence and every covenant', async () => {
  inspectLineage(
    assembleLineage(parseRevenueListingLineagePackage(lineage), lineageLimits({})),
    family
  )
  const result = await new RevenueListingLineageVerifier(family, chains).verify(lineage, context())
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error(result.status)
  expect(result.transactions).toEqual(lineage.transactions.map(entry => entry.txid))
  expect(result.target).toEqual(lineage.target)
  expect(result.listingId).toBe(lineage.genesis.body.listingId)
  expect(result.genesis).toEqual(lineage.genesis)
  const tx = Beef.fromBinaryStrict(
    Utils.toArray(
      lineage.transactions.find(entry => entry.txid === lineage.target.txid)!.beef,
      'base64'
    )
  ).findTransactionForSigning(lineage.target.txid)!
  expect(result.rawTransaction).toBe(Utils.toBase64(tx.toBinary()))
  expect(result.satoshis).toBe(tx.outputs[0].satoshis!.toString())
  result.descriptor.initialRevenue.recipients[0].weight = 999
  expect(lineage.descriptor.initialRevenue.recipients[0].weight).toBe(7)
}, 60000)

it('reports a missing declared predecessor path as unresolved even if other BEEF includes its raw bytes', async () => {
  const input = structuredClone(lineage)
  input.transactions = input.transactions.filter(
    entry => entry.txid !== input.genesis.body.genesis.txid
  )
  expect(await new RevenueListingLineageVerifier(family, chains).verify(input, context())).toEqual({
    status: 'unresolved',
    dependencies: [lineage.genesis.body.genesis]
  })
})

it('accepts the funded-copy merge in Script but rejects its claim of shared genesis', async () => {
  const input = structuredClone(lineage)
  input.target.txid = boundary.merge.txid
  input.transactions.push(boundary.copy, boundary.merge)
  input.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
  const assembly = assembleLineage(
    parseRevenueListingLineagePackage(compact(input)),
    lineageLimits({})
  )
  const transaction = assembly.transactions.get(boundary.merge.txid)!
  for (const index of [0, 1])
    expect(() =>
      executeListingInput(assembly, { transaction, inputs: [0, 1] }, index, 134217728)
    ).not.toThrow()
  expect(() => inspectLineage(assembly, family)).toThrow()
  expect(
    await new RevenueListingLineageVerifier(family, chains).verify(compact(input), context())
  ).toEqual({
    status: 'invalid',
    dependencies: []
  })
}, 30000)

it('rejects changed descriptor, genesis signature, entry order and chain before chain I/O', async () => {
  const variants = [
    structuredClone(lineage),
    structuredClone(lineage),
    structuredClone(lineage),
    structuredClone(lineage)
  ]
  variants[0].descriptor.purchasePrice = '1002'
  variants[1].genesis.signature = 'AA=='
  variants[2].transactions.reverse()
  variants[3].target.chain.network = 'other'
  for (const input of variants)
    expect(
      (
        await new RevenueListingLineageVerifier(family, {
          resolve: async () => {
            throw new Error('No chain I/O expected')
          }
        }).verify(input, context())
      ).status
    ).toBe('invalid')
})

it('preserves limits and pre-cancellation as distinct outcomes', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(
    (
      await new RevenueListingLineageVerifier(family, chains).verify(
        lineage,
        context(),
        controller.signal
      )
    ).status
  ).toBe('cancelled')
  expect(
    (
      await new RevenueListingLineageVerifier(family, chains, { listingTransactions: 7 }).verify(
        lineage,
        context()
      )
    ).status
  ).toBe('limited')
  const expired = context()
  expired.now = '1'
  expired.limits.deadline = '2'
  expect(
    (await new RevenueListingLineageVerifier(family, chains).verify(lineage, expired)).status
  ).toBe('limited')
})

it('resolves partial BEEF from all sorted entries before verifying Bitcoin evidence', async () => {
  const packet = compact(lineage)
  const ids = new Set(packet.transactions.map(entry => entry.txid))
  expect(
    packet.transactions.some(entry => {
      const part = Beef.fromBinaryStrict(Utils.toArray(entry.beef, 'base64'))
      return part
        .findTransactionForSigning(entry.txid)!
        .inputs.some(
          input => ids.has(input.sourceTXID!) && part.findTxid(input.sourceTXID!)?.tx === undefined
        )
    })
  ).toBe(true)
  const result = await new RevenueListingLineageVerifier(family, chains).verify(packet, context())
  expect(result.status).toBe('verified')
}, 60000)

it('returns missing funding evidence as unresolved without fetching a URL', async () => {
  const packet = compact(lineage)
  packet.transactions = packet.transactions.map(entry => {
    const part = Beef.fromBinaryStrict(Utils.toArray(entry.beef, 'base64'))
    part.removeExistingTxid(lineage.descriptor.lineageAnchor.txid)
    return { txid: entry.txid, beef: Utils.toBase64(part.toBinaryAtomic(entry.txid)) }
  })
  const result = await new RevenueListingLineageVerifier(family, chains).verify(packet, context())
  expect(result.status).toBe('unresolved')
  if (result.status === 'verified') throw new Error('Unexpected verification')
  expect(result.dependencies).toContainEqual(lineage.descriptor.lineageAnchor)
}, 60000)

it('executes covenant predicates independently even when Bitcoin evidence reaches a valid mining proof', async () => {
  const packet = compact(lineage)
  const oldTarget = packet.target.txid
  const targetEntry = packet.transactions.find(entry => entry.txid === oldTarget)!
  const tx = Beef.fromBinaryStrict(
    Utils.toArray(targetEntry.beef, 'base64')
  ).findTransactionForSigning(oldTarget)!
  tx.outputs[0].satoshis! += 1
  const txid = tx.id('hex')
  tx.merklePath = new MerklePath(1, [[{ offset: 0, hash: txid, txid: true }]])
  const bytes = tx.toAtomicBEEF()
  const mined = minedChain(txid)
  const evidence = { txid, outputIndex: 0, beef: Utils.toBase64(bytes) }
  expect(
    (
      await new SDKEvidenceVerifier(mined.chains).verify(
        {
          chain: packet.descriptor.chain,
          evidence,
          variantId: Utils.toHex(Hash.sha256(bytes))
        },
        mined.context,
        new AbortController().signal
      )
    ).status
  ).toBe('verified')
  packet.transactions = packet.transactions.filter(entry => entry.txid !== oldTarget)
  packet.transactions.push({ txid, beef: evidence.beef })
  packet.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
  packet.target.txid = txid
  expect(
    (await new RevenueListingLineageVerifier(family, mined.chains).verify(packet, mined.context))
      .status
  ).toBe('invalid')
}, 60000)

it('rejects unrelated listing entries while preserving missing-target recovery', async () => {
  const extra = compact(lineage)
  extra.transactions.push(boundary.copy)
  extra.transactions.sort((a, b) => a.txid.localeCompare(b.txid))
  expect(
    (await new RevenueListingLineageVerifier(family, chains).verify(compact(extra), context()))
      .status
  ).toBe('invalid')
  const absent = compact(lineage)
  absent.transactions = absent.transactions.filter(entry => entry.txid !== absent.target.txid)
  expect(await new RevenueListingLineageVerifier(family, chains).verify(absent, context())).toEqual(
    { status: 'unresolved', dependencies: [lineage.target] }
  )
})

it('rejects empty/unknown envelopes and exact BEEF target substitutions', async () => {
  const input = compact(lineage)
  const invalid: unknown[] = [
    null,
    { ...input, extra: true },
    { ...input, version: 2 },
    { ...input, transactions: [] },
    { ...input, genesis: { ...input.genesis, extra: true } }
  ]
  const wrong = structuredClone(input)
  wrong.transactions[0].beef = wrong.transactions[1].beef
  invalid.push(wrong)
  const missing = structuredClone(input)
  const part = new Beef()
  part.mergeTxidOnly(missing.transactions[0].txid)
  missing.transactions[0].beef = Utils.toBase64(part.toBinaryAtomic(missing.transactions[0].txid))
  invalid.push(missing)
  for (const packet of invalid)
    expect(
      (await new RevenueListingLineageVerifier(family, chains).verify(packet, context())).status
    ).toBe('invalid')
})

it('keeps a bounded physical chain request during cancellation and resumes after settlement', async () => {
  let enter: () => void = () => {},
    release: () => void = () => {}
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const verifier = new RevenueListingLineageVerifier(
    family,
    {
      resolve: async (view, signal) => {
        calls++
        enter()
        await gate
        return await chains.resolve(view, signal)
      }
    },
    { concurrentRequests: 1 }
  )
  const controller = new AbortController()
  const pending = verifier.verify(lineage, context(), controller.signal)
  try {
    expect(
      await Promise.race([entered.then(() => 'entered'), pending.then(result => result.status)])
    ).toBe('entered')
    expect((await verifier.verify(lineage, context())).status).toBe('limited')
    controller.abort()
    expect((await pending).status).toBe('cancelled')
    expect((await verifier.verify(lineage, context())).status).toBe('limited')
    expect(calls).toBe(1)
  } finally {
    release()
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  expect((await verifier.verify(lineage, context())).status).toBe('verified')
}, 60000)

it('distinguishes changed view, unavailable chain and local resource policy', async () => {
  const foreign = context()
  foreign.view.chain = { ...foreign.view.chain, network: 'different' }
  expect(
    (await new RevenueListingLineageVerifier(family, chains).verify(lineage, foreign)).status
  ).toBe('invalid')
  expect(
    (
      await new RevenueListingLineageVerifier(family, {
        resolve: async () => {
          throw new Error('offline')
        }
      }).verify(lineage, context())
    ).status
  ).toBe('limited')
  expect(
    (
      await new RevenueListingLineageVerifier(family, {
        resolve: async (view, signal) => ({
          ...(await chains.resolve(view, signal)),
          view: { ...view, id: 'different' }
        })
      }).verify(lineage, context())
    ).status
  ).toBe('context-changed')
  expect(
    (
      await new RevenueListingLineageVerifier(family, chains, { scriptMemoryBytes: 1 }).verify(
        lineage,
        context()
      )
    ).status
  ).toBe('limited')
  expect(
    (
      await new RevenueListingLineageVerifier(family, chains, { timeoutMs: 1 }).verify(
        lineage,
        context()
      )
    ).status
  ).toBe('limited')
  for (const limits of [
    { bytes: 2097153 },
    { timeoutMs: 0 },
    { concurrentRequests: 5 },
    { transactions: 1.5 },
    { unknown: 1 }
  ])
    expect(() => new RevenueListingLineageVerifier(family, chains, limits)).toThrow(
      'Invalid lineage limit'
    )
}, 60000)

it('expires waiting work while retaining the noncancellable physical dependency slot', async () => {
  const packet = structuredClone(lineage)
  let enter = () => {},
    release = () => {}
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const verifier = new RevenueListingLineageVerifier(
    family,
    {
      resolve: async (view, signal) => {
        calls++
        enter()
        await gate
        return await chains.resolve(view, signal)
      }
    },
    { concurrentRequests: 1 }
  )
  const expiring = context()
  expiring.limits.deadline = String(Number(expiring.now) + 2)
  const pending = verifier.verify(packet, expiring)
  try {
    expect(
      await Promise.race([entered.then(() => 'entered'), pending.then(result => result.status)])
    ).toBe('entered')
    expect((await pending).status).toBe('limited')
    expect((await verifier.verify(packet, context())).status).toBe('limited')
    expect(calls).toBe(1)
  } finally {
    release()
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  expect((await verifier.verify(packet, context())).status).toBe('verified')
}, 15000)
