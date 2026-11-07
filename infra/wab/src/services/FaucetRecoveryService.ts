import { Curve, RPuzzle, Transaction, Utils } from '@bsv/sdk'
import { Services } from '@bsv/wallet-toolbox'
import { parsePublicWalletChain } from '../config/network'
import { db } from '../db/knex'
import type { PaymentEntity } from '../types'

const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024
const MAX_BEEF_BYTES = 8 * 1024 * 1024

type RecoveryServices = Pick<Services, 'getRawTx' | 'getMerklePath' | 'getChainTracker'>

export class FaucetRecoveryError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409 | 503
  ) {
    super(message)
    this.name = 'FaucetRecoveryError'
  }
}

function conflict(): never {
  throw new FaucetRecoveryError('Payment evidence does not match the existing reservation.', 409)
}

function matchingReadyPayment(payment: PaymentEntity, txid: string): boolean {
  if (payment.status !== 'ready') return false
  if (payment.txid !== txid) conflict()
  return true
}

export function faucetPaymentScript(k: string): string {
  if (!/^[0-9a-f]{64}$/i.test(k)) conflict()
  const curve = new Curve()
  const rValue = curve.g.mul(Utils.toArray(k, 'hex')).x?.umod(curve.n)?.toArray()
  if (rValue == null) conflict()
  const r = rValue[0] > 127 ? [0, ...rValue] : rValue
  return new RPuzzle('raw').lock(r).toHex()
}

function recoveredPaymentBeef(payment: PaymentEntity, transaction: Transaction): number[] {
  const expectedScript = faucetPaymentScript(payment.k)
  const output = transaction.outputs[payment.outputIndex]
  if (
    payment.outputIndex !== 0 ||
    !Number.isSafeInteger(payment.amount) ||
    payment.amount <= 0 ||
    output?.satoshis !== payment.amount ||
    output.lockingScript.toHex() !== expectedScript
  )
    conflict()
  const beef = transaction.toAtomicBEEF()
  if (beef.length > MAX_BEEF_BYTES) conflict()

  return beef
}

export async function saveRecoveredFaucetPayment(
  payment: PaymentEntity,
  txid: string,
  beef: number[]
): Promise<void> {
  const paymentId = payment.id
  // Match normal funding/deletion lock order; keep network calls outside the transaction.
  await db.transaction(async trx => {
    const user = await trx('users').where({ id: payment.userId }).forUpdate().first()
    if (user == null) conflict()
    const current = await trx<PaymentEntity>('payments')
      .where({ id: paymentId })
      .forUpdate()
      .first()
    if (
      current?.userId !== payment.userId ||
      current.k !== payment.k ||
      current.amount !== payment.amount ||
      current.outputIndex !== payment.outputIndex
    )
      conflict()
    if (matchingReadyPayment(current, txid)) return
    if (current.status !== 'creating' || current.txid !== payment.txid) conflict()
    const changed = await trx('payments')
      .where({ id: paymentId, status: 'creating' })
      .update({
        txid,
        beef: Buffer.from(beef),
        status: 'ready'
      })
    if (changed !== 1) conflict()
  })
}

/** Support recovery only: authenticate a mined payment, never create or broadcast one. */
export class FaucetRecoveryService {
  constructor(
    private readonly services: () => RecoveryServices = () =>
      new Services(parsePublicWalletChain(process.env.BSV_NETWORK))
  ) {}

  async reconcile(paymentId: number, txid: string): Promise<void> {
    if (!Number.isSafeInteger(paymentId) || paymentId <= 0 || !/^[0-9a-f]{64}$/.test(txid)) {
      conflict()
    }
    const payment = await db<PaymentEntity>('payments').where({ id: paymentId }).first()
    if (payment == null) throw new FaucetRecoveryError('Payment reservation was not found.', 404)
    if (payment.userId == null) conflict()
    if (payment.txid != null && payment.txid !== txid) conflict()
    if (matchingReadyPayment(payment, txid)) return
    if (payment.status !== 'creating' || !/^[0-9a-f]{64}$/i.test(payment.k)) conflict()

    const transaction = await this.confirmedTransaction(txid)
    const beef = recoveredPaymentBeef(payment, transaction)
    await saveRecoveredFaucetPayment(payment, txid, beef)
  }

  private async confirmedTransaction(txid: string): Promise<Transaction> {
    try {
      const services = this.services()
      const raw = await services.getRawTx(txid)
      if (raw.rawTx == null || raw.rawTx.length > MAX_TRANSACTION_BYTES)
        throw new Error('Raw transaction unavailable')
      for (const byte of raw.rawTx) {
        if (!Number.isInteger(byte) || byte < 0 || byte > 255)
          throw new Error('Invalid raw transaction')
      }
      const transaction = Transaction.fromBinary(raw.rawTx)
      if (transaction.id('hex') !== txid) conflict()
      const proof = await services.getMerklePath(txid)
      if (
        proof.merklePath == null ||
        (await proof.merklePath.verify(txid, await services.getChainTracker())) !== true
      ) {
        throw new Error('Confirmed proof unavailable')
      }
      // Standalone CJS resolves the same SDK class through distinct declaration paths.
      transaction.merklePath = proof.merklePath as unknown as NonNullable<Transaction['merklePath']>
      return transaction
    } catch (error) {
      if (error instanceof FaucetRecoveryError) throw error
      throw new FaucetRecoveryError(
        'Confirmed payment lookup was indeterminate; reservation remains pending.',
        503
      )
    }
  }
}

export const faucetRecoveryService = new FaucetRecoveryService()
