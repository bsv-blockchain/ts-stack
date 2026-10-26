import { sdk, Setup } from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'
import { ar } from './listChange'

/**
 * Uses a special operation mode of the listOutputs function to list all the invalid change outputs.
 *
 * Note that if any un-spendable outputs are found, they can be "released" by running the `release` function.
 *
 * @param identityKey A wallet identity key value with a valid mapping to a private key in the .env file.
 * @param chain The chain to use, either 'main' or 'test'.
 *
 * @publicbody
 */
export async function janitorOnIdentity(identityKey: string, chain: sdk.Chain): Promise<void> {
  const env = Setup.getEnv(chain)
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })

  try {
    const change = await setup.wallet.listOutputs({ basket: sdk.specOpInvalidChange })

    console.log(`

Janitor list invalid change outputs for:
.env ${env.chain} ${identityKey} ${setup.storage.getActiveStoreName()}
`)
    if (change.totalOutputs === 0) {
      console.log('no invalid change outputs found.')
    } else {
      if (!setup.storage.isActiveEnabled) {
        console.log(
          'ACTIVE STORAGE IS NOT ENABLED! Wallet is not configured with currently active storage provider!'
        )
      }

      console.log('  satoshis |  vout | txid')
      console.log('-----------|-------|--------------------------------------------')
      for (const o of change.outputs) {
        const { txid, vout } = sdk.Validation.parseWalletOutpoint(o.outpoint)
        console.log(`${ar(o.satoshis, 10)} | ${ar(vout, 5)} | ${txid}`)
      }
    }
  } finally {
    await setup.wallet.destroy()
  }
}

/**
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor
 * ```
 *
 * @publicbody
 */
export async function janitor(): Promise<void> {
  for (const env of [Setup.getEnv('test'), Setup.getEnv('main')]) {
    for (const identityKey of [env.identityKey, env.identityKey2]) {
      if (!identityKey) continue
      await janitorOnIdentity(identityKey, env.chain)
    }
  }
}

export async function releaseOnIdentity(identityKey: string, chain: sdk.Chain): Promise<void> {
  const env = Setup.getEnv(chain)
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })

  try {
    await setup.wallet.listOutputs({
      basket: sdk.specOpInvalidChange,
      tags: ['release']
    })
    console.log(`

Janitor invalid change outputs released for:
.env ${env.chain} ${identityKey} ${setup.storage.getActiveStoreName()}

`)
  } finally {
    await setup.wallet.destroy()
  }
}

/**
 * Releases all invalid change outputs for wallets in the .env file:
 * 'identityKey' and 'identityKey2' values for both 'test' and 'main' chains.
 * This mutates live wallet state on both networks. Run `janitor` first and prefer
 * a chain- and identity-specific release function whenever possible.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor release
 * ```
 * @publicbody
 */
export async function release(): Promise<void> {
  for (const env of [Setup.getEnv('test'), Setup.getEnv('main')]) {
    for (const identityKey of [env.identityKey, env.identityKey2]) {
      if (!identityKey) continue
      await releaseOnIdentity(identityKey, env.chain)
    }
  }
}

/**
 * Releases all invalid change outputs for the .env 'main', 'identityKey' wallet.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor releaseMain1
 * ```
 * @publicbody
 */
export async function releaseMain1(): Promise<void> {
  const env = Setup.getEnv('main')
  await releaseOnIdentity(env.identityKey, env.chain)
}

/**
 * Releases all invalid change outputs for the .env 'main', 'identityKey2' wallet.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor releaseMain2
 * ```
 * @publicbody
 */
export async function releaseMain2(): Promise<void> {
  const env = Setup.getEnv('main')
  await releaseOnIdentity(env.identityKey2, env.chain)
}

/**
 * Releases all invalid change outputs for the .env 'test', 'identityKey' wallet.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor releaseTest1
 * ```
 * @publicbody
 */
export async function releaseTest1(): Promise<void> {
  const env = Setup.getEnv('test')
  await releaseOnIdentity(env.identityKey, env.chain)
}

/**
 * Releases all invalid change outputs for the .env 'test', 'identityKey2' wallet.
 *
 * Run this function using the following command:
 *
 * ```bash
 * npx tsx janitor releaseTest2
 * ```
 * @publicbody
 */
export async function releaseTest2(): Promise<void> {
  const env = Setup.getEnv('test')
  await releaseOnIdentity(env.identityKey2, env.chain)
}

if (require.main === module) void runArgv2Function(module.exports)
