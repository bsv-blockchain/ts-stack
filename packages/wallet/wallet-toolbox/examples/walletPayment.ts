import { CachedKeyDeriver, CreateActionArgs, KeyDeriverApi, PrivateKey, Utils, WalletInterface } from '@bsv/sdk'
import { randomBytesBase64, ScriptTemplateBRC29 } from '../out/src/index.js'

export interface WalletPaymentOutput {
  derivationPrefix: string
  derivationSuffix: string
  lockingScript: string
  senderIdentityKey: string
}

export interface WalletPaymentAction extends WalletPaymentOutput {
  atomicBEEF: string
  txid: string
  vout: number
}

/**
 * Construct one BRC-29 wallet-payment output for an explicit sender and payee.
 */
export function createWalletPaymentOutput(args: {
  fromRootKeyHex: string
  toIdentityKey: string
}): WalletPaymentOutput {
  const template = new ScriptTemplateBRC29({
    derivationPrefix: randomBytesBase64(8),
    derivationSuffix: randomBytesBase64(8),
    keyDeriver: new CachedKeyDeriver(PrivateKey.fromString(args.fromRootKeyHex))
  })
  return {
    senderIdentityKey: template.params.keyDeriver.identityKey,
    derivationPrefix: template.params.derivationPrefix as string,
    derivationSuffix: template.params.derivationSuffix as string,
    lockingScript: template.lock(args.fromRootKeyHex, args.toIdentityKey).toHex()
  }
}

/**
 * Create and process one BRC-29 wallet-payment action through an already
 * configured wallet. The caller explicitly chooses the amount and recipient.
 */
export async function createWalletPaymentAction(args: {
  keyDeriver: KeyDeriverApi
  outputSatoshis: number
  toIdentityKey: string
  wallet: WalletInterface
}): Promise<WalletPaymentAction> {
  if (!Number.isSafeInteger(args.outputSatoshis) || args.outputSatoshis <= 0) {
    throw new Error('Wallet-payment satoshis must be a positive integer')
  }
  const template = new ScriptTemplateBRC29({
    derivationPrefix: randomBytesBase64(8),
    derivationSuffix: randomBytesBase64(8),
    keyDeriver: args.keyDeriver
  })
  const createArgs: CreateActionArgs = {
    description: `pay ${args.toIdentityKey}`.slice(0, 50),
    labels: ['wallet-payment'],
    outputs: [
      {
        satoshis: args.outputSatoshis,
        lockingScript: template.lock(args.keyDeriver.rootKey.toString(), args.toIdentityKey).toHex(),
        outputDescription: `for ${args.toIdentityKey}`.slice(0, 50),
        basket: 'wallet-payment',
        tags: ['wp-out']
      }
    ],
    options: {
      randomizeOutputs: false,
      signAndProcess: true
    }
  }
  const created = await args.wallet.createAction(createArgs)
  if (created.txid === undefined || created.tx === undefined) {
    throw new Error('Wallet-payment action did not return a transaction ID and atomic BEEF')
  }
  return {
    senderIdentityKey: args.keyDeriver.identityKey,
    vout: 0,
    txid: created.txid,
    derivationPrefix: template.params.derivationPrefix as string,
    derivationSuffix: template.params.derivationSuffix as string,
    lockingScript: createArgs.outputs?.[0].lockingScript as string,
    atomicBEEF: Utils.toHex(created.tx)
  }
}
