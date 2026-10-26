import { CreateActionOptions, Transaction } from '@bsv/sdk'

const CREATE_OPTION_KEYS = new Set([
  'signAndProcess',
  'acceptDelayedBroadcast',
  'trustSelf',
  'knownTxids',
  'returnTXIDOnly',
  'noSend',
  'noSendChange',
  'sendWith',
  'randomizeOutputs'
])
const ARRAY_OPTION_KEYS = new Set(['knownTxids', 'noSendChange', 'sendWith'])

export function snapshotCreateActionOptions(options: CreateActionOptions): CreateActionOptions {
  if (!isPlainRecord(options)) throw new Error('Action options must be a plain data object')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Object.getOwnPropertySymbols(options).length !== 0) {
    throw new Error('Action options must contain only string-keyed data properties')
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!CREATE_OPTION_KEYS.has(key)) throw new Error(`Unknown action option "${key}"`)
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`Action option "${key}" must be an own data property`)
    }
    snapshot[key] =
      ARRAY_OPTION_KEYS.has(key) && descriptor.value !== undefined
        ? snapshotStringArray(
            descriptor.value,
            `Action option "${key}"`,
            1_000,
            key === 'noSendChange' ? 75 : 64
          )
        : descriptor.value
  }
  return snapshot as CreateActionOptions
}

export function snapshotStringArray(
  value: unknown,
  label: string,
  maximum: number,
  maximumStringBytes = 4_096
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded string array`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set(['length'])
  const snapshot: string[] = []
  for (let index = 0; index < value.length; index++) {
    expectedKeys.add(String(index))
    const descriptor = descriptors[String(index)]
    if (
      descriptor == null ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > maximumStringBytes ||
      new TextEncoder().encode(descriptor.value).length > maximumStringBytes
    ) {
      throw new Error(`${label} must be a dense own-data string array`)
    }
    snapshot.push(descriptor.value)
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expectedKeys.has(key)) {
      throw new Error(`${label} must not contain extra properties`)
    }
  }
  return snapshot
}

export function assertSatoshis(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 21e14) {
    throw new Error('Satoshis must be a non-negative safe integer')
  }
}

export function findRequestedInputIndex(transaction: Transaction, outpoint: string): number {
  const match = /^([0-9a-fA-F]{64})\.(0|[1-9]\d*)$/.exec(outpoint)
  if (match == null) throw new Error('Requested outpoint is invalid')
  const outputIndex = Number(match[2])
  if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
    throw new Error('Requested outpoint index is invalid')
  }
  const txid = match[1].toLowerCase()
  const matches = transaction.inputs.flatMap((input, index) => {
    const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    return typeof sourceTxid === 'string' &&
      sourceTxid.toLowerCase() === txid &&
      input.sourceOutputIndex === outputIndex
      ? [index]
      : []
  })
  if (matches.length !== 1)
    throw new Error('Signable transaction does not contain the requested input exactly once')
  return matches[0]
}

export function findRequestedOutputIndex(
  transaction: Transaction,
  lockingScript: string,
  satoshis: number
): number {
  assertSatoshis(satoshis)
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(lockingScript)) {
    throw new Error('Requested locking script is invalid')
  }
  const normalizedScript = lockingScript.toLowerCase()
  const matches = transaction.outputs.flatMap((output, index) =>
    output.satoshis === satoshis && output.lockingScript.toHex().toLowerCase() === normalizedScript
      ? [index]
      : []
  )
  if (matches.length !== 1) {
    throw new Error('Wallet transaction does not contain the requested output exactly once')
  }
  return matches[0]
}

export function assertSameSignedTransaction(
  locallySigned: Transaction,
  walletReturned: Transaction
): void {
  if (walletReturned.toHex() !== locallySigned.toHex()) {
    throw new Error('Wallet substituted the transaction after external signing')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
