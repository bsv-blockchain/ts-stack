import { sdk, Setup } from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'
import { specOpWalletBalance } from '@bsv/wallet-toolbox/out/src/sdk'
import { assertSatoshis } from './transactionSafety'

const MAX_BALANCE_OUTPUTS = 100_000

/**
 * The `balance` function demonstrates creating a `ServerClient` based wallet and
 * calculating the wallet's "balance" as the sum of spendable outputs in the 'default' basket.
 *
 * The 'default' basket holds the outputs that are used to automatically fund new actions,
 * and receives new outputs generated to recapture excess funding.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx balances
 * ```
 *
 * @publicbody
 */
export async function balances(): Promise<void> {
  // Read the "secrets" from the .env file created by `makeEnv`
  const env = Setup.getEnv('test')

  // Compute the balance for both wallets: identityKey and identityKey2
  for (const identityKey of [env.identityKey, env.identityKey2]) {
    // Create a setup context (which includes a wallet).
    // This wallet will be a client of the default cloud storage provider.
    const setup = await Setup.createWalletClient({
      env,
      rootKeyHex: env.devKeys[identityKey]
    })

    try {
      let balance = 0
      let offset = 0
      const seen = new Set<string>()
      for (;;) {
        const change = await setup.wallet.listOutputs({ basket: 'default', limit: 10, offset })
        if (
          !Number.isSafeInteger(change.totalOutputs) ||
          change.totalOutputs < 0 ||
          change.totalOutputs > MAX_BALANCE_OUTPUTS
        ) {
          throw new Error('Wallet reported an invalid or excessive output count')
        }
        for (const output of change.outputs) {
          assertSatoshis(output.satoshis)
          const { txid, vout } = sdk.Validation.parseWalletOutpoint(output.outpoint)
          const canonicalOutpoint = `${txid.toLowerCase()}.${vout}`
          if (seen.has(canonicalOutpoint)) {
            throw new Error('Wallet repeated an output across pages')
          }
          seen.add(canonicalOutpoint)
          const nextBalance = balance + output.satoshis
          assertSatoshis(nextBalance)
          balance = nextBalance
        }
        offset += change.outputs.length
        if (change.outputs.length === 0 || offset >= change.totalOutputs) break
      }

      console.log(`balance for ${identityKey} = ${balance}`)
    } finally {
      await setup.wallet.destroy()
    }
  }
}

/**
 * Special Operations (specOps) are extensions to the base BRC-100 Wallet
 * standard operations.
 *
 * This implementation of change balance computation uses `specOpWalletBalance`,
 * which is a special 'basket' value that modifies the default behavior of the
 * `listOutputs` method.
 *
 * In the case of `specOpWalletBalance`, it automatically selects all the
 * spendable, 'default' basket, change outputs and returns the sum of their
 * `satoshis` properties, returning the sum as the `totalOutputs` property.
 *
 * This is not only simpler to code, but more efficient as the outputs
 * do not need to be sent to the client. Only the sum of satoshis is returned.
 *
 * This function can be run from the command line as:
 *
 * ```bash
 * npx txs balances balanceSpecOp
 * ```
 */
export async function balanceSpecOp(): Promise<void> {
  const env = Setup.getEnv('test')
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey]
  })

  try {
    const r = await setup.wallet.listOutputs({ basket: specOpWalletBalance })
    const balance = r.totalOutputs
    assertSatoshis(balance)
    console.log(`balance for ${env.identityKey} = ${balance}`)
  } finally {
    await setup.wallet.destroy()
  }
}

/**
 * And if your BRC-100 wallet supports the `balance` extension method
 * based on specOpWalletBalance, this is the fastest and easiest way.
 *
 * This function can be run from the command line as:
 *
 * ```bash
 * npx txs balances walletBalance
 * ```
 */
export async function walletBalance(): Promise<void> {
  const env = Setup.getEnv('test')
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey]
  })

  try {
    const balance = await setup.wallet.balance()
    assertSatoshis(balance)
    console.log(`balance for ${env.identityKey} = ${balance}`)
  } finally {
    await setup.wallet.destroy()
  }
}

if (require.main === module) void runArgv2Function(module.exports)
