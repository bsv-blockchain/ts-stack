import { Curve, MerklePath, RPuzzle, Script, Transaction, Utils } from '@bsv/sdk'
import { Setup, type Services } from '@bsv/wallet-toolbox'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import app from '../app'
import { db } from '../db/knex'
import { FaucetRecoveryService, faucetRecoveryService } from '../services/FaucetRecoveryService'
import { FaucetPaymentPendingError, UserService } from '../services/UserService'

const k = '02'.repeat(32)
function paymentTransaction(amount = 6000, script?: string): Transaction {
  const c = new Curve()
  const r = c.g.mul(Utils.toArray(k, 'hex')).x!.umod(c.n).toArray()
  const lockingScript =
    script == null ? new RPuzzle('raw').lock(r[0] > 127 ? [0, ...r] : r) : Script.fromHex(script)
  const tx = new Transaction()
  tx.addOutput({ satoshis: amount, lockingScript })
  return tx
}
function proofServices(tx: Transaction) {
  const path = new MerklePath(100, [
    [
      { offset: 0, hash: 'ab'.repeat(32) },
      { offset: 1, hash: tx.id('hex'), txid: true }
    ]
  ])
  const tracker = {
    currentHeight: jest.fn(async () => 101),
    isValidRootForHeight: jest.fn(
      async (root: string, height: number) =>
        height === 100 && root === path.computeRoot(tx.id('hex'))
    )
  }
  const services = {
    getRawTx: jest.fn(async () => ({ txid: tx.id('hex'), rawTx: tx.toBinary() })),
    getMerklePath: jest.fn(async () => ({ merklePath: path })),
    getChainTracker: jest.fn(async () => tracker)
  }
  return {
    services,
    tracker,
    recovery: new FaucetRecoveryService(
      () => services as unknown as Pick<Services, 'getRawTx' | 'getMerklePath' | 'getChainTracker'>
    )
  }
}

