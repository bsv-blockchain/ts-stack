import { InternalizeActionArgs } from '@bsv/sdk'
import { sdk, Setup } from '@bsv/wallet-toolbox'

import { outputBRC29 } from './brc29'
import { runArgv2Function } from './runArgv2Function'

/**
 * Example of internalizing a BRC29 wallet payment output into a receiving wallet.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx internalizeWalletPayment
 * ```
 *
 * Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
 * two wallets.
 *
 * This maintained example uses testnet and a freshly minted, exactly bound
 * payment. The retired `beef.ts` replay must not be used for live transactions.
 *
 * @publicbody
 */
export async function internalizeWalletPayment() {
  // obtain the secrets environment for the testnet network.
  const env = Setup.getEnv('test')

  const setup1 = await Setup.createWalletClient({ env })

  // setup2 will be the receiving wallet using the rootKey associated with identityKey2
  const setup2 = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey2]
  })

  try {
    const o = await outputBRC29(setup1, setup2.identityKey, 42)
    const { txid, vout } = sdk.Validation.parseWalletOutpoint(o.outpoint)

    const args: InternalizeActionArgs = {
      tx: o.beef.toBinaryAtomic(txid),
      outputs: [
        {
          outputIndex: vout,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: o.derivationPrefix,
            derivationSuffix: o.derivationSuffix,
            senderIdentityKey: setup1.identityKey
          }
        }
      ],
      description: 'internalizeWalletPayment example'
    }
    const iwpr = await setup2.wallet.internalizeAction(args)
    console.log(JSON.stringify(iwpr))
  } finally {
    await Promise.allSettled([setup1.wallet.destroy(), setup2.wallet.destroy()])
  }
}

if (require.main === module) void runArgv2Function(module.exports)
