# BRC29 Example: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the BRC29 script template example
of the `@bsv/wallet-toolbox-examples` package; which accompanies the `@bsv/wallet-toolbox`.

[BRC-29](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0029.md) 
Historically, the P2PKH script template was the primary transfer pattern used for over a decade.

In particular, the sender would construct a new transaction with the payment output
and broadcast it to the network. The recipient then used network services to find
transactions that made a payment to "their" address.

There are muliple drawbacks to this legacy method of exchange:

  1. The receiver is insentivized to re-use addresses to simplify lookup, destroying privacy.
  2. The address must be transmitted without corruption from the receiver to the sender before starting the transfer.
  3. The receiver must poll the network to discover the payment transaction.
  4. The receiver typically couldn't use the new output until some number of "confirmations",
     blocks mined on top of the original transaction mining event.

A BRC-100 wallet replaces polling for transactions by payment address with SPV enabling BEEF packaging for all transactions and new outputs.

This means payments are transmitted directly to recipients as a new transaction built on inputs which can be directly validated
by the recipient against a local copy of mined block headers;
even if the chain of new transactions supporting the latest payment is arbitrarily long.

SPV enabling BEEF packaging resolves drawbacks 3 and 4 and is used in this example.

This example demonstrate how to resolve drawbacks 1 and 2.



