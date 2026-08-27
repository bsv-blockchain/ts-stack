import { P2PKH, PublicKey, Transaction, type AtomicBEEF, type WalletInterface } from '@bsv/sdk'
import { lchAssert } from './errors.js'
import { toBase64Url, toHex } from './hash.js'
import { checkedSatoshis, matchFinalizedOutputs } from './payment.js'
import type { PaymentDemand, PaymentOutput } from './types.js'

export const BRC29_PAYMENT_PROTOCOL = [2, '3241645161d8'] as const

export interface MultipayDemand {
  demandId: Uint8Array
  payee: Uint8Array
  satoshis: bigint
  derivationPrefix: Uint8Array
  dutyUid: string
}

export interface MultipayRemittance {
  demandId: Uint8Array
  derivationPrefix: Uint8Array
  derivationSuffix: Uint8Array
  outputIndex: number
}

export interface MultipayResult {
  atomicBeef: Uint8Array
  remittances: MultipayRemittance[]
}

export interface MultipayWalletOptions {
  description?: string
  labels?: string[]
  random?: (length: number) => Uint8Array
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

export async function createMultipayTransaction(
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createAction'>,
  demands: readonly MultipayDemand[],
  options: MultipayWalletOptions = {}
): Promise<MultipayResult> {
  lchAssert(
    demands.length > 1,
    'ERR_LCH_PAYMENT',
    'Multilateral payment requires more than one Demand'
  )
  const random = options.random ?? secureRandom
  const planned: Array<{ demand: MultipayDemand; suffix: Uint8Array; payment: PaymentDemand }> = []
  for (const demand of demands) {
    lchAssert(
      demand.demandId.length === 32 &&
        demand.payee.length === 33 &&
        demand.derivationPrefix.length === 32,
      'ERR_LCH_PAYMENT',
      'Demand payment fields have invalid lengths'
    )
    lchAssert(demand.dutyUid.length > 0, 'ERR_LCH_PAYMENT', 'Demand duty UID is absent')
    const satoshis = checkedSatoshis(demand.satoshis)
    const suffix = random(32)
    lchAssert(
      suffix.length === 32,
      'ERR_LCH_PAYMENT',
      'Random source returned invalid derivation suffix'
    )
    const keyID = `${toBase64Url(demand.derivationPrefix)} ${toBase64Url(suffix)}`
    const { publicKey } = await wallet.getPublicKey({
      protocolID: [...BRC29_PAYMENT_PROTOCOL],
      keyID,
      counterparty: toHex(demand.payee)
    })
    const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
    planned.push({
      demand,
      suffix,
      payment: {
        demandId: demand.demandId,
        satoshis,
        lockingScript: lockingScript.toUint8Array()
      }
    })
  }
  const action = await wallet.createAction({
    description: options.description ?? 'LCH multilateral license payment',
    labels: options.labels ?? ['lch multipay'],
    outputs: planned.map(({ demand, suffix, payment }) => ({
      satoshis: Number(payment.satoshis),
      lockingScript: toHex(payment.lockingScript),
      outputDescription: `LCH duty ${demand.dutyUid}`,
      customInstructions: JSON.stringify({
        derivationPrefix: toBase64Url(demand.derivationPrefix),
        derivationSuffix: toBase64Url(suffix),
        payee: toHex(demand.payee)
      })
    }))
  })
  lchAssert(
    action.tx !== undefined,
    'ERR_LCH_PAYMENT',
    'Wallet did not return finalized Atomic BEEF'
  )
  const transaction = Transaction.fromAtomicBEEF(action.tx as AtomicBEEF)
  const outputs: PaymentOutput[] = transaction.outputs.map((output, outputIndex) => {
    lchAssert(
      output.satoshis !== undefined,
      'ERR_LCH_PAYMENT',
      'Finalized output has no satoshi amount'
    )
    return {
      satoshis: BigInt(output.satoshis),
      lockingScript: output.lockingScript.toUint8Array(),
      outputIndex
    }
  })
  const matches = matchFinalizedOutputs(
    planned.map(item => item.payment),
    outputs
  )
  return {
    atomicBeef: Uint8Array.from(action.tx),
    remittances: planned.map(({ demand, suffix }) => {
      const outputIndex = matches.get(toHex(demand.demandId))
      lchAssert(
        outputIndex !== undefined,
        'ERR_LCH_PAYMENT',
        'Finalized Demand output was not matched'
      )
      return {
        demandId: demand.demandId,
        derivationPrefix: demand.derivationPrefix,
        derivationSuffix: suffix,
        outputIndex
      }
    })
  }
}
