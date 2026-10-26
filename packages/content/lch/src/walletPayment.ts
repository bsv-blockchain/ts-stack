import PublicKey from '@bsv/sdk/primitives/PublicKey'
import P2PKH from '@bsv/sdk/script/templates/P2PKH'
import Transaction from '@bsv/sdk/transaction/Transaction'
import type { AtomicBEEF, WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCH_LIMITS } from './constants.js'
import { lchAssert } from './errors.js'
import { toBase64Url, toHex } from './hash.js'
import { checkedSatoshis, matchFinalizedOutputs } from './payment.js'
import { isCompressedPublicKey } from './signatures.js'
import type { LCHTransactionState, PaymentDemand, PaymentOutput } from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotStringArray
} from './boundary.js'

export const BRC29_PAYMENT_PROTOCOL = [2, '3241645161d8'] as const

export interface MultipayDemand {
  demandId: Uint8Array
  payee: Uint8Array
  satoshis: bigint
  derivationPrefix: Uint8Array
  dutyUid: string
  authorizedOutput?: {
    derivationSuffix: Uint8Array
    lockingScript: Uint8Array
  }
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
  transactionState: Extract<LCHTransactionState, 'finalized'>
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
    Array.isArray(demands) &&
      Object.getPrototypeOf(demands) === Array.prototype &&
      Object.keys(demands).length === demands.length,
    'ERR_LCH_PAYMENT',
    'Payment Demands must be a dense ordinary array'
  )
  demands = Array.from(demands, (demand, index) => snapshotMultipayDemand(demand, index))
  lchAssert(
    demands.length > 1,
    'ERR_LCH_PAYMENT',
    'Multilateral payment requires more than one Demand'
  )
  const configuredRandom = ownDataValue(options, 'random', 'Multipay wallet options')
  const description = ownDataValue(options, 'description', 'Multipay wallet options')
  const labels = snapshotStringArray(
    ownDataValue(options, 'labels', 'Multipay wallet options'),
    'Multipay wallet labels'
  )
  lchAssert(
    configuredRandom === undefined || typeof configuredRandom === 'function',
    'ERR_LCH_PAYMENT',
    'Multipay random source is invalid'
  )
  lchAssert(
    description === undefined || typeof description === 'string',
    'ERR_LCH_PAYMENT',
    'Multipay description is invalid'
  )
  const random = (configuredRandom as ((length: number) => Uint8Array) | undefined) ?? secureRandom
  const planned: Array<{ demand: MultipayDemand; suffix: Uint8Array; payment: PaymentDemand }> = []
  const demandIds = demands.map(demand => {
    lchAssert(
      demand.demandId instanceof Uint8Array && demand.demandId.length === 32,
      'ERR_LCH_PAYMENT',
      'Demand ID must contain 32 bytes'
    )
    return toHex(demand.demandId)
  })
  lchAssert(
    new Set(demandIds).size === demandIds.length,
    'ERR_LCH_PAYMENT',
    'Demand IDs must be unique'
  )
  for (const demand of demands) {
    lchAssert(
      demand.demandId instanceof Uint8Array &&
        demand.demandId.length === 32 &&
        demand.payee instanceof Uint8Array &&
        isCompressedPublicKey(demand.payee) &&
        demand.derivationPrefix instanceof Uint8Array &&
        demand.derivationPrefix.length === 32,
      'ERR_LCH_PAYMENT',
      'Demand payment fields have invalid lengths'
    )
    lchAssert(
      typeof demand.dutyUid === 'string' &&
        demand.dutyUid.length > 0 &&
        demand.dutyUid.length <= 4096,
      'ERR_LCH_PAYMENT',
      'Demand duty UID is absent or invalid'
    )
    const satoshis = checkedSatoshis(demand.satoshis)
    const returnedSuffix = demand.authorizedOutput?.derivationSuffix ?? random(32)
    lchAssert(
      returnedSuffix instanceof Uint8Array && returnedSuffix.length === 32,
      'ERR_LCH_PAYMENT',
      'Random source returned invalid derivation suffix'
    )
    const suffix = snapshotBytes(returnedSuffix, 'Derivation suffix')
    const keyID = `${toBase64Url(demand.derivationPrefix)} ${toBase64Url(suffix)}`
    const publicKey = requiredOwnDataValue(
      await wallet.getPublicKey({
        protocolID: [...BRC29_PAYMENT_PROTOCOL],
        keyID,
        counterparty: toHex(demand.payee)
      }),
      'publicKey',
      'Wallet getPublicKey result'
    )
    lchAssert(typeof publicKey === 'string', 'ERR_LCH_PAYMENT', 'Wallet public key is invalid')
    const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
    if (demand.authorizedOutput !== undefined) {
      lchAssert(
        demand.authorizedOutput.lockingScript instanceof Uint8Array &&
          demand.authorizedOutput.lockingScript.length > 0 &&
          toHex(lockingScript.toUint8Array()) === toHex(demand.authorizedOutput.lockingScript),
        'ERR_LCH_PAYMENT',
        'Wallet-derived output does not match the Payee Authorization'
      )
    }
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
  const destinations = planned.map(
    ({ payment }) => `${payment.satoshis}:${toHex(payment.lockingScript)}`
  )
  lchAssert(
    new Set(destinations).size === destinations.length,
    'ERR_LCH_PAYMENT',
    'Payment Demands would produce ambiguous finalized outputs'
  )
  const action = await wallet.createAction({
    description: description ?? 'LCH multilateral license payment',
    labels: labels ?? ['lch multipay'],
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
  const atomicBeef = finalizedAtomicBeef(action)
  const transaction = Transaction.fromAtomicBEEF(Array.from(atomicBeef) as AtomicBEEF)
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
    atomicBeef,
    transactionState: 'finalized',
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

function finalizedAtomicBeef(action: unknown): Uint8Array {
  lchAssert(
    action !== null && typeof action === 'object',
    'ERR_LCH_PAYMENT',
    'Wallet returned an invalid action result'
  )
  const value = requiredOwnDataValue(action, 'tx', 'Wallet createAction result')
  lchAssert(
    (value instanceof Uint8Array || Array.isArray(value)) &&
      value.length > 0 &&
      value.length <= LCH_LIMITS.headerBytes &&
      Array.from(value).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'ERR_LCH_PAYMENT',
    'Wallet did not return exact bounded finalized Atomic BEEF bytes'
  )
  return Uint8Array.from(value)
}

function snapshotMultipayDemand(value: unknown, index: number): MultipayDemand {
  const name = `Payment Demand ${index}`
  const demandId = requiredOwnDataValue(value, 'demandId', name)
  const payee = requiredOwnDataValue(value, 'payee', name)
  const satoshis = requiredOwnDataValue(value, 'satoshis', name)
  const derivationPrefix = requiredOwnDataValue(value, 'derivationPrefix', name)
  const dutyUid = requiredOwnDataValue(value, 'dutyUid', name)
  const authorizedOutput = ownDataValue(value, 'authorizedOutput', name)
  const snapshot: MultipayDemand = {
    demandId:
      demandId instanceof Uint8Array
        ? snapshotBytes(demandId, `${name}.demandId`)
        : (demandId as Uint8Array),
    payee:
      payee instanceof Uint8Array ? snapshotBytes(payee, `${name}.payee`) : (payee as Uint8Array),
    satoshis: satoshis as bigint,
    derivationPrefix:
      derivationPrefix instanceof Uint8Array
        ? snapshotBytes(derivationPrefix, `${name}.derivationPrefix`)
        : (derivationPrefix as Uint8Array),
    dutyUid: dutyUid as string
  }
  if (authorizedOutput !== undefined) {
    const derivationSuffix = requiredOwnDataValue(
      authorizedOutput,
      'derivationSuffix',
      `${name}.authorizedOutput`
    )
    const lockingScript = requiredOwnDataValue(
      authorizedOutput,
      'lockingScript',
      `${name}.authorizedOutput`
    )
    snapshot.authorizedOutput = {
      derivationSuffix:
        derivationSuffix instanceof Uint8Array
          ? snapshotBytes(derivationSuffix, `${name}.authorizedOutput.derivationSuffix`)
          : (derivationSuffix as Uint8Array),
      lockingScript:
        lockingScript instanceof Uint8Array
          ? snapshotBytes(lockingScript, `${name}.authorizedOutput.lockingScript`)
          : (lockingScript as Uint8Array)
    }
  }
  return snapshot
}
