import { afterEach, expect, it, jest } from '@jest/globals'
import { MerklePath } from '@bsv/sdk'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'
import { WalletToolboxAcquisitionFunding } from '../src/private/WalletToolboxAcquisitionFunding.js'

import {
  acquisitionNativeWalletFixture,
  genesisHeader,
  type NativeStorage
} from './private-acquisition-wallet.fixture.js'
import type { OutputWalletFundingOperation } from '@bsv/sdk'
import type { PrivateAcquisitionWalletOutcome } from '../src/private/PrivateAcquisitionWallet.js'
afterEach(() => {
  jest.restoreAllMocks()
})

async function setup() {
  const chain = { network: 'test' as const, genesisHash: genesisHeader('test').hash }
  const f = await acquisitionStoreFixture({}, chain)
  const source = f.f.f.transaction.inputs[0].sourceTransaction!
  source.merklePath = new MerklePath(1234, [[{ offset: 0, hash: source.id('hex'), txid: true }]])
  const tracker = {
    currentHeight: async () => 1400,
    isValidRootForHeight: async (root: string, height: number) =>
      root === source.id('hex') && height === 1234
  }
  const { native, open, broadcast } = await acquisitionNativeWalletFixture(chain, tracker)
  const retained = f.reserve()
  const state = retained.state.progress,
    operation = state.funding!.operation,
    signal = new AbortController().signal
  const current = () => f.owner.store.load(f.id, f.buyer, f.clock, f.guard)!
  function accept(result: PrivateAcquisitionWalletOutcome) {
    if (result.state !== 'accepted') throw new Error('Native receipt required')
    expect(result.state).toBe('accepted')
    const row = current()
    return f.owner.store.advance(
      f.id,
      f.buyer,
      row.row.revision,
      { type: 'wallet-accepted', receipt: result.receipt },
      f.clock,
      f.guard
    )
  }
  async function assertOneCredit(active: NativeStorage) {
    const outputs = await active.findOutputs({ partial: { txid: operation.funding.txid } })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      satoshis: 100,
      vout: 1,
      change: true,
      senderIdentityKey: f.buyer
    })
    const transactions = await active.findTransactions({
      partial: { txid: operation.funding.txid }
    })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].satoshis).toBe(100)
    const requests = await active.findProvenTxReqs({ partial: { txid: operation.funding.txid } })
    expect(requests).toHaveLength(1)
    expect(requests[0].status).toBe('unsent')
    expect(broadcast).not.toHaveBeenCalled()
  }
  return { f, native, state, operation, signal, current, accept, assertOneCredit, open }
}

it('credits a real native wallet once and separately advances acquisition from its exact durable receipt', async () => {
  const s = await setup()
  expect(await s.native.bridge.status(s.state, s.signal)).toEqual({ state: 'absent' })
  const result = await s.native.bridge.internalize(s.state, s.signal)
  expect(s.current().state.progress.phase).toBe('funding-pending')
  expect(s.accept(result).state.progress.phase).toBe('funded')
  await s.assertOneCredit(s.native.active)
  await s.native.close()
  const reopened = await s.open()
  expect(await reopened.bridge.status(s.state, s.signal)).toEqual(result)
  expect(await reopened.bridge.internalize(s.state, s.signal)).toEqual(result)
  await s.assertOneCredit(reopened.active)
  expect(s.f.open().store.load(s.f.id, s.f.buyer, s.f.clock, s.f.guard)!.state.progress.phase).toBe(
    'funded'
  )
})

it('recovers a committed native credit after a lost reply and reopen without asking for another payment', async () => {
  const s = await setup()
  const controller = {
    getInternalization: (id: string) => s.native.controller.getInternalization(id),
    async internalizeOnce(operation: OutputWalletFundingOperation) {
      await s.native.controller.internalizeOnce(operation)
      throw new Error('Lost transport after native commit')
    }
  }
  const bridge = new WalletToolboxAcquisitionFunding(controller, s.native.identities)
  await expect(bridge.internalize(s.state, s.signal)).rejects.toMatchObject({ code: 'unavailable' })
  expect(s.current().state.progress.phase).toBe('funding-pending')
  await s.native.close()
  const reopened = await s.open(),
    result = await reopened.bridge.status(s.state, s.signal)
  expect(s.accept(result).state.progress.phase).toBe('funded')
  await s.assertOneCredit(reopened.active)
})

it('keeps a rolled-back native ownership write pending and retries the same retained operation', async () => {
  const s = await setup(),
    insert = s.native.active.insertOutput.bind(s.native.active)
  jest
    .spyOn(s.native.active, 'insertOutput')
    .mockImplementationOnce((row, trx) => insert({ ...row, change: false }, trx))
  await expect(s.native.bridge.internalize(s.state, s.signal)).rejects.toMatchObject({
    code: 'unavailable'
  })
  expect(await s.native.bridge.status(s.state, s.signal)).toEqual({ state: 'unknown' })
  expect(s.current().state.progress.phase).toBe('funding-pending')
  expect(
    await s.native.active.findOutputs({ partial: { txid: s.operation.funding.txid } })
  ).toEqual([])
  const result = await s.native.bridge.internalize(s.state, s.signal)
  expect(s.accept(result).state.progress.phase).toBe('funded')
  await s.assertOneCredit(s.native.active)
})

it('discloses no success after cancellation while preserving the actual committed credit for recovery', async () => {
  const s = await setup(),
    abort = new AbortController()
  const controller = {
    getInternalization: (id: string) => s.native.controller.getInternalization(id),
    async internalizeOnce(operation: OutputWalletFundingOperation) {
      const result = await s.native.controller.internalizeOnce(operation)
      abort.abort()
      return result
    }
  }
  const bridge = new WalletToolboxAcquisitionFunding(controller, s.native.identities)
  await expect(bridge.internalize(s.state, abort.signal)).rejects.toMatchObject({
    code: 'cancelled'
  })
  expect(s.current().state.progress.phase).toBe('funding-pending')
  const result = await s.native.bridge.status(s.state, s.signal)
  expect(s.accept(result).state.progress.phase).toBe('funded')
  await s.assertOneCredit(s.native.active)
})