[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

#### Functions

| |
| --- |
| [brc29](#function-brc29) |
| [brc29Funding](#function-brc29funding) |
| [inputBRC29](#function-inputbrc29) |
| [outputBRC29](#function-outputbrc29) |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: brc29

Example of moving satoshis from one wallet to another using the BRC29 script template.

This example can be run by the following command:

```bash
npx tsx brc29
```

Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
two wallets.

```ts
export async function brc29() {
    const env = Setup.getEnv("test");
    const setup1 = await Setup.createWalletClient({ env });
    const setup2 = await Setup.createWalletClient({
        env,
        rootKeyHex: env.devKeys[env.identityKey2]
    });
    const o = await outputBRC29(setup1, setup2.identityKey, 42000);
    await inputBRC29(setup2, o);
}
```

See also: [inputBRC29](./brc29.md#function-inputbrc29), [outputBRC29](./brc29.md#function-outputbrc29)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: brc29Funding

Example receiving funding satoshis from an external BRC-100 wallet to your wallet to another using the BRC29 script template.

Edit the funding information into this example, then run the code.

This example can be run by the following command:

```bash
npx tsx brc29Funding
```

Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
two wallets.

```ts
export async function brc29Funding() {
    const env = Setup.getEnv("test");
    const setup = await Setup.createWalletClient({ env });
    const funding = {
        beef: Beef.fromString(""),
        outpoint: "",
        fromIdentityKey: "",
        satoshis: 0,
        derivationPrefix: "",
        derivationSuffix: ""
    };
    await inputBRC29(setup, funding);
}
```

See also: [inputBRC29](./brc29.md#function-inputbrc29)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: inputBRC29

Consume a BRC29 output.

To spend a BRC29 output a transaction input must be created and signed using the
associated private key.

In this example, an initial `createAction` call constructs the overall shape of a
new transaction, returning a `signableTransaction`.

The `tx` property of the `signableTransaction` should be parsed using
the standard `Beef` class. Note that it is not an ordinary AtomicBEEF for the
simple reason that the transaction has not yet been fully signed.

You can either use the method shown here to obtain a signable `Transaction` object
from this beef or you can use the `Transaction.fromAtomicBEEF` method.

To sign an input, set the corresponding input's `unlockingScriptTemplate` to an appropriately
initialized unlock object and call the `Transaction` `sign` method.

Once signed, capture the input's now valid `unlockingScript` value and convert it to a hex string.

```ts
export async function inputBRC29(setup: SetupWallet, outputBRC29: {
    beef: Beef;
    outpoint: string;
    fromIdentityKey: string;
    satoshis: number;
    derivationPrefix: string;
    derivationSuffix: string;
}) {
    const { derivationPrefix, derivationSuffix, fromIdentityKey, satoshis, beef: inputBeef, outpoint } = outputBRC29;
    const { keyDeriver } = setup;
    const t = new ScriptTemplateBRC29({
        derivationPrefix,
        derivationSuffix,
        keyDeriver
    });
    const unlock = t.unlock(setup.rootKey.toString(), fromIdentityKey, satoshis);
    const label = "inputBRC29";
    const car = await setup.wallet.createAction({
        inputBEEF: inputBeef.toBinary(),
        inputs: [
            {
                outpoint,
                unlockingScriptLength: t.unlockLength,
                inputDescription: label
            }
        ],
        labels: [label],
        description: label
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
        options: {
            acceptDelayedBroadcast: false
        }
    };
    const sar = await setup.wallet.signAction(signArgs);
    {
        const beef = Beef.fromBinary(sar.tx!);
        const txid = sar.txid!;
        console.log(`
inputP2PKH to ${setup.identityKey}
input's outpoint ${outpoint}
satoshis ${satoshis}
txid ${txid}
BEEF
${beef.toHex()}
${beef.toLogString()}
`);
    }
}
```

See also: [inputP2PKH](./p2pkh.md#function-inputp2pkh), [outputBRC29](./brc29.md#function-outputbrc29)

Argument Details

+ **setup**
  + The setup context which will consume a BRC29 output as an input to a new transaction transfering
the output's satoshis to the "change" managed by the context's wallet.
+ **outputBRC29.beef**
  + An object proving the validity of the new output where the last transaction contains the new output.
+ **outputBRC29.outpoint**
  + The txid and index of the outpoint in the format `${txid}.${index}`.
+ **outputBRC29.fromIdentityKey**
  + The public key that locked the output.
+ **outputBRC29.satoshis**
  + The amount assigned to the output.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: outputBRC29

Create a new BRC29 output.

Convert the destination identity key into its associated address and use that to generate a locking script.

Explicitly specify the new output to be created as part of a new action (transaction).

When outputs are explictly added to an action they must be funded:
Typically, at least one "change" input will be automatically added to fund the transaction,
and at least one output will be added to recapture excess funding.

```ts
export async function outputBRC29(setup: SetupWallet, toIdentityKey: string, satoshis: number): Promise<{
    beef: Beef;
    outpoint: string;
    fromIdentityKey: string;
    satoshis: number;
    derivationPrefix: string;
    derivationSuffix: string;
}> {
    const derivationPrefix = randomBytesBase64(8);
    const derivationSuffix = randomBytesBase64(8);
    const { keyDeriver } = setup;
    const t = new ScriptTemplateBRC29({
        derivationPrefix,
        derivationSuffix,
        keyDeriver
    });
    const label = "outputBRC29";
    const car = await setup.wallet.createAction({
        outputs: [
            {
                lockingScript: t.lock(setup.rootKey.toString(), toIdentityKey).toHex(),
                satoshis,
                outputDescription: label,
                tags: ["relinquish"],
                customInstructions: JSON.stringify({
                    derivationPrefix,
                    derivationSuffix,
                    type: "BRC29"
                })
            }
        ],
        options: {
            randomizeOutputs: false,
            acceptDelayedBroadcast: false
        },
        labels: [label],
        description: label
    });
    const beef = Beef.fromBinary(car.tx!);
    const outpoint = `${car.txid!}.0`;
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
`);
    return {
        beef,
        outpoint,
        fromIdentityKey: setup.identityKey,
        satoshis,
        derivationPrefix,
        derivationSuffix
    };
}
```

Returns

An object is returned with the following properties:

beef - object proving the validity of the new output where the last transaction contains the new output.

outpoint - The txid and index of the outpoint in the format `${txid}.${index}`.

fromIdentityKey - The public key that locked the output.

satoshis - The amount assigned to the output.

derivationPrefix - The BRC29 prefix string.

derivationSuffix - The BRC29 suffix string.

Argument Details

+ **setup**
  + The setup context which will create the new transaction containing the new BRC29 output.
+ **toIdentityKey**
  + The public key which will be able to unlock the output.
Note that the output uses the "address" associated with this public key: The HASH160 of the public key.
+ **satoshis**
  + How many satoshis to transfer to this new output.

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->