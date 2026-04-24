# Internalize Examples: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers `@bsv/wallet-toolbox` support
for internalizing (gaining control over) externally generated transaction outputs.


[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

#### Functions

##### Function: internalizeWalletPayment

Example of internalizing a BRC29 wallet payment output into a receiving wallet.

This example can be run by the following command:

```bash
npx tsx internalizeWalletPayment
```

Combine this with the [balances](./README.md#function-balances) example to observe satoshis being transfered between
two wallets.

```ts
export async function internalizeWalletPayment() {
    const env = Setup.getEnv("main");
    const setup1 = await Setup.createWalletClient({ env });
    const setup2 = await Setup.createWalletClient({
        env,
        rootKeyHex: env.devKeys[env.identityKey2]
    });
    const o = await outputBRC29(setup1, setup2.identityKey, 42);
    const { txid, vout } = parseWalletOutpoint(o.outpoint);
    const args: InternalizeActionArgs = {
        tx: o.beef.toBinaryAtomic(txid),
        outputs: [
            {
                outputIndex: vout,
                protocol: "wallet payment",
                paymentRemittance: {
                    derivationPrefix: o.derivationPrefix,
                    derivationSuffix: o.derivationSuffix,
                    senderIdentityKey: setup1.identityKey
                }
            }
        ],
        description: "internalizeWalletPayment example"
    };
    const iwpr = await setup2.wallet.internalizeAction(args);
    console.log(JSON.stringify(iwpr));
    await setup1.wallet.destroy();
    await setup2.wallet.destroy();
}
```

See also: [outputBRC29](./brc29.md#function-outputbrc29)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->