import { Beef, PrivateKey, PublicKey, SignActionArgs } from '@bsv/sdk'
import {
  randomBytesBase64,
  ScriptTemplateBRC29,
  Setup,
  SetupWallet
} from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'

/**
 * Example of moving satoshis from one wallet to another using the BRC29 script template.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx brc29
 * ```
 *
 * Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
 * two wallets.
 *
 * @publicbody
 */
export async function brc29() {
  // obtain the secrets environment for the testnet network.
  const env = Setup.getEnv('test')
  // setup1 will be the sending wallet using the rootKey associated with identityKey, which is the default.
  const setup1 = await Setup.createWalletClient({ env })
  // setup2 will be the receiving wallet using the rootKey associated with identityKey2
  const setup2 = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[env.identityKey2]
  })

  // create a new transaction with an output for setup2 in the amount of 42000 satoshis.
  const o = await outputBRC29(setup1, setup2.identityKey, 42000)

  // use setup2 to consume the new output to demonstrate unlocking the output and adding it to the wallet's "change" outputs.
  await inputBRC29(setup2, o)
}

/**
 * Create a new BRC29 output.
 *
 * Convert the destination identity key into its associated address and use that to generate a locking script.
 *
 * Explicitly specify the new output to be created as part of a new action (transaction).
 *
 * When outputs are explictly added to an action they must be funded:
 * Typically, at least one "change" input will be automatically added to fund the transaction,
 * and at least one output will be added to recapture excess funding.
 *
 * @param {SetupWallet} setup The setup context which will create the new transaction containing the new BRC29 output.
 * @param {string} toIdentityKey The public key which will be able to unlock the output.
 * Note that the output uses the "address" associated with this public key: The HASH160 of the public key.
 * @param {number} satoshis How many satoshis to transfer to this new output.
 * @returns {Object} An object is returned with the following properties:
 * @returns {Beef} beef - object proving the validity of the new output where the last transaction contains the new output.
 * @returns {string} outpoint - The txid and index of the outpoint in the format `${txid}.${index}`.
 * @returns {string} fromIdentityKey - The public key that locked the output.
 * @returns {number} satoshis - The amount assigned to the output.
 * @returns {string} derivationPrefix - The BRC29 prefix string.
 * @returns {string} derivationSuffix - The BRC29 suffix string.
 *
 * @publicbody
 */
export async function outputBRC29(
  setup: SetupWallet,
  toIdentityKey: string,
  satoshis: number
): Promise<{
  beef: Beef
  outpoint: string
  fromIdentityKey: string
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
}> {
  const derivationPrefix = randomBytesBase64(8)
  const derivationSuffix = randomBytesBase64(8)
  const { keyDeriver } = setup

  const t = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver
  })

  // Use this label the new transaction can be found by `listActions` and as a "description" value.
  const label = 'outputBRC29'

  // This call to `createAction` will create a new funded transaction containing the new output,
  // as well as sign and broadcast the transaction to the network.
  const car = await setup.wallet.createAction({
    outputs: [
      // Explicitly specify the new output to be created.
      // When outputs are explictly added to an action they must be funded:
      // Typically, at least one "change" input will automatically be added to fund the transaction,
      // and at least one output will be added to recapture excess funding.
      {
        lockingScript: t.lock(setup.rootKey.toString(), toIdentityKey).toHex(),
        satoshis,
        outputDescription: label,
        tags: ['relinquish'],
        customInstructions: JSON.stringify({
          derivationPrefix,
          derivationSuffix,
          type: 'BRC29'
        })
      }
    ],
    options: {
      // Turn off automatic output order randomization to avoid having to figure out which output is the explicit one.
      // It will always be output zero.
      randomizeOutputs: false,
      // This example prefers to immediately wait for the new transaction to be broadcast to the network.
      // Typically, most production applications benefit from performance gains when broadcasts are handled in the background.
      acceptDelayedBroadcast: false
    },
    labels: [label],
    description: label
  })

  // Both the "tx" and "txid" results are expected to be valid when an action is created that does not need explicit input signing,
  // and when the "signAndProcess" option is allowed to default to true.

  // The `Beef` class is used here to decode the AtomicBEEF binary format of the new transaction.
  const beef = Beef.fromBinary(car.tx!)
  // The outpoint string is constructed from the new transaction's txid and the output index: zero.
  const outpoint = `${car.txid!}.0`

  console.log(`
outputBRC29
fromIdentityKey ${setup.identityKey}
toIdentityKey ${toIdentityKey}
derivationPrefix ${derivationPrefix}
derivationSuffix ${derivationSuffix}
outpoint ${outpoint}
satoshis ${satoshis}
BEEF
${beef.toHex()}
${beef.toLogString()}
`)

  // Return the bits and pieces of the new output created.
  return {
    beef,
    outpoint,
    fromIdentityKey: setup.identityKey,
    satoshis,
    derivationPrefix,
    derivationSuffix
  }
}

