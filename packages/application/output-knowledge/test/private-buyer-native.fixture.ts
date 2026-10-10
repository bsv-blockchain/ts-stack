import { createRequire } from 'node:module'
import { PrivateKey, ProtoWallet, P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import { chain, context, resolver, transactions } from './evidence-fixture.js'
import { acquisitionNativeWalletFixture } from './private-acquisition-wallet.fixture.js'
import { WalletToolboxBuyerPayment } from '../src/private/WalletToolboxBuyerPayment.js'
const requireWallet = createRequire(import.meta.url)
const { SQLiteActionRecoveryStore } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore')
const { RecoverableActionController } = requireWallet(
  '@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController'
) as typeof import('@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController')
/** Actual native allocation/signing, funded only by a signed disposable synthetic chain. */
export async function nativeBuyerFixture() {
  const selected = { ...chain, network: 'mock' as const },
    view = await resolver.resolve(
      { ...context().view, chain: selected },
      new AbortController().signal
    ),
    f = await acquisitionNativeWalletFixture(selected, view.tracker, 84),
    sender = new ProtoWallet(new PrivateKey(90)),
    senderIdentityKey = (await sender.getPublicKey({ identityKey: true })).publicKey,
    prefix = 'c3ludGhldGljLWJ1eWVy',
    suffix = 'c3ludGhldGljLWZ1bmRpbmc=',
    paymentKey = (
      await sender.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${prefix} ${suffix}`,
        counterparty: f.native.identities.wallet
      })
    ).publicKey,
    source = transactions.get('P')!,
    seed = new Transaction(
      1,
      [
        {
          sourceTransaction: source,
          sourceOutputIndex: 0,
          unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
          sequence: 0xffffffff
        }
      ],
      [
        {
          satoshis: source.outputs[0].satoshis! - 1,
          lockingScript: new P2PKH().lock(PublicKey.fromString(paymentKey).toAddress())
        }
      ],
      0
    )
  await seed.sign()
  await f.native.wallet.internalizeAction({
    tx: seed.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { senderIdentityKey, derivationPrefix: prefix, derivationSuffix: suffix }
      }
    ],
    description: 'Disposable synthetic buyer funding'
  })
  const originator = 'buyer-reference.local'
  async function installed(native = f.native, create = false) {
    const store = await SQLiteActionRecoveryStore[create ? 'install' : 'open'](native.active),
      actions = new RecoverableActionController(native.wallet, store, originator),
      payment = new WalletToolboxBuyerPayment(actions, native.wallet, {
        wallet: native.identities.wallet,
        storage: native.identities.storage,
        chain: selected,
        originator
      })
    return { native, store, actions, payment }
  }
  const initial = await installed(f.native, true)
  return {
    ...initial,
    selected,
    fixture: f,
    async reopen() {
      return installed(await f.open())
    },
    close: f.close
  }
}
