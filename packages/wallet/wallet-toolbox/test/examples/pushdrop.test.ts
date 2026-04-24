import { Beef, PushDrop, SignActionArgs, WalletProtocol } from '@bsv/sdk'
import { Setup, SetupWallet } from '../../src'
import { logger } from '../utils/TestUtilsWalletStorage'

describe('pushdrop example tests', () => {
  jest.setTimeout(99999999)

  test('0 pushdrop', async () => {
    if (Setup.noEnv('main')) return
    await transferPushDrop()
  })
})

/**
 * Example of moving satoshis from one wallet to another using the BRC29 script template.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx brc29.ts
 * ```
 *
 * Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
 * two wallets.
 *
 * @publicbody
 */
export async function transferPushDrop() {
  // obtain the secrets environment for the testnet network.
  const env = Setup.getEnv('main')
  // setup1 will be the sending wallet using the rootKey associated with identityKey, which is the default.
  const setup1 = await Setup.createWalletClient({ env })

  // setup2 will be the receiving wallet using the rootKey associated with identityKey2
  const setup2 = setup1

  // create a new transaction with an output for setup2 in the amount of 42 satoshis.
  const o = await outputPushDrop(setup1, setup2.identityKey, 42)

  // use setup2 to consume the new output to demonstrate unlocking the output and adding it to the wallet's "change" outputs.
  await inputPushDrop(setup2, o)

  await setup1.wallet.destroy()
  await setup2.wallet.destroy()
}

async function outputPushDrop(
  setup: SetupWallet,
  toIdentityKey: string,
  satoshis: number
): Promise<{
  beef: Beef
  outpoint: string
  fromIdentityKey: string
  satoshis: number
  protocol: WalletProtocol
  keyId: string
}> {
  const t = new PushDrop(setup.wallet)

  const protocol: WalletProtocol = [2, 'pushdropexample']
  const keyId: string = '7'

  const lock = await t.lock(
    [
      [1, 2, 3],
      [4, 5, 6]
    ],
    protocol,
    keyId,
    toIdentityKey,
    false,
    true,
    'before'
  )
  const lockingScript = lock.toHex()

  // Use this label the new transaction can be found by `listActions` and as a "description" value.
  const label = 'outputPushDrop'

  // This call to `createAction` will create a new funded transaction containing the new output,
  // as well as sign and broadcast the transaction to the network.
  const car = await setup.wallet.createAction({
    outputs: [
      // Explicitly specify the new output to be created.
      // When outputs are explictly added to an action they must be funded:
      // Typically, at least one "change" input will automatically be added to fund the transaction,
      // and at least one output will be added to recapture excess funding.
      {
        lockingScript,
        satoshis,
        outputDescription: label,
        tags: ['relinquish'],
        customInstructions: JSON.stringify({
          protocol,
          keyId,
          counterparty: toIdentityKey,
          type: 'PushDrop'
        })
      }
    ],
    options: {
      // Turn off automatic output order randomization to avoid having to figure out which output is the explicit one.
      // It will always be output zero.
      randomizeOutputs: false,
      // This example prefers to immediately wait for the new transaction to be broadcast to the network.
      // Typically, most production applications benefit from performance gains when broadcasts are handled in the background.
      acceptDelayedBroadcast: true
    },
    labels: [label],
    description: label
  })
  if (car.sendWithResults!.some(r => r.status === 'failed'))
    throw new Error('failed to send output creating transaction')

  // Both the "tx" and "txid" results are expected to be valid when an action is created that does not need explicit input signing,
  // and when the "signAndProcess" option is allowed to default to true.

  // The `Beef` class is used here to decode the AtomicBEEF binary format of the new transaction.
  const beef = Beef.fromBinary(car.tx!)
  // The outpoint string is constructed from the new transaction's txid and the output index: zero.
  const outpoint = `${car.txid!}.0`

  logger(`
outputPushDrop to ${toIdentityKey}
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
    protocol,
    keyId
  }
}

/**
 * Consume a PushDrop output.
 *
 * To spend a PushDrop output a transaction input must be created and signed using the
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
 * @param {SetupWallet} setup The setup context which will consume a PushDrop output as an input to a new transaction transfering
 * the output's satoshis to the "change" managed by the context's wallet.
 * @param {Beef} outputPushDrop.beef - An object proving the validity of the new output where the last transaction contains the new output.
 * @param {string} outputPushDrop.outpoint - The txid and index of the outpoint in the format `${txid}.${index}`.
 * @param {string} outputPushDrop.fromIdentityKey - The public key that locked the output.
 * @param {number} outputPushDrop.satoshis - The amount assigned to the output.
 *
 * @publicbody
 */
export async function inputPushDrop(
  setup: SetupWallet,
  outputPushDrop: {
    beef: Beef
    outpoint: string
    fromIdentityKey: string
    satoshis: number
    protocol: WalletProtocol
    keyId: string
  }
) {
  const { protocol, keyId, fromIdentityKey, satoshis, beef: inputBeef, outpoint } = outputPushDrop

  const { keyDeriver } = setup

  const t = new PushDrop(setup.wallet)

  // Construct an "unlock" object which is then associated with the input to be signed
  // such that when the "sign" method is called, a signed "unlockingScript" is computed for that input.
  const unlock = t.unlock(protocol, keyId, fromIdentityKey, 'single', false, satoshis)

  const label = 'inputPushDrop'

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
        // The value of 73 is a constant for the PushDrop template.
        // You could use the `unlock.estimateLength` method to obtain it.
        // Or a quick look at the PushDrop source code to confirm it.
        unlockingScriptLength: 73,
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
      acceptDelayedBroadcast: true
    }
  }

  /**
   * Calling `signAction` completes the action creation process when inputs must be signed
   * using specific script templates.
   */
  const sar = await setup.wallet.signAction(signArgs)
  if (sar.sendWithResults!.some(r => r.status === 'failed'))
    throw new Error('failed to send output creating transaction')

  // This completes the example by logging evidence of what was created.
  {
    const beef = Beef.fromBinary(sar.tx!)
    const txid = sar.txid!

    logger(`
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
