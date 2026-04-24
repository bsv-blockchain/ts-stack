import {
  Beef,
  SignActionArgs,
  PushDrop,
  WalletProtocol,
  Byte,
  CreateActionOptions,
  WalletCounterparty
} from '@bsv/sdk'
import {
  randomBytesBase64,
  Setup,
  SetupWallet,
  wait
} from '@bsv/wallet-toolbox'

/**
 * @param {WalletProtocol} protocolID - The protocol ID to use.
 * @param {string} keyID - The key ID to use.
 * @param {boolean} [includeSignature] - Flag indicating if a signature should be included in the script.
 * @param {'before' | 'after'} lockPosition - Whether the OP_CHECKSIG comes after fields data or before.
 * @param {WalletCounterparty} counterparty - Who will be able to redeem (unlock) the token.
 * @param {number[][]} fields - The binary data to be stored in the token.
 */
export interface PushDropArgs {
  protocolID: WalletProtocol
  keyID: string
  includeSignature: boolean
  lockPosition: 'before' | 'after'
  counterparty: WalletCounterparty
  fields: Byte[][]
}

/**
 * @param {PushDropArgs} args - The token protocol definition and field values.
 * @param {Beef} beef - object proving the validity of the new output where the last transaction contains the new output.
 * @param {string} outpoint - The txid and index of the outpoint in the format `${txid}.${index}`. This is the token's on chain location.
 * @param {string} fromIdentityKey - The public key that locked the token.
 * @param {number} satoshis - The amount assigned to the output.
 * @param {string[]?} noSendChange - If options are used to create 'nosend' action, these change outpoints can be forwarded to following 'nosend' actions.
 */
export interface PushDropToken {
  args: PushDropArgs
  beef: Beef
  outpoint: string
  fromIdentityKey: string
  satoshis: number
  noSendChange?: string[]
}

/**
 * Example of created a data bearing token and redeeming it using the PushDrop script template.
 *
 * This example can be run by the following command:
 *
 * ```bash
 * npx tsx pushdrop
 * ```
 *
 * @publicbody
 */
export async function mintAndRedeemPushDropToken() {
  const env = Setup.getEnv('test')

  const setup = await Setup.createWalletClient({ env })

  /**
   * PushDrop tokens can encode arbitrary binary data.
   * Here we create two fields of three bytes each.
   * You can have any number of fields and use encoding to serialize arbitrary data into fields.
   * By encrypting the encoded field data, tokens can include secret data.
   */
  const fields: Byte[][] = [
    [1, 2, 3],
    [4, 5, 6]
  ]

  /**
   * The protocol and keyId define how keys are generated between token minters and redeemers.
   */
  const protocolID: WalletProtocol = [2, 'pushdropexample']
  const keyID: string = randomBytesBase64(8)

  const args: PushDropArgs = {
    protocolID,
    keyID,
    includeSignature: false,
    lockPosition: 'before',
    counterparty: 'self',
    fields
  }

  // create (mint) a new token
  const token: PushDropToken = await mintPushDropToken(setup, 42, args)

  // Temprorary accomodation for lack of solid `postBeef` support among transaction processors.
  await wait(5000)

  // use setup2 to redeem the token, returning the associated satoshis to new "change" output(s).
  await redeemPushDropToken(setup, token)
}

/**
 * Mint a new PushDrop token.
 *
 * @param {SetupWallet} setup - The setup context which will create the new transaction containing the new PushDrop output.
 * @param {number} satoshis - How many satoshis to transfer to this new output.
 * @param {PushDropArgs} args - Defines the token encoding, signature, key derivation, field data.
 * @param {CreateActionOptions?} options - Optional. Default options disable output randomization and disable allowing delayed broadcast.
 *
 * @returns {PushDropToken} Information relating to the newly minted token.
 *
 * @publicbody
 */
