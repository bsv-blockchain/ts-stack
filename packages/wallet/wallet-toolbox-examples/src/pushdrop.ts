import {
  Beef,
  SignActionArgs,
  PushDrop,
  WalletProtocol,
  Byte,
  CreateActionOptions,
  WalletCounterparty,
  Transaction,
  PublicKey
} from '@bsv/sdk'
import { randomBytesBase64, Setup, SetupWallet, wait } from '@bsv/wallet-toolbox'
import {
  assertSameSignedTransaction,
  assertSatoshis,
  findRequestedInputIndex,
  findRequestedOutputIndex,
  snapshotCreateActionOptions,
  snapshotStringArray
} from './transactionSafety'

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

  try {
    const token: PushDropToken = await mintPushDropToken(setup, 42, args)
    await wait(5000)
    await redeemPushDropToken(setup, token)
  } finally {
    await setup.wallet.destroy()
  }
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
  ...[setup, satoshis, args, options, description, labels, outputDescription, tags]: [
    setup: SetupWallet,
    satoshis: number,
    args: PushDropArgs,
    options?: CreateActionOptions,
    description?: string,
    labels?: string[],
    outputDescription?: string,
    tags?: string[]
  ]
): Promise<PushDropToken> {
  assertSatoshis(satoshis)
  const safeArgs = snapshotPushDropArgs(args)
  const safeOptions = snapshotCreateActionOptions(
    options ?? { randomizeOutputs: false, acceptDelayedBroadcast: false }
  )
  const t = new PushDrop(setup.wallet)

  const lock = await t.lock(
    safeArgs.fields,
    safeArgs.protocolID,
    safeArgs.keyID,
    safeArgs.counterparty,
    safeArgs.counterparty === 'self',
    safeArgs.includeSignature,
    safeArgs.lockPosition
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
        outputDescription: outputDescription ?? label,
        tags: snapshotStringArray(tags ?? ['relinquish'], 'Output tags', 100, 300),
        // Include essential data required to redeem token output
        customInstructions: JSON.stringify({
          protocolID: safeArgs.protocolID,
          keyID: safeArgs.keyID,
          counterparty: safeArgs.counterparty,
          type: 'PushDrop'
        })
      }
    ],
    options: safeOptions,
    labels: snapshotStringArray(labels ?? [label], 'Action labels', 100, 300),
    description: description ?? label
  })

  // Both the "tx" and "txid" results are expected to be valid when an action is created that does not need explicit input signing,
  // and when the "signAndProcess" option is allowed to default to true.

  // The `Beef` class is used here to decode the AtomicBEEF binary format of the new transaction.
  if (car.tx == null || car.txid == null) throw new Error('Wallet did not return the minted token')
  const transaction = Transaction.fromAtomicBEEF(car.tx)
  if (car.txid.toLowerCase() !== transaction.id('hex')) {
    throw new Error('Wallet token transaction ID does not match its transaction')
  }
  const outputIndex = findRequestedOutputIndex(transaction, lockingScript, satoshis)
  const beef = Beef.fromBinary(transaction.toAtomicBEEF())
  const outpoint = `${transaction.id('hex')}.${outputIndex}`

  /**
   * The inclusion of the ASM decoded lockingScript, and the `PushDrop.decode` method
   * is a starting point for working with token data.
   */
  if (!options)
    console.log(`
PushDropArgs ${JSON.stringify(safeArgs)}
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
    args: safeArgs,
    beef,
    outpoint,
    fromIdentityKey: setup.identityKey,
    satoshis,
    noSendChange: car.noSendChange == null ? undefined : [...car.noSendChange]
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
  const safeToken = snapshotPushDropToken(token)
  const { args, fromIdentityKey, satoshis, beef: inputBeef, outpoint } = safeToken
  const safeOptions = snapshotCreateActionOptions(options ?? { acceptDelayedBroadcast: false })
  const safeLabels = snapshotStringArray(
    labels ?? ['redeemPushDropToken'],
    'Action labels',
    100,
    300
  )

  const t = new PushDrop(setup.wallet)

  const unlock = t.unlock(args.protocolID, args.keyID, fromIdentityKey, 'all', false, satoshis)

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
    labels: safeLabels,
    description: description ?? label,
    options: safeOptions
  })

  const st = car.signableTransaction
  if (st == null) throw new Error('Wallet did not return a signable PushDrop transaction')
  let signed: Transaction
  try {
    const tx = Transaction.fromAtomicBEEF(st.tx)
    const inputIndex = findRequestedInputIndex(tx, outpoint)
    tx.inputs[inputIndex].unlockingScriptTemplate = unlock
    await tx.sign()
    const unlockingScript = tx.inputs[inputIndex].unlockingScript
    if (unlockingScript == null) throw new Error('PushDrop signer produced no unlocking script')
    const signArgs: SignActionArgs = {
      reference: st.reference,
      spends: { [inputIndex]: { unlockingScript: unlockingScript.toHex() } },
      options: {
        acceptDelayedBroadcast: safeOptions.acceptDelayedBroadcast,
        returnTXIDOnly: false,
        noSend: safeOptions.noSend,
        sendWith: safeOptions.sendWith == null ? undefined : [...safeOptions.sendWith]
      }
    }
    const sar = await setup.wallet.signAction(signArgs)
    if (sar.tx == null) throw new Error('Wallet did not return the signed PushDrop transaction')
    signed = Transaction.fromAtomicBEEF(sar.tx)
    assertSameSignedTransaction(tx, signed)
  } catch (error) {
    try {
      await setup.wallet.abortAction({ reference: st.reference })
    } catch {
      // Preserve the signing failure rather than replacing it with cleanup failure.
    }
    throw error
  }

  {
    const beef = Beef.fromBinary(signed.toAtomicBEEF())

    if (!options)
      console.log(`
PushDrop redeemer's identityKey ${setup.identityKey}
BEEF
${beef.toHex()}
${beef.toLogString()}
`)
  }

  return {
    beef: Beef.fromBinary(signed.toAtomicBEEF()),
    noSendChange: car.noSendChange == null ? undefined : [...car.noSendChange]
  }
}

export function snapshotPushDropArgs(value: PushDropArgs): PushDropArgs {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PushDrop arguments must be a plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('PushDrop arguments must be a plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expected = new Set([
    'protocolID',
    'keyID',
    'includeSignature',
    'lockPosition',
    'counterparty',
    'fields'
  ])
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors]
    if (
      typeof key !== 'string' ||
      !expected.has(key) ||
      descriptor == null ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new Error('PushDrop arguments must contain exact own data properties')
    }
  }
  const read = (key: string): unknown => descriptors[key]?.value
  const protocol = read('protocolID')
  if (!Array.isArray(protocol) || protocol.length !== 2) {
    throw new Error('PushDrop protocolID is invalid')
  }
  const protocolDescriptors = Object.getOwnPropertyDescriptors(protocol)
  if (
    Reflect.ownKeys(protocolDescriptors).some(
      key => typeof key !== 'string' || !new Set(['0', '1', 'length']).has(key)
    )
  ) {
    throw new Error('PushDrop protocolID is invalid')
  }
  const securityLevel = protocolDescriptors['0']?.value
  const protocolName = protocolDescriptors['1']?.value
  if (
    !Number.isSafeInteger(securityLevel) ||
    (securityLevel as number) < 0 ||
    (securityLevel as number) > 2 ||
    typeof protocolName !== 'string' ||
    new TextEncoder().encode(protocolName).length < 5 ||
    new TextEncoder().encode(protocolName).length > 400
  ) {
    throw new Error('PushDrop protocolID is invalid')
  }
  const keyID = read('keyID')
  if (
    typeof keyID !== 'string' ||
    new TextEncoder().encode(keyID).length === 0 ||
    new TextEncoder().encode(keyID).length > 2_048
  ) {
    throw new Error('PushDrop keyID is invalid')
  }
  const counterparty = read('counterparty')
  if (counterparty !== 'self' && counterparty !== 'anyone') {
    if (typeof counterparty !== 'string') throw new Error('PushDrop counterparty is invalid')
    try {
      if (!/^(?:02|03)[0-9a-fA-F]{64}$/.test(counterparty)) throw new Error()
      if (
        PublicKey.fromString(counterparty).toString().toLowerCase() !== counterparty.toLowerCase()
      ) {
        throw new Error()
      }
    } catch {
      throw new Error('PushDrop counterparty is invalid')
    }
  }
  const includeSignature = read('includeSignature')
  if (typeof includeSignature !== 'boolean') throw new Error('PushDrop signature flag is invalid')
  const lockPosition = read('lockPosition')
  if (lockPosition !== 'before' && lockPosition !== 'after') {
    throw new Error('PushDrop lock position is invalid')
  }
  const fields = snapshotFields(read('fields'))
  return {
    protocolID: [securityLevel as 0 | 1 | 2, protocolName],
    keyID,
    includeSignature,
    lockPosition,
    counterparty,
    fields
  }
}

function snapshotFields(value: unknown): Byte[][] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error('PushDrop fields must be a bounded non-empty array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set(['length'])
  let aggregateBytes = 0
  const fields = Array.from({ length: value.length }, (_, fieldIndex) => {
    expectedKeys.add(String(fieldIndex))
    const fieldDescriptor = descriptors[String(fieldIndex)]
    const field = fieldDescriptor?.value
    if (
      fieldDescriptor == null ||
      !fieldDescriptor.enumerable ||
      !('value' in fieldDescriptor) ||
      !Array.isArray(field) ||
      field.length > 1_048_576
    ) {
      throw new Error('PushDrop fields must contain dense bounded byte arrays')
    }
    aggregateBytes += field.length
    if (aggregateBytes > 4_194_304) throw new Error('PushDrop fields exceed the byte limit')
    const byteDescriptors = Object.getOwnPropertyDescriptors(field)
    const expectedByteKeys = new Set(['length'])
    const bytes = Array.from({ length: field.length }, (_, byteIndex) => {
      expectedByteKeys.add(String(byteIndex))
      const byteDescriptor = byteDescriptors[String(byteIndex)]
      const byte = byteDescriptor?.value
      if (
        byteDescriptor == null ||
        !byteDescriptor.enumerable ||
        !('value' in byteDescriptor) ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255
      ) {
        throw new Error('PushDrop fields must contain dense bounded byte arrays')
      }
      return byte
    })
    for (const key of Reflect.ownKeys(byteDescriptors)) {
      if (typeof key !== 'string' || !expectedByteKeys.has(key)) {
        throw new Error('PushDrop fields must not contain extra properties')
      }
    }
    return bytes
  })
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expectedKeys.has(key)) {
      throw new Error('PushDrop fields must not contain extra properties')
    }
  }
  return fields
}

export function snapshotPushDropToken(value: PushDropToken): PushDropToken {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PushDrop token must be a plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('PushDrop token must be a plain data object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expected = new Set([
    'args',
    'beef',
    'outpoint',
    'fromIdentityKey',
    'satoshis',
    'noSendChange'
  ])
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      !expected.has(key) ||
      descriptor == null ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new Error('PushDrop token must contain exact own data properties')
    }
  }
  const read = (key: string): unknown => descriptors[key]?.value
  const beef = read('beef')
  if (!(beef instanceof Beef)) throw new Error('PushDrop token BEEF is invalid')
  const outpoint = read('outpoint')
  if (typeof outpoint !== 'string') throw new Error('PushDrop token outpoint is invalid')
  const outpointMatch = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(outpoint)
  if (outpointMatch == null) throw new Error('PushDrop token outpoint is invalid')
  const outputIndex = Number(outpointMatch[2])
  if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
    throw new Error('PushDrop token outpoint is invalid')
  }
  const txid = outpointMatch[1].toLowerCase()
  const fromIdentityKey = read('fromIdentityKey')
  if (typeof fromIdentityKey !== 'string') throw new Error('PushDrop token identity is invalid')
  try {
    if (!/^(?:02|03)[0-9a-f]{64}$/i.test(fromIdentityKey)) throw new Error()
    if (
      PublicKey.fromString(fromIdentityKey).toString().toLowerCase() !==
      fromIdentityKey.toLowerCase()
    ) {
      throw new Error()
    }
  } catch {
    throw new Error('PushDrop token identity is invalid')
  }
  const satoshis = read('satoshis')
  assertSatoshis(satoshis)
  const noSendChange = read('noSendChange')
  if (beef.atomicTxid?.toLowerCase() !== txid) {
    throw new Error('PushDrop token outpoint is not the Atomic BEEF subject')
  }
  const ownedBeef = Beef.fromBinary(beef.toBinaryAtomic(txid))
  const subject = ownedBeef.findTransactionForSigning(txid)
  if (subject?.outputs[outputIndex]?.satoshis !== satoshis) {
    throw new Error('PushDrop token amount does not match its BEEF output')
  }
  return {
    args: snapshotPushDropArgs(read('args') as PushDropArgs),
    beef: ownedBeef,
    outpoint: `${txid}.${outputIndex}`,
    fromIdentityKey: fromIdentityKey.toLowerCase(),
    satoshis,
    ...(noSendChange === undefined
      ? {}
      : { noSendChange: snapshotStringArray(noSendChange, 'No-send change', 1_000, 75) })
  }
}

if (require.main === module) {
  void mintAndRedeemPushDropToken().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
