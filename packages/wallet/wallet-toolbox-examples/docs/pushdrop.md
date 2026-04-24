# PushDrop Example: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the PushDrop script template example
of the `@bsv/wallet-toolbox-examples` package; which accompanies the `@bsv/wallet-toolbox`.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

| |
| --- |
| [PushDropArgs](#interface-pushdropargs) |
| [PushDropToken](#interface-pushdroptoken) |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Interface: PushDropArgs

```ts
export interface PushDropArgs {
    protocolID: WalletProtocol;
    keyID: string;
    includeSignature: boolean;
    lockPosition: "before" | "after";
    counterparty: WalletCounterparty;
    fields: Byte[][];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Interface: PushDropToken

```ts
export interface PushDropToken {
    args: PushDropArgs;
    beef: Beef;
    outpoint: string;
    fromIdentityKey: string;
    satoshis: number;
    noSendChange?: string[];
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
#### Functions

| |
| --- |
| [mintAndRedeemPushDropToken](#function-mintandredeempushdroptoken) |
| [mintPushDropToken](#function-mintpushdroptoken) |
| [redeemPushDropToken](#function-redeempushdroptoken) |

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
    const env = Setup.getEnv("test");
    const setup = await Setup.createWalletClient({ env });
    const fields: Byte[][] = [
        [1, 2, 3],
        [4, 5, 6]
    ];
    const protocolID: WalletProtocol = [2, "pushdropexample"];
    const keyID: string = randomBytesBase64(8);
    const args: PushDropArgs = {
        protocolID,
        keyID,
        includeSignature: false,
        lockPosition: "before",
        counterparty: "self",
        fields
    };
    const token: PushDropToken = await mintPushDropToken(setup, 42, args);
    await wait(5000);
    await redeemPushDropToken(setup, token);
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [PushDropToken](./pushdrop.md#interface-pushdroptoken), [mintPushDropToken](./pushdrop.md#function-mintpushdroptoken), [redeemPushDropToken](./pushdrop.md#function-redeempushdroptoken)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: mintPushDropToken

Mint a new PushDrop token.

```ts
export async function mintPushDropToken(setup: SetupWallet, satoshis: number, args: PushDropArgs, options?: CreateActionOptions, description?: string, labels?: string[], outputDescription?: string, tags?: string[]): Promise<PushDropToken> {
    const t = new PushDrop(setup.wallet);
    const lock = await t.lock(args.fields, args.protocolID, args.keyID, args.counterparty, args.counterparty === "self", args.includeSignature, args.lockPosition);
    const lockingScript = lock.toHex();
    const label = "mintPushDropToken";
    const car = await setup.wallet.createAction({
        outputs: [
            {
                lockingScript,
                satoshis,
                outputDescription: outputDescription || label,
                tags: tags || ["relinquish"],
                customInstructions: JSON.stringify({
                    protocolID: args.protocolID,
                    keyID: args.keyID,
                    counterparty: args.counterparty,
                    type: "PushDrop"
                })
            }
        ],
        options: options || {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
        },
        labels: labels || [label],
        description: description || label
    });
    const beef = Beef.fromBinary(car.tx!);
    const outpoint = `${car.txid!}.0`;
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
`);
    return {
        args,
        beef,
        outpoint,
        fromIdentityKey: setup.identityKey,
        satoshis,
        noSendChange: car.noSendChange
    };
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [PushDropToken](./pushdrop.md#interface-pushdroptoken)

Returns

Information relating to the newly minted token.

Argument Details

+ **setup**
  + The setup context which will create the new transaction containing the new PushDrop output.
+ **satoshis**
  + How many satoshis to transfer to this new output.
+ **args**
  + Defines the token encoding, signature, key derivation, field data.
+ **options**
  + Optional. Default options disable output randomization and disable allowing delayed broadcast.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: redeemPushDropToken

Redeem a PushDrop token.

To redeem a PushDrop token a transaction input must be created and signed using the
associated private key.

See the brc29.ts example for more information on using signAction.

```ts
export async function redeemPushDropToken(setup: SetupWallet, token: PushDropToken, options?: CreateActionOptions, description?: string, labels?: string[], inputDescription?: string): Promise<{
    beef: Beef;
    noSendChange?: string[];
}> {
    const { args, fromIdentityKey, satoshis, beef: inputBeef, outpoint } = token;
    const { keyDeriver } = setup;
    const t = new PushDrop(setup.wallet);
    const unlock = t.unlock(args.protocolID, args.keyID, fromIdentityKey, "all", false, satoshis);
    const label = "redeemPushDropToken";
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
    });
    const st = car.signableTransaction!;
    const beef = Beef.fromBinary(st.tx);
    const tx = beef.findAtomicTransaction(beef.txs.slice(-1)[0].txid)!;
    tx.inputs[0].unlockingScriptTemplate = unlock;
    await tx.sign();
    const unlockingScript = tx.inputs[0].unlockingScript!.toHex();
    const signArgs: SignActionArgs = {
        reference: st.reference,
        spends: { 0: { unlockingScript } },
        options: options || {
            acceptDelayedBroadcast: false
        }
    };
    const sar = await setup.wallet.signAction(signArgs);
    {
        const beef = Beef.fromBinary(sar.tx!);
        const txid = sar.txid!;
        if (!options)
            console.log(`
PushDrop redeemer's identityKey ${setup.identityKey}
BEEF
${beef.toHex()}
${beef.toLogString()}
`);
    }
    return {
        beef,
        noSendChange: car.noSendChange
    };
}
```

See also: [PushDropToken](./pushdrop.md#interface-pushdroptoken)

Argument Details

+ **setup**
  + The setup context which will redeem a PushDrop token as an input to a new transaction transfering
the token's satoshis to the "change" managed by `setup.wallet`.
+ **token**
  + The minted token to redeem.
+ **options**
  + Optional. Default options disable output randomization and disable allowing delayed broadcast.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->