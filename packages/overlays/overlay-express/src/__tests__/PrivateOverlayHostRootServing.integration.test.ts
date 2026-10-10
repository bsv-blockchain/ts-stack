import { expect, it } from '@jest/globals'
import { Utils, OutputProtocolError, canonicalOutputJSON } from '@bsv/sdk'
import { nativeRootServingFixture } from './PrivateOverlayHostRootServing.fixture.js'
import { RootAdvertisementServing } from '../../../../application/output-knowledge/src/root-eviction/RootAdvertisementServing.js'

async function qualifyRoot(f: Awaited<ReturnType<typeof nativeRootServingFixture>>) {
  await f.a.admit()
  await f.b.admit()
  const initial = await f.client.open(f.a.feed.open),
    cache = await f.a.finite(),
    txid = f.ad.transaction.id('hex')
  expect(
    initial.groups.flatMap(group => group.observations).filter(item => item.kind === 'output')
  ).toHaveLength(2)
  expect((await f.finiteHTTP()).status).toBe(200)
  expect(cache.answer.outputs).toHaveLength(2)
  // Real SDK-authenticated owner withdrawal is independently accepted at only A.
  const first = await f.a.request('suppress'),
    second = await f.a.request('suppress'),
    firstBasis = first.outcomes[0].decisionId!,
    secondBasis = second.outcomes[0].decisionId!
  expect(firstBasis).not.toBe(secondBasis)
  let sends = 0
  expect(() =>
    f.a.serving.bind(cache.bytes, cache.inventory, cache.head).enqueue(
      cache.bytes,
      () => true,
      () => {
        sends++
        return undefined
      }
    )
  ).toThrow(expect.objectContaining({ code: 'reset-required' }))
  expect(sends).toBe(0)
  expect((await f.a.finite()).answer.outputs).toHaveLength(1)
  expect((await f.b.finite()).answer.outputs).toHaveLength(2)
  const history = await f.a.gasp.hydrateGASPNode(txid + '.0', txid, 0, true)
  expect(history.rawTx).toBe(Utils.toHex(f.ad.transaction.toBinary()))
  expect(history).not.toHaveProperty('context')
  // Original retained snapshots cannot bypass current suppression, even before projection.
  await expect(f.client.open(f.a.feed.open)).rejects.toBeInstanceOf(OutputProtocolError)
  expect(f.responses.at(-1)!.status).toBe(409)
  expect(f.responses.at(-1)!.body).not.toContain(txid)
  expect(f.responses.at(-1)!.body).not.toContain(initial.session)
  await f.a.project()
  const live = await f.client.read(initial, initial.limits),
    replay = await f.client.read(initial, initial.limits)
  expect(
    live.groups.flatMap(group => group.observations).some(item => item.kind === 'withdraw')
  ).toBe(true)
  expect(replay.groups).toEqual(live.groups)
  const oneLift = await f.a.request('restore', firstBasis)
  expect(oneLift.outcomes[0].serving.blockers).toHaveLength(1)
  const oldIntent = (await f.a.store.projections(64))[0]!
  expect(oldIntent).toBeDefined()
  await f.a.project()
  expect((await f.a.finite()).answer.outputs).toHaveLength(1)
  const allLift = await f.a.request('restore', secondBasis)
  expect(allLift.outcomes[0].serving.state).toBe('unresolved')
  expect((await f.a.finite()).answer.outputs).toHaveLength(1)
  await f.a.project()
  expect((await f.a.finite()).answer.outputs).toHaveLength(2)
  expect(await f.a.store.projected(oldIntent)).toBe(false)
  // A real owner change after BRC-104 signing resets the whole fresh batch.
  let duringSigning: Awaited<ReturnType<typeof f.a.request>> | undefined
  f.onSign(async () => {
    f.onSign()
    duringSigning = await f.a.request('suppress')
  })
  await expect(
    f.client.open({ ...f.a.feed.open, requestId: 'signed_root_fresh_open' })
  ).rejects.toBeInstanceOf(OutputProtocolError)
  expect(duringSigning!.outcomes[0].actionStatus).toBe('applied')
  expect(f.responses.at(-1)!.body).not.toContain(txid)
  await f.a.project()
  await f.a.request('restore', duringSigning!.outcomes[0].decisionId!)
  await f.a.project()
  f.onSign(async () => {
    f.onSign()
    duringSigning = await f.a.request('suppress')
  })
  const finiteReset = await f.finiteHTTP()
  expect(finiteReset.status).toBe(409)
  expect(await finiteReset.text()).not.toContain(txid)
  await f.a.project()
  await f.a.request('restore', duringSigning!.outcomes[0].decisionId!)
  await f.a.project()
  expect((await f.a.finite()).answer.outputs).toHaveLength(2)
  // Bitcoin spend validation and native Mongo spend knowledge survive any root decision.
  for (const root of [f.a, f.b]) {
    const prepared = await root.finite()
    await root.submitPublicHistory(f.ad.spend.toAtomicBEEF(), [0], async () => {
      expect(
        await root.storage.findOutput(
          txid,
          0,
          f.service === 'ls_ship' ? 'tm_ship_reference' : 'tm_slap_reference',
          false
        )
      ).not.toBeNull()
      expect((await root.finite()).answer.outputs).toHaveLength(1)
      expect(() =>
        root.serving.bind(prepared.bytes, prepared.inventory, prepared.head).enqueue(
          prepared.bytes,
          () => true,
          () => {
            sends++
            return undefined
          }
        )
      ).toThrow(expect.objectContaining({ code: 'reset-required' }))
      expect(sends).toBe(0)
    })
    const spendRow = await root.storage.findHistoricalOutput(
      txid,
      0,
      f.service === 'ls_ship' ? 'tm_ship_reference' : 'tm_slap_reference'
    )
    expect(spendRow?.spent).toBe(true)
    expect((await root.finite()).answer.outputs).toHaveLength(1)
  }
  const spentBasis = await f.a.request('suppress')
  await f.a.project()
  await f.a.request('restore', spentBasis.outcomes[0].decisionId!)
  await f.a.project()
  const recoveredHistory = await f.a.gasp.hydrateGASPNode(txid + '.0', txid, 0, true)
  expect(recoveredHistory.rawTx).toBe(history.rawTx)
  // A GASP history replay may retain proof bytes; it cannot recreate a current query row.
  await f.a.submitPublicHistory(f.ad.transaction.toAtomicBEEF(), [0, 1])
  const current = await f.a.finite()
  expect(current.answer.outputs).toHaveLength(1)
  expect(current.inventory[0].outpoint.outputIndex).toBe(1)
  const reopened = f.a.reopen(),
    head = await reopened.head()
  expect(head).toEqual(await f.a.store.head())
  await f.a.store.close()
  const serving = new RootAdvertisementServing(reopened),
    bytes = new TextEncoder().encode(canonicalOutputJSON(current.answer))
  serving.bind(bytes, current.inventory).enqueue(
    bytes,
    () => true,
    () => {
      sends++
      return undefined
    }
  )
  expect(sends).toBe(1)
  expect((await reopened.serving(cache.inventory[0])).state).toBe('unresolved')
}
it('qualifies native SHIP serving, exact post-signing refusal, independent roots, durable replay and spent-history resynchronization', async () => {
  const fixture = await nativeRootServingFixture('SHIP')
  try {
    await qualifyRoot(fixture)
  } finally {
    await fixture.close()
  }
}, 90000)
it('qualifies the same complete SLAP pipeline and all physical serving cuts', async () => {
  const fixture = await nativeRootServingFixture('SLAP')
  try {
    await qualifyRoot(fixture)
  } finally {
    await fixture.close()
  }
}, 90000)