/**
 * Consume a BRC29 output.
 *
 * To spend a BRC29 output a transaction input must be created and signed using the
 * associated private key.
 *
 * In this example, an initial `createAction` call constructs the overall shape of a
 * new transaction, returning a `signableTransaction`.
 *
 * The `tx` property of the `signableTransaction` should be parsed using
 * the standard `Beef` class. Note that it is not an ordinary AtomicBEEF for the
 * simple reason that the transaction has not yet been fully signed.
 *
 * You can either use the method shown here to obtain a signable `Transaction` object
 * from this beef or you can use the `Transaction.fromAtomicBEEF` method.
 *
 * To sign an input, set the corresponding input's `unlockingScriptTemplate` to an appropriately
 * initialized unlock object and call the `Transaction` `sign` method.
 *
 * Once signed, capture the input's now valid `unlockingScript` value and convert it to a hex string.
 *
 * @param {SetupWallet} setup The setup context which will consume a BRC29 output as an input to a new transaction transfering
 * the output's satoshis to the "change" managed by the context's wallet.
 * @param {Beef} outputBRC29.beef - An object proving the validity of the new output where the last transaction contains the new output.
 * @param {string} outputBRC29.outpoint - The txid and index of the outpoint in the format `${txid}.${index}`.
 * @param {string} outputBRC29.fromIdentityKey - The public key that locked the output.
 * @param {number} outputBRC29.satoshis - The amount assigned to the output.
 *
 * @publicbody
 */
export async function inputBRC29(
  setup: SetupWallet,
  outputBRC29: {
    beef: Beef
    outpoint: string
    fromIdentityKey: string
    satoshis: number
    derivationPrefix: string
    derivationSuffix: string
  }
) {
  const {
    derivationPrefix,
    derivationSuffix,
    fromIdentityKey,
    satoshis,
    beef: inputBeef,
    outpoint
  } = outputBRC29

  const { keyDeriver } = setup

  const t = new ScriptTemplateBRC29({
    derivationPrefix,
    derivationSuffix,
    keyDeriver
  })

  // Construct an "unlock" object which is then associated with the input to be signed
  // such that when the "sign" method is called, a signed "unlockingScript" is computed for that input.
  const unlock = t.unlock(setup.rootKey.toString(), fromIdentityKey, satoshis)

  const label = 'inputBRC29'

  /**
   * Creating an action with an input that requires it's own signing template is a two step process.
   * The call to createAction must include only the expected maximum script length of the unlockingScript.
   * This causes a "signableTransaction" to be returned instead of a completed "txid" and "tx".
   */
  const car = await setup.wallet.createAction({
    /**
     * An inputBEEF is always required when there are explicit inputs to the new action.
     * This beef must include each transaction with a corresponding outpoint txid.
     * Unlike an AtomicBEEF, inputBEEF validates the transactions containing the outpoints,
     * and may contain multiple unrelated transaction subtrees.
     */
    inputBEEF: inputBeef.toBinary(),
    inputs: [
      {
        outpoint,
        // The value of 108 is a constant for the BRC29 template.
        // You could use the `unlock.estimateLength` method to obtain it.
        // Or a quick look at the P2PKH source code to confirm it.
        unlockingScriptLength: t.unlockLength,
        inputDescription: label
      }
    ],
    labels: [label],
    description: label
  })

  /**
   * Here is the essense of using `signAction` and custom script template:
   *
   * The `tx` property of the `signableTransaction` result can be parsed using
   * the standard `Beef` class, but it is not an ordinary valid AtomicBEEF for the
   * simple reason that the transaction has not been fully signed.
   *
   * You can either use the method shown here to obtain a signable `Transaction` object
   * from this beef or you can use the `Transaction.fromAtomicBEEF` method.
   *
   * To sign an input, set the corresponding input's `unlockingScriptTemplate` to an appropriately
   * initialized unlock object and call the `Transaction` `sign` method.
   *
   * Once signed, capture the now valid `unlockingScript` valoue for the input and convert it to a hex string.
   */
  const st = car.signableTransaction!
  const beef = Beef.fromBinary(st.tx)
  const tx = beef.findAtomicTransaction(beef.txs.slice(-1)[0].txid)!
  tx.inputs[0].unlockingScriptTemplate = unlock
  await tx.sign()
  const unlockingScript = tx.inputs[0].unlockingScript!.toHex()

  /**
   * Note that the `signArgs` use the `reference` property of the `signableTransaction` result to
   * identify the `createAction` result to finish processing and optionally broadcasting.
   */
  const signArgs: SignActionArgs = {
    reference: st.reference,
    spends: { 0: { unlockingScript } },
    options: {
      // Force an immediate broadcast of the signed transaction.
      acceptDelayedBroadcast: false
    }
  }

  /**
   * Calling `signAction` completes the action creation process when inputs must be signed
   * using specific script templates.
   */
  const sar = await setup.wallet.signAction(signArgs)

  // This completes the example by logging evidence of what was created.
  {
    const beef = Beef.fromBinary(sar.tx!)
    const txid = sar.txid!

    console.log(`
inputP2PKH to ${setup.identityKey}
input's outpoint ${outpoint}
satoshis ${satoshis}
txid ${txid}
BEEF
${beef.toHex()}
${beef.toLogString()}
`)
  }
}

runArgv2Function(module.exports)