describe('confirmed faucet payment recovery', () => {
  let userId: number
  let paymentId: number
  let server: Server
  let url: string
  const token = 'synthetic-admin-token-'.repeat(3)
  const originalAdminToken = process.env.WAB_ADMIN_TOKEN
  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
    if (originalAdminToken == null) delete process.env.WAB_ADMIN_TOKEN
    else process.env.WAB_ADMIN_TOKEN = originalAdminToken
  })
  beforeEach(async () => {
    process.env.WAB_ADMIN_TOKEN = token
    const user = await UserService.createUser('recovery-' + Math.random())
    userId = user.id
    await UserService.linkAuthMethod(
      userId,
      'TwilioPhone',
      '+1415' + String(userId).padStart(7, '0')
    )
    await UserService.markFaucetReceived(userId)
    paymentId = (
      await db('payments').insert({ userId, k, amount: 6000, outputIndex: 0, status: 'creating' })
    )[0]
  })
  afterEach(() => jest.restoreAllMocks())
  async function post(body: unknown, authorization?: string) {
    return await fetch(`${url}/admin/faucet/reconcile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization == null ? {} : { authorization })
      },
      body: JSON.stringify(body)
    })
  }
  it('recovers a mined grant and registration retries reuse it without funding', async () => {
    const walletCreation = jest
      .spyOn(Setup, 'createWalletClientNoEnv')
      .mockRejectedValue(new Error('Storage unavailable'))
    await expect(UserService.getOrCreateFaucetPayment(userId, 6000)).rejects.toBeInstanceOf(
      FaucetPaymentPendingError
    )
    const tx = paymentTransaction()
    const { recovery, tracker } = proofServices(tx)
    await recovery.reconcile(paymentId, tx.id('hex'))
    const ready = await UserService.getOrCreateFaucetPayment(userId, 6000)
    expect(ready).toMatchObject({
      id: paymentId,
      txid: tx.id('hex'),
      status: 'ready',
      k,
      amount: 6000
    })
    expect(Transaction.fromAtomicBEEF([...ready.beef]).id('hex')).toBe(tx.id('hex'))
    expect(tracker.isValidRootForHeight).toHaveBeenCalledTimes(1)
    expect(walletCreation).toHaveBeenCalledTimes(1)
    expect(await db('payments').where({ userId })).toHaveLength(1)
    expect(Boolean((await db('auth_methods').where({ userId }).first()).receivedFaucet)).toBe(true)
  })
  it('recovers a real reservation left by a failed createAction response', async () => {
    await db('payments').where({ id: paymentId }).del()
    await db('auth_methods').where({ userId }).update({ receivedFaucet: false })
    let committed: Transaction | undefined
    const createAction = jest.fn(
      async (args: { outputs: { satoshis: number; lockingScript: string }[] }) => {
        committed = new Transaction()
        committed.addOutput({
          satoshis: args.outputs[0].satoshis,
          lockingScript: Script.fromHex(args.outputs[0].lockingScript)
        })
        // Storage has committed the signed transaction, but WAB receives an error.
        throw new Error('Ambiguous processAction result')
      }
    )
    jest
      .spyOn(Setup, 'createWalletClientNoEnv')
      .mockResolvedValue({ createAction } as unknown as Awaited<
        ReturnType<typeof Setup.createWalletClientNoEnv>
      >)
    await expect(UserService.getOrCreateFaucetPayment(userId, 6000)).rejects.toBeInstanceOf(
      FaucetPaymentPendingError
    )
    const pending = await db('payments').where({ userId }).first()
    expect(pending).toMatchObject({ status: 'creating', txid: null, beef: null })
    if (committed == null) throw new Error('Test funding did not reach Storage')
    await proofServices(committed).recovery.reconcile(pending.id, committed.id('hex'))
    await expect(UserService.getOrCreateFaucetPayment(userId, 6000)).resolves.toMatchObject({
      id: pending.id,
      txid: committed.id('hex'),
      status: 'ready'
    })
    expect(createAction).toHaveBeenCalledTimes(1)
  })
  it('serializes two concurrent recoveries of the same grant', async () => {
    const tx = paymentTransaction()
    const { recovery } = proofServices(tx)
    await Promise.all([
      recovery.reconcile(paymentId, tx.id('hex')),
      recovery.reconcile(paymentId, tx.id('hex'))
    ])
    expect(await db('payments').where({ userId })).toHaveLength(1)
    expect((await db('payments').where({ id: paymentId }).first()).txid).toBe(tx.id('hex'))
  })
  it('refuses a conflicting transaction checkpoint and invalid output index', async () => {
    const tx = paymentTransaction()
    const { recovery } = proofServices(tx)
    await db('payments')
      .where({ id: paymentId })
      .update({ txid: 'ff'.repeat(32) })
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 409 })
    await db('payments').where({ id: paymentId }).update({ txid: null, outputIndex: 1 })
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 409 })
  })
  it('is idempotent without another lookup but rejects another transaction', async () => {
    const tx = paymentTransaction()
    const { recovery, services } = proofServices(tx)
    await recovery.reconcile(paymentId, tx.id('hex'))
    await recovery.reconcile(paymentId, tx.id('hex'))
    expect(services.getRawTx).toHaveBeenCalledTimes(1)
    await expect(recovery.reconcile(paymentId, 'ff'.repeat(32))).rejects.toMatchObject({
      status: 409
    })
  })
  it.each([
    ['wrong amount', 5999, undefined],
    ['wrong puzzle', 6000, '51']
  ])('rejects %s even with a valid mining proof', async (_name, amount, script) => {
    const tx = paymentTransaction(amount, script)
    await expect(
      proofServices(tx).recovery.reconcile(paymentId, tx.id('hex'))
    ).rejects.toMatchObject({ status: 409 })
    expect((await db('payments').where({ id: paymentId }).first()).status).toBe('creating')
  })
  it('rejects raw bytes for another transaction', async () => {
    const { recovery } = proofServices(paymentTransaction())
    await expect(recovery.reconcile(paymentId, 'ff'.repeat(32))).rejects.toMatchObject({
      status: 409
    })
  })
  it('keeps the reservation pending when root validation rejects the proof', async () => {
    const tx = paymentTransaction()
    const { recovery, tracker } = proofServices(tx)
    tracker.isValidRootForHeight.mockResolvedValue(false)
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 503 })
    expect((await db('payments').where({ id: paymentId }).first()).status).toBe('creating')
  })
  it('keeps the reservation pending when proof or provider is unavailable', async () => {
    const tx = paymentTransaction()
    const { recovery, services } = proofServices(tx)
    services.getMerklePath.mockRejectedValueOnce(new Error('No proof'))
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 503 })
    services.getRawTx.mockRejectedValueOnce(new Error('Lookup unavailable'))
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 503 })
    expect((await db('payments').where({ id: paymentId }).first()).txid).toBeNull()
  })
  it('refuses a detached reservation before lookup', async () => {
    await db('payments').where({ id: paymentId }).update({ userId: null })
    const tx = paymentTransaction()
    const { recovery, services } = proofServices(tx)
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 409 })
    expect(services.getRawTx).not.toHaveBeenCalled()
  })
  it('rechecks reservation ownership after the lookup', async () => {
    const tx = paymentTransaction()
    const { recovery, services } = proofServices(tx)
    services.getRawTx.mockImplementationOnce(async () => {
      await db('payments').where({ id: paymentId }).update({ userId: null })
      return { txid: tx.id('hex'), rawTx: tx.toBinary() }
    })
    await expect(recovery.reconcile(paymentId, tx.id('hex'))).rejects.toMatchObject({ status: 409 })
  })
  it('validates admin input, requires the admin token, and respects the disabled state', async () => {
    const reconcile = jest.spyOn(faucetRecoveryService, 'reconcile').mockResolvedValue()
    const body = { paymentId, txid: paymentTransaction().id('hex') }
    expect((await post(body)).status).toBe(401)
    expect((await post(body, 'Bearer invalid')).status).toBe(401)
    expect((await post({ paymentId: -1, txid: body.txid }, `Bearer ${token}`)).status).toBe(400)
    expect((await post({ paymentId, txid: 'invalid' }, `Bearer ${token}`)).status).toBe(400)
    expect(reconcile).not.toHaveBeenCalled()
    const response = await post(body, `Bearer ${token}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, status: 'ready' })
    process.env.WAB_ADMIN_TOKEN = ''
    expect((await post(body, `Bearer ${token}`)).status).toBe(404)
  })
})