export async function mintPushDropToken(
  setup: SetupWallet,
  satoshis: number,
  args: PushDropArgs,
  options?: CreateActionOptions,
  description?: string,
  labels?: string[],
  outputDescription?: string,
  tags?: string[]
): Promise<PushDropToken> {
  const t = new PushDrop(setup.wallet)

  const lock = await t.lock(
    args.fields,
    args.protocolID,
    args.keyID,
    args.counterparty,
    args.counterparty === 'self',
    args.includeSignature,
    args.lockPosition
  )
  const lockingScript = lock.toHex()

  // Use this label the new transaction can be found by `listActions` and as a "description" value.
  const label = 'mintPushDropToken'

  // This call to `createAction` will create a new funded transaction containing the new token,
  // as well as sign and broadcast the transaction to the network.
  const car = await setup.wallet.createAction({
    outputs: [
      // Explicitly specify the new token output to be created.
      {
        lockingScript,
        satoshis,
        outputDescription: outputDescription || label,
        tags: tags || ['relinquish'],
        // Include essential data required to redeem token output
        customInstructions: JSON.stringify({
          protocolID: args.protocolID,
          keyID: args.keyID,
          counterparty: args.counterparty,
          type: 'PushDrop'
        })
      }
    ],
    options: options || {
      // Turn off automatic output order randomization to avoid having to figure out which output is the explicit one.
      // It will always be output zero.
      randomizeOutputs: false,
      // This example prefers to immediately wait for the new transaction to be broadcast to the network.
      // Typically, most production applications benefit from performance gains when broadcasts are handled in the background.
      acceptDelayedBroadcast: false
    },
    labels: labels || [label],
    description: description || label
  })

  // Both the "tx" and "txid" results are expected to be valid when an action is created that does not need explicit input signing,
  // and when the "signAndProcess" option is allowed to default to true.

  // The `Beef` class is used here to decode the AtomicBEEF binary format of the new transaction.
  const beef = Beef.fromBinary(car.tx!)
  // The outpoint string is constructed from the new transaction's txid and the output index: zero.
  const outpoint = `${car.txid!}.0`

  /**
   * The inclusion of the ASM decoded lockingScript, and the `PushDrop.decode` method
   * is a starting point for working with token data.
   */
  if (!options)
    console.log(`
PushDropArgs ${JSON.stringify(args)}
PushDrop token minter's identityKey ${setup.identityKey}
token outpoint ${outpoint}
token decoded ${JSON.stringify(PushDrop.decode(lock))}
satoshis ${satoshis}
BEEF
${beef.toHex()}
${beef.toLogString()}
`)

  // Return the bits and pieces of the new output created.
  return {
    args,
    beef,
    outpoint,
    fromIdentityKey: setup.identityKey,
    satoshis,
    noSendChange: car.noSendChange
  }
}

/**
 * Redeem a PushDrop token.
 *
 * To redeem a PushDrop token a transaction input must be created and signed using the
 * associated private key.
 *
 * See the brc29.ts example for more information on using signAction.
 *
 * @param {SetupWallet} setup The setup context which will redeem a PushDrop token as an input to a new transaction transfering
 * the token's satoshis to the "change" managed by `setup.wallet`.
 * @param {PushDropToken} token - The minted token to redeem.
 * @param options Optional. Default options disable output randomization and disable allowing delayed broadcast.
 *
 * @publicbody
 */
export async function redeemPushDropToken(
  setup: SetupWallet,
  token: PushDropToken,
  options?: CreateActionOptions,
  description?: string,
  labels?: string[],
  inputDescription?: string
): Promise<{
  beef: Beef
  noSendChange?: string[]
}> {
  const { args, fromIdentityKey, satoshis, beef: inputBeef, outpoint } = token

  const { keyDeriver } = setup

  const t = new PushDrop(setup.wallet)

  const unlock = t.unlock(
    args.protocolID,
    args.keyID,
    fromIdentityKey,
    'all',
    false,
    satoshis
  )

  const label = 'redeemPushDropToken'

  const car = await setup.wallet.createAction({
    inputBEEF: inputBeef.toBinary(),
    inputs: [
      {
        outpoint,
        unlockingScriptLength: 73,
        inputDescription: inputDescription || label
      }
    ],
    labels: labels || [label],
    description: description || label,
    options: options
  })

  const st = car.signableTransaction!
  const beef = Beef.fromBinary(st.tx)
  const tx = beef.findAtomicTransaction(beef.txs.slice(-1)[0].txid)!
  tx.inputs[0].unlockingScriptTemplate = unlock
  await tx.sign()
  const unlockingScript = tx.inputs[0].unlockingScript!.toHex()

  const signArgs: SignActionArgs = {
    reference: st.reference,
    spends: { 0: { unlockingScript } },
    options: options || {
      acceptDelayedBroadcast: false
    }
  }

  const sar = await setup.wallet.signAction(signArgs)

  {
    const beef = Beef.fromBinary(sar.tx!)
    const txid = sar.txid!

    if (!options)
      console.log(`
PushDrop redeemer's identityKey ${setup.identityKey}
BEEF
${beef.toHex()}
${beef.toLogString()}
`)
  }

  return {
    beef,
    noSendChange: car.noSendChange
  }
}

mintAndRedeemPushDropToken().catch(console.error)
