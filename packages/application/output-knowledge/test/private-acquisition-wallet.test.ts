import { beforeAll, expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { WalletToolboxAcquisitionFunding } from '../src/private/WalletToolboxAcquisitionFunding.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'
let f: Awaited<ReturnType<typeof acquisitionFixture>>
beforeAll(async () => {
  f = await acquisitionFixture()
})
function setup() {
  const state = f.reserved(),
    operation = state.funding!.operation,
    storage = new PrivateKey(85).toPublicKey().toString()
  const receipt = {
    protocol: 'wallet-funding-recovery-v1',
    operationId: operation.id,
    funding: operation.funding,
    satoshis: operation.satoshis,
    walletIdentity: f.seller,
    storageIdentity: storage,
    transactionId: 100
  }
  let result: unknown = { state: 'accepted', funding: operation.funding, receipt }
  const calls: unknown[] = []
  const controller = {
    async getInternalization(id: string) {
      calls.push(['read', id])
      return result
    },
    async internalizeOnce(input: unknown) {
      calls.push(['credit', input])
      return result
    }
  }
  const adapter = new WalletToolboxAcquisitionFunding(controller, { wallet: f.seller, storage })
  return {
    state,
    operation,
    storage,
    receipt,
    controller,
    adapter,
    calls,
    set: (value: unknown) => {
      result = value
    }
  }
}
it('binds the native receipt to independent wallet/storage identities and the exact operation', async () => {
  const s = setup(),
    signal = new AbortController().signal
  const status = await s.adapter.status(s.state, signal)
  expect(status).toEqual({
    state: 'accepted',
    receipt: {
      operationId: s.operation.id,
      funding: s.operation.funding,
      seller: f.seller,
      satoshis: '100',
      evidence: s.receipt
    }
  })
  expect(s.calls).toEqual([['read', s.operation.id]])
  expect(await s.adapter.internalize(s.state, signal)).toEqual(status)
  expect(s.calls[1]).toEqual(['credit', s.operation])
})
it.each(['absent', 'unknown'] as const)(
  'preserves %s without any invented wallet effect',
  async state => {
    const s = setup()
    s.set({ state })
    expect(await s.adapter.status(s.state, new AbortController().signal)).toEqual({ state })
    expect(s.calls).toHaveLength(1)
  }
)
it('binds a definitive rejection to the original operation and never creates another', async () => {
  const s = setup()
  s.set({ state: 'rejected', reason: 'payment-script-mismatch' })
  expect(await s.adapter.status(s.state, new AbortController().signal)).toEqual({
    state: 'rejected',
    operationId: s.operation.id,
    reason: 'payment-script-mismatch'
  })
})
it.each([
  'protocol',
  'operationId',
  'funding',
  'satoshis',
  'walletIdentity',
  'storageIdentity',
  'transactionId',
  'outer-funding',
  'extra',
  'missing'
] as const)('refuses a native accepted receipt with changed %s', async field => {
  const s = setup(),
    receipt = structuredClone(s.receipt)
  if (field === 'protocol') receipt.protocol = 'other'
  if (field === 'operationId') receipt.operationId = '99'.repeat(32)
  if (field === 'funding') receipt.funding.outputIndex = 0
  if (field === 'satoshis') receipt.satoshis = '101'
  if (field === 'walletIdentity')
    receipt.walletIdentity = new PrivateKey(89).toPublicKey().toString()
  if (field === 'storageIdentity')
    receipt.storageIdentity = new PrivateKey(89).toPublicKey().toString()
  if (field === 'transactionId') receipt.transactionId = 0
  if (field === 'extra') (receipt as Record<string, unknown>).secret = 'unrecognized'
  if (field === 'missing') delete (receipt as Record<string, unknown>).storageIdentity
  s.set({
    state: 'accepted',
    funding:
      field === 'outer-funding' ? { ...s.operation.funding, outputIndex: 0 } : s.operation.funding,
    receipt
  })
  await expect(s.adapter.status(s.state, new AbortController().signal)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Acquisition wallet receipt is unavailable'
  })
})
it.each([
  { state: 'absent', receipt: {} },
  { state: 'unknown', reason: 'x' },
  { state: 'rejected', reason: 'transport-error' },
  { state: 'claimed' },
  { state: 'accepted' }
])('does not treat malformed outcomes as absence or rejection: %j', async input => {
  const s = setup()
  s.set(input)
  await expect(s.adapter.status(s.state, new AbortController().signal)).rejects.toMatchObject({
    code: 'unavailable'
  })
})
it('refuses a changed installed method before work and after a pending reply', async () => {
  const s = setup()
  s.controller.getInternalization = async () => ({ state: 'absent' })
  await expect(s.adapter.status(s.state, new AbortController().signal)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(s.calls).toEqual([])
  let release!: (value: unknown) => void
  const t = setup(),
    controller = {
      internalizeOnce: t.controller.internalizeOnce,
      getInternalization: () =>
        new Promise(resolve => {
          release = resolve
        })
    }
  const adapter = new WalletToolboxAcquisitionFunding(controller, {
    wallet: f.seller,
    storage: t.storage
  })
  const work = adapter.status(t.state, new AbortController().signal)
  controller.internalizeOnce = async () => ({ state: 'absent' })
  release({ state: 'accepted', funding: t.operation.funding, receipt: t.receipt })
  await expect(work).rejects.toMatchObject({ code: 'context-changed' })
})
it('keeps lost outcomes unavailable with fixed public text', async () => {
  const s = setup(),
    controller = {
      internalizeOnce: async () => {
        throw new Error('private database detail')
      },
      getInternalization: async () => {
        throw new Error('private database detail')
      }
    }
  const adapter = new WalletToolboxAcquisitionFunding(controller, {
    wallet: f.seller,
    storage: s.storage
  })
  for (const operation of ['status', 'internalize'] as const)
    await expect(adapter[operation](s.state, new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Acquisition wallet outcome is unavailable'
    })
})
it('checks cancellation before a physical call and after it settles', async () => {
  const s = setup(),
    stopped = new AbortController()
  stopped.abort()
  await expect(s.adapter.status(s.state, stopped.signal)).rejects.toMatchObject({
    code: 'cancelled'
  })
  expect(s.calls).toEqual([])
  let release!: (value: unknown) => void
  const controller = {
    internalizeOnce: s.controller.internalizeOnce,
    getInternalization: () =>
      new Promise(resolve => {
        release = resolve
      })
  }
  const adapter = new WalletToolboxAcquisitionFunding(controller, {
      wallet: f.seller,
      storage: s.storage
    }),
    abort = new AbortController()
  const work = adapter.status(s.state, abort.signal)
  abort.abort()
  release({ state: 'accepted', funding: s.operation.funding, receipt: s.receipt })
  await expect(work).rejects.toMatchObject({ code: 'cancelled' })
})
it('requires already reserved funding and the installed seller before calling the wallet', async () => {
  const s = setup()
  await expect(s.adapter.status(f.initial(), new AbortController().signal)).rejects.toMatchObject({
    code: 'conflict'
  })
  const other = new WalletToolboxAcquisitionFunding(s.controller, {
    wallet: s.storage,
    storage: s.storage
  })
  await expect(other.internalize(s.state, new AbortController().signal)).rejects.toMatchObject({
    code: 'context-changed'
  })
  expect(s.calls).toEqual([])
})

it('preserves opaque native storage identities without interpreting them as network public keys', async () => {
  const s = setup(),
    storage = 'synthetic-wallet-storage-namespace'
  s.set({
    state: 'accepted',
    funding: s.operation.funding,
    receipt: { ...s.receipt, storageIdentity: storage }
  })
  const adapter = new WalletToolboxAcquisitionFunding(s.controller, { wallet: f.seller, storage })
  await expect(adapter.status(s.state, new AbortController().signal)).resolves.toMatchObject({
    state: 'accepted',
    receipt: { evidence: { storageIdentity: storage } }
  })
})
