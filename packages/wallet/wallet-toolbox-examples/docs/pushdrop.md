# PushDrop Example: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the PushDrop script template example
of the `@bsv/wallet-toolbox-examples` package; which accompanies the `@bsv/wallet-toolbox`.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->

### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

|                                           |
| ----------------------------------------- |
| [PushDropArgs](#interface-pushdropargs)   |
| [PushDropToken](#interface-pushdroptoken) |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Interface: PushDropArgs

```ts
export interface PushDropArgs {
  protocolID: WalletProtocol
  keyID: string
  includeSignature: boolean
  lockPosition: 'before' | 'after'
  counterparty: WalletCounterparty
  fields: Byte[][]
}
```

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Interface: PushDropToken

```ts
export interface PushDropToken {
  args: PushDropArgs
  beef: Beef
  outpoint: string
  fromIdentityKey: string
  satoshis: number
  noSendChange?: string[]
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

#### Functions

|                                                                    |
| ------------------------------------------------------------------ |
| [mintAndRedeemPushDropToken](#function-mintandredeempushdroptoken) |
| [mintPushDropToken](#function-mintpushdroptoken)                   |
| [redeemPushDropToken](#function-redeempushdroptoken)               |
| [snapshotPushDropArgs](#function-snapshotpushdropargs)             |
| [snapshotPushDropToken](#function-snapshotpushdroptoken)           |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: mintAndRedeemPushDropToken

Example of created a data bearing token and redeeming it using the PushDrop script template.

This example can be run by the following command:

```bash
npx tsx pushdrop
```

```ts
export async function mintAndRedeemPushDropToken() {
  const env = Setup.getEnv('test')
  const setup = await Setup.createWalletClient({ env })
  const fields: Byte[][] = [
    [1, 2, 3],
    [4, 5, 6]
  ]
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
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [PushDropToken](./pushdrop.md#interface-pushdroptoken), [mintPushDropToken](./pushdrop.md#function-mintpushdroptoken), [redeemPushDropToken](./pushdrop.md#function-redeempushdroptoken)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: mintPushDropToken

Mint a new PushDrop token.

```ts
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
  const label = 'mintPushDropToken'
  const car = await setup.wallet.createAction({
    outputs: [
      {
        lockingScript,
        satoshis,
        outputDescription: outputDescription ?? label,
        tags: snapshotStringArray(tags ?? ['relinquish'], 'Output tags', 100, 300),
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
  if (car.tx == null || car.txid == null) throw new Error('Wallet did not return the minted token')
  const transaction = Transaction.fromAtomicBEEF(car.tx)
  if (car.txid.toLowerCase() !== transaction.id('hex')) {
    throw new Error('Wallet token transaction ID does not match its transaction')
  }
  const outputIndex = findRequestedOutputIndex(transaction, lockingScript, satoshis)
  const beef = Beef.fromBinary(transaction.toAtomicBEEF())
  const outpoint = `${transaction.id('hex')}.${outputIndex}`
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
  return {
    args: safeArgs,
    beef,
    outpoint,
    fromIdentityKey: setup.identityKey,
    satoshis,
    noSendChange: car.noSendChange == null ? undefined : [...car.noSendChange]
  }
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [PushDropToken](./pushdrop.md#interface-pushdroptoken), [assertSatoshis](./README.md#function-assertsatoshis), [findRequestedOutputIndex](./README.md#function-findrequestedoutputindex), [snapshotCreateActionOptions](./README.md#function-snapshotcreateactionoptions), [snapshotPushDropArgs](./pushdrop.md#function-snapshotpushdropargs), [snapshotStringArray](./README.md#function-snapshotstringarray)

Returns

Information relating to the newly minted token.

Argument Details

- **setup**
  - The setup context which will create the new transaction containing the new PushDrop output.
- **satoshis**
  - How many satoshis to transfer to this new output.
- **args**
  - Defines the token encoding, signature, key derivation, field data.
- **options**
  - Optional. Default options disable output randomization and disable allowing delayed broadcast.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: redeemPushDropToken

Redeem a PushDrop token.

To redeem a PushDrop token a transaction input must be created and signed using the
associated private key.

See the brc29.ts example for more information on using signAction.

```ts
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
    } catch {}
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
```

See also: [PushDropToken](./pushdrop.md#interface-pushdroptoken), [assertSameSignedTransaction](./README.md#function-assertsamesignedtransaction), [findRequestedInputIndex](./README.md#function-findrequestedinputindex), [sendWith](./nosend.md#function-sendwith), [snapshotCreateActionOptions](./README.md#function-snapshotcreateactionoptions), [snapshotPushDropToken](./pushdrop.md#function-snapshotpushdroptoken), [snapshotStringArray](./README.md#function-snapshotstringarray)

Argument Details

- **setup**
  - The setup context which will redeem a PushDrop token as an input to a new transaction transfering
    the token's satoshis to the "change" managed by `setup.wallet`.
- **token**
  - The minted token to redeem.
- **options**
  - Optional. Default options disable output randomization and disable allowing delayed broadcast.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: snapshotPushDropArgs

```ts
export function snapshotPushDropArgs(value: PushDropArgs): PushDropArgs
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: snapshotPushDropToken

```ts
export function snapshotPushDropToken(value: PushDropToken): PushDropToken
```

See also: [PushDropToken](./pushdrop.md#interface-pushdroptoken)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->
