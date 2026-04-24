import { Beef } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'
import { inputBRC29 } from './brc29'
import { runArgv2Function } from './runArgv2Function'

/**
 * Example receiving funding satoshis from an external BRC-100 wallet to your wallet to another using the BRC29 script template.
 *
 * Edit the funding information into this example, then run the code.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx brc29Funding
 * ```
 *
 * Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
 * two wallets.
 *
 * @publicbody
 */
export async function brc29Funding() {
  const env = Setup.getEnv('test')
  const setup = await Setup.createWalletClient({ env })

  /**
   * EDIT THIS INITIALIZER WITH THE INFORMATION FOR YOUR BRC29 FUNDING OUTPUT:
   */
  const funding = {
    beef: Beef.fromString(''),
    outpoint: '',
    fromIdentityKey: '',
    satoshis: 0,
    derivationPrefix: '',
    derivationSuffix: ''
  }

  await inputBRC29(setup, funding)
}

runArgv2Function(module.exports)
