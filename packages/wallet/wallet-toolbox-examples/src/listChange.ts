import { Beef } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'
import { parseWalletOutpoint } from '@bsv/wallet-toolbox/out/src/sdk'
import { runArgv2Function } from './runArgv2Function'

/**
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx listChange
 * ```
 *
 * @publicbody
 */
export async function listChange(): Promise<void> {
  const env = Setup.getEnv('test')
  for (const identityKey of [env.identityKey, env.identityKey2]) {
    const setup = await Setup.createWalletClient({
      env,
      rootKeyHex: env.devKeys[identityKey]
    })

    console.log(`

Change for:
  identityKey ${identityKey}
`)

    const { actions, totalActions } = await setup.wallet.listActions({
      labels: [],
      includeOutputs: true,
      limit: 1000
    })

    for (const stati of [['nosend'], ['completed', 'unproven']])
      for (const a of actions.reverse()) {
        if (stati.indexOf(a.status) >= 0) {
          for (const o of a.outputs!) {
            if (o.spendable && o.basket === 'default') {
              console.log(
                `${ar(o.satoshis, 10)} ${al(a.status, 10)} ${ar(o.outputIndex, 3)} ${a.txid}`
              )
            }
          }
        }
      }
  }
}

/**
 * "Align Left" function for simple table formatting.
 * Adds spaces to the end of a string or number value to
 * return a string of minimum length `w`
 */
export function al(v: string | number, w: number): string {
  return v.toString().padEnd(w)
}

/**
 * "Align Right" function for simple table formatting.
 * Adds spaces to the start of a string or number value to
 * return a string of minimum length `w`
 */
export function ar(v: string | number, w: number): string {
  return v.toString().padStart(w)
}

runArgv2Function(module.exports)
