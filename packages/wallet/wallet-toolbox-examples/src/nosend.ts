import { Beef, CreateActionOptions, Random, SendWithResult } from '@bsv/sdk'
import { randomBytesBase64, Setup, SetupWallet } from '@bsv/wallet-toolbox'
import {
  mintPushDropToken,
  PushDropArgs,
  PushDropToken,
  redeemPushDropToken,
  snapshotPushDropArgs,
  snapshotPushDropToken
} from './pushdrop'
import { runArgv2Function } from './runArgv2Function'
import { snapshotStringArray } from './transactionSafety'

/**
 * @publicbody
 */
export async function mintTokens(
  setup: SetupWallet,
  args: PushDropArgs,
  count: number,
  size: number,
  noSendChange?: string[]
): Promise<{ tokens: PushDropToken[]; noSendChange?: string[] }> {
  const safeArgs = snapshotPushDropArgs(args)
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000) {
    throw new Error('Token count must be a safe integer from 0 to 1000')
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_048_576) {
    throw new Error('Token field size must be a safe integer from 1 to 1048576')
  }
  if (safeArgs.fields[0].length !== size) {
    throw new Error('Token field size does not match the first field')
  }
  const r: { tokens: PushDropToken[]; noSendChange?: string[] } = {
    tokens: [],
    noSendChange:
      noSendChange == null
        ? undefined
        : snapshotStringArray(noSendChange, 'No-send change', 1_000, 75)
  }

  for (let i = 0; i < count; i++) {
    const fields = safeArgs.fields.map(field => [...field])
    fields[0][0] = i % 256

    const options: CreateActionOptions = {
      noSend: true,
      noSendChange: r.noSendChange
    }

    const token = await mintPushDropToken(setup, 37, { ...safeArgs, fields }, options)

    // Since each token creating action is created with status 'nosend', remember the txids that need sending, and tokens we can redeem.
    r.tokens.push(token)
    // Forward the change from this token creating action to the following 'nosend' actions.
    r.noSendChange = token.noSendChange
  }

  return r
}

/**
 * @publicbody
 */
export async function sendWith(setup: SetupWallet, txids: string[]): Promise<SendWithResult[]> {
  const submitted = snapshotStringArray(txids, 'sendWith transaction IDs', 1_000, 64)
  if (submitted.length === 0) throw new Error('sendWith requires at least one transaction ID')
  const expected = new Set<string>()
  for (const txid of submitted) {
    if (!/^[0-9a-fA-F]{64}$/.test(txid))
      throw new Error('sendWith contains an invalid transaction ID')
    const normalized = txid.toLowerCase()
    if (expected.has(normalized)) throw new Error('sendWith transaction IDs must be unique')
    expected.add(normalized)
  }
  /**
   * Transition a set of previously created 'nosend' actions to a sendable batch of actions.
   */
  const car = await setup.wallet.createAction({
    options: {
      sendWith: submitted
    },
    description: 'sendWith'
  })

  if (!Array.isArray(car.sendWithResults) || car.sendWithResults.length !== expected.size) {
    throw new Error('Wallet did not return one sendWith result per submitted transaction')
  }
  const resultDescriptors = Object.getOwnPropertyDescriptors(car.sendWithResults)
  const expectedResultKeys = new Set(['length'])
  const seen = new Set<string>()
  const results = Array.from({ length: car.sendWithResults.length }, (_, index) => {
    expectedResultKeys.add(String(index))
    const itemDescriptor = resultDescriptors[String(index)]
    const item = itemDescriptor?.value
    if (
      itemDescriptor == null ||
      !itemDescriptor.enumerable ||
      !('value' in itemDescriptor) ||
      item == null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
    ) {
      throw new Error('Wallet returned an invalid sendWith result')
    }
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (
      Reflect.ownKeys(descriptors).some(
        key =>
          typeof key !== 'string' ||
          !new Set(['txid', 'status']).has(key) ||
          descriptors[key] == null ||
          !descriptors[key].enumerable ||
          !('value' in descriptors[key])
      )
    ) {
      throw new Error('Wallet returned an invalid sendWith result')
    }
    const rawTxid = descriptors.txid?.value
    const status = descriptors.status?.value
    if (
      typeof rawTxid !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(rawTxid) ||
      (status !== 'unproven' && status !== 'sending' && status !== 'failed')
    ) {
      throw new Error('Wallet returned an invalid sendWith result')
    }
    const txid = rawTxid.toLowerCase()
    if (!expected.has(txid) || seen.has(txid)) {
      throw new Error('Wallet returned an unexpected or duplicate sendWith result')
    }
    seen.add(txid)
    return { txid, status }
  })
  for (const key of Reflect.ownKeys(resultDescriptors)) {
    if (typeof key !== 'string' || !expectedResultKeys.has(key)) {
      throw new Error('Wallet returned an invalid sendWith result array')
    }
  }
  return results
}

/**
 * @publicbody
 */
export async function redeemTokens(
  setup: SetupWallet,
  tokens: PushDropToken[],
  noSendChange?: string[]
): Promise<{ beefs: Beef[]; noSendChange?: string[] }> {
  if (!Array.isArray(tokens) || tokens.length > 1_000) {
    throw new Error('Tokens must be a bounded array')
  }
  const tokenDescriptors = Object.getOwnPropertyDescriptors(tokens)
  const expectedTokenKeys = new Set(['length'])
  const tokenSnapshot = Array.from({ length: tokens.length }, (_, index) => {
    expectedTokenKeys.add(String(index))
    const descriptor = tokenDescriptors[String(index)]
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Tokens must be a dense own-data array')
    }
    return snapshotPushDropToken(descriptor.value as PushDropToken)
  })
  for (const key of Reflect.ownKeys(tokenDescriptors)) {
    if (typeof key !== 'string' || !expectedTokenKeys.has(key)) {
      throw new Error('Tokens must not contain extra properties')
    }
  }
  const r: { beefs: Beef[]; noSendChange?: string[] } = {
    beefs: [],
    noSendChange:
      noSendChange == null
        ? undefined
        : snapshotStringArray(noSendChange, 'No-send change', 1_000, 75)
  }

  for (const token of tokenSnapshot) {
    const options: CreateActionOptions = {
      noSend: true,
      noSendChange: r.noSendChange
    }

    const rr = await redeemPushDropToken(setup, token, options)

    // Since each token creating action is created with status 'nosend', remember the txids that need sending, and tokens we can redeem.
    r.beefs.push(rr.beef)
    // Forward the change from this token creating action to the following 'nosend' actions.
    r.noSendChange = rr.noSendChange
  }

  return r
}

/**
 * @publicbody
 */
export async function nosend() {
  const env = Setup.getEnv('test')
  const setup = await Setup.createWalletClient({ env })

  const args: PushDropArgs = {
    protocolID: [2, 'nosendexample'],
    keyID: randomBytesBase64(8),
    includeSignature: false,
    lockPosition: 'before',
    counterparty: 'self',
    fields: [Random(12)]
  }

  try {
    const mr = await mintTokens(setup, args, 3, args.fields[0].length)
    await sendWith(
      setup,
      mr.tokens.map(t => requiredAtomicTxid(t.beef))
    )
    const rr = await redeemTokens(setup, mr.tokens)
    await sendWith(setup, rr.beefs.map(requiredAtomicTxid))
  } finally {
    await setup.wallet.destroy()
  }
}

function requiredAtomicTxid(beef: Beef): string {
  if (beef.atomicTxid == null) throw new Error('Expected an Atomic BEEF transaction')
  return beef.atomicTxid
}

if (require.main === module) void runArgv2Function(module.exports)
