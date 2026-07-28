import { Setup } from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'

type WalletAction = Awaited<
  ReturnType<Awaited<ReturnType<typeof Setup.createWalletClient>>['wallet']['listActions']>
>['actions'][number]

function logSpendableChange(actions: WalletAction[], statuses: string[]): void {
  for (const action of actions) {
    if (!statuses.includes(action.status)) continue
    for (const output of action.outputs!) {
      if (!output.spendable || output.basket !== 'default') continue
      console.log(
        `${ar(output.satoshis, 10)} ${al(action.status, 10)} ${ar(output.outputIndex, 3)} ${action.txid}`
      )
    }
  }
}

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

    const { actions } = await setup.wallet.listActions({
      labels: [],
      includeOutputs: true,
      limit: 1000
    })

    const actionsNewestFirst = [...actions]
    actionsNewestFirst.reverse()
    for (const statuses of [['nosend'], ['completed', 'unproven']]) {
      logSpendableChange(actionsNewestFirst, statuses)
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
