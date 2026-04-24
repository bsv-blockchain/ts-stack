import {
  Beef,
  InternalizeActionArgs,
  PrivateKey,
  PublicKey,
  SignActionArgs
} from '@bsv/sdk'
import {
  randomBytesBase64,
  ScriptTemplateBRC29,
  Services,
  Setup,
  SetupWallet
} from '@bsv/wallet-toolbox'
import { outputBRC29 } from './brc29'
import { parseWalletOutpoint } from '@bsv/wallet-toolbox/out/src/sdk'
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
 * @publicbody
 */
export async function internalizeWalletPayment() {
  // obtain the secrets environment for the testnet network.
  const env = Setup.getEnv('main')

  const setup1 = await Setup.createWalletClient({ env })

  // setup2 will be the receiving wallet using the rootKey associated with identityKey2
  const setup2 = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey2]
  })

  // Create a brc29 output to internalize
  const o = await outputBRC29(setup1, setup2.identityKey, 42)
  const { txid, vout } = parseWalletOutpoint(o.outpoint)

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

  await setup1.wallet.destroy()
  await setup2.wallet.destroy()
}

runArgv2Function(module.exports)
