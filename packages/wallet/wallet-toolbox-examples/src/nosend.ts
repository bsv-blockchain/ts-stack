import { Beef, CreateActionOptions, Random, SendWithResult } from '@bsv/sdk'
import { randomBytesBase64, Setup, SetupWallet } from '@bsv/wallet-toolbox'
import {
  mintPushDropToken,
  PushDropArgs,
  PushDropToken,
  redeemPushDropToken
} from './pushdrop'
import { runArgv2Function } from './runArgv2Function'

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
  const r: { tokens: PushDropToken[]; noSendChange?: string[] } = {
    tokens: [],
    noSendChange
  }

  for (let i = 0; i < count; i++) {
    args.fields[0][0] = i % 255

    const options: CreateActionOptions = {
      noSend: true,
      noSendChange: r.noSendChange
    }

    const token = await mintPushDropToken(setup, 37, args, options)

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
export async function sendWith(
  setup: SetupWallet,
  txids: string[]
): Promise<SendWithResult[]> {
  /**
   * Transition a set of previously created 'nosend' actions to a sendable batch of actions.
   */
  const car = await setup.wallet.createAction({
    options: {
      sendWith: txids
    },
    description: 'sendWith'
  })

  return car.sendWithResults!
}

/**
 * @publicbody
 */
export async function redeemTokens(
  setup: SetupWallet,
  tokens: PushDropToken[],
  noSendChange?: string[]
): Promise<{ beefs: Beef[]; noSendChange?: string[] }> {
  const r: { beefs: Beef[]; noSendChange?: string[] } = {
    beefs: [],
    noSendChange
  }

  for (const token of tokens) {
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

  const mr = await mintTokens(setup, args, 3, args.fields[0].length)

  const swr1 = await sendWith(
    setup,
    mr.tokens.map(t => t.beef.atomicTxid!)
  )

  const rr = await redeemTokens(setup, mr.tokens)

  const swr2 = await sendWith(
    setup,
    rr.beefs.map(b => b.atomicTxid!)
  )
}

runArgv2Function(module.exports)
