# Examples: BSV Wallet Toolbox API Documentation

The examples documentation is split into various pages, common bits are described here, more complex examples have their own pages:

- [makeEnv](#function-makeenv) — Create a '.env' file with secrets to support experimentation.
- [balances](#function-balances) — Sum available change outputs to display wallet balances.
- [listChange](./listChange.md) — List all spendable change outputs.
- [janitor](./janitor.md) — Cleanup invalid change outputs using `listOutputs` special operation.
- [backup](#function-backup) — Add and use a backup storage provider.
- [swapActive](#function-swapactive) - Add and swap between two `StorageClient` storage providers.
- [p2pkh](./p2pkh.md) — Create and consume P2PKH outputs.
- [internalize](./internalize.md) — Gain control over externally generated transaction outputs.
- [brc29](./brc29.md) — Create and consume BRC29 outputs to transfer satoshis between wallets.
- [pushdrop](./pushdrop.md) — Mint and redeem PushDrop tokens.
- [nosend](./nosend.md) — Create "unsent" and batched transactions.

## Getting Started

### Installation

To install the toolbox, run:

```bash
git clone https://github.com/bitcoin-sv/wallet-toolbox-examples

cd wallet-toolbox-examples

npm install

cd src

npx tsx makeEnv > .env

cat .env
```

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Functions](#functions)

#### Functions

| |
| --- |
| [backup](#function-backup) |
| [backupToSQLite](#function-backuptosqlite) |
| [backupWalletClient](#function-backupwalletclient) |
| [balanceSpecOp](#function-balancespecop) |
| [balances](#function-balances) |
| [makeEnv](#function-makeenv) |
| [runArgv2Function](#function-runargv2function) |
| [swapActive](#function-swapactive) |
| [swapActiveWalletClient](#function-swapactivewalletclient) |
| [walletBalance](#function-walletbalance) |

Links: [API](#api), [Functions](#functions)

---

##### Function: backup

```ts
export async function backup(): Promise<void> {
    const env = Setup.getEnv("test");
    await backupWalletClient(env, env.identityKey);
}
```

See also: [backupWalletClient](./README.md#function-backupwalletclient)

Links: [API](#api), [Functions](#functions)

---
##### Function: backupToSQLite

```ts
export async function backupToSQLite(setup: SetupWallet, filePath?: string, databaseName?: string): Promise<void> {
    const env = Setup.getEnv(setup.chain);
    filePath ||= `backup_${setup.identityKey}.sqlite`;
    databaseName ||= `${setup.identityKey} backup`;
    const backup = await Setup.createStorageKnex({
        env,
        knex: Setup.createSQLiteKnex(filePath),
        databaseName,
        rootKeyHex: setup.keyDeriver.rootKey.toHex()
    });
    await setup.storage.addWalletStorageProvider(backup);
    await setup.storage.updateBackups();
}
```

See also: [backup](./README.md#function-backup)

Links: [API](#api), [Functions](#functions)

---
##### Function: backupWalletClient

```ts
export async function backupWalletClient(env: SetupEnv, identityKey: string): Promise<void> {
    const setup = await Setup.createWalletClient({
        env,
        rootKeyHex: env.devKeys[identityKey]
    });
    await backupToSQLite(setup);
    await setup.wallet.destroy();
}
```

See also: [backupToSQLite](./README.md#function-backuptosqlite)

Links: [API](#api), [Functions](#functions)

---
##### Function: balanceSpecOp

Special Operations (specOps) are extensions to the base BRC-100 Wallet
standard operations.

This implementation of change balance computation uses `specOpWalletBalance`,
which is a special 'basket' value that modifies the default behavior of the
`listOutputs` method.

In the case of `specOpWalletBalance`, it automatically selects all the
spendable, 'default' basket, change outputs and returns the sum of their
`satoshis` properties, returning the sum as the `totalOutputs` property.

This is not only simpler to code, but more efficient as the outputs
do not need to be sent to the client. Only the sum of satoshis is returned.

This function can be run from the command line as:

```bash
npx txs balances balanceSpecOp
```

```ts
export async function balanceSpecOp(): Promise<void> 
```

Links: [API](#api), [Functions](#functions)

---
##### Function: balances

The `balance` function demonstrates creating a `ServerClient` based wallet and
calculating the wallet's "balance" as the sum of spendable outputs in the 'default' basket.

The 'default' basket holds the outputs that are used to automatically fund new actions,
and receives new outputs generated to recapture excess funding.

Run this function using the following command:

```bash
npx tsx balances
```

```ts
export async function balances(): Promise<void> {
    const env = Setup.getEnv("test");
    for (const identityKey of [env.identityKey, env.identityKey2]) {
        const setup = await Setup.createWalletClient({
            env,
            rootKeyHex: env.devKeys[identityKey]
        });
        let balance = 0;
        let offset = 0;
        for (;;) {
            const change = await setup.wallet.listOutputs({
                basket: "default",
                limit: 10,
                offset
            });
            balance += change.outputs.reduce((b, o) => (b += o.satoshis), 0);
            offset += change.outputs.length;
            if (change.outputs.length === 0 || offset >= change.totalOutputs)
                break;
        }
        console.log(`balance for ${identityKey} = ${balance}`);
    }
}
```

Links: [API](#api), [Functions](#functions)

---
##### Function: makeEnv

Running the `makeEnv` function generates several new private keys
and related `.env` file initializers which simplify use of the `Setup`
functions.

After running the function, copy or capture the output into a file named `.env`
in the `src` folder of this repository.

Note that you can replace or add to the auto-generated keys.

The following command will run the function,
capture the output into a file named '.env',
and display the file's contents:

```bash
npx tsx makeEnv > .env; cat .env
```

```ts
export function makeEnv() {
    Setup.makeEnv();
}
```

Links: [API](#api), [Functions](#functions)

---
##### Function: runArgv2Function

Used to run a named function from a command line of the form:

`npx txs filename.ts functionName`

Where `functionName` is an exported async function taking no arguments returning void.

Does nothing if functionName doesn't resolve to an exported function.

Optionally, if there is a functionName in `module_exports` that matches the filename,
then 'functionName' can be ommitted.

```ts
export function runArgv2Function(module_exports: object): void 
```

Argument Details

+ **module_exports**
  + pass in `module.exports` to resolve functionName

Links: [API](#api), [Functions](#functions)

---
##### Function: swapActive

```ts
export async function swapActive(): Promise<void> {
    const env = Setup.getEnv("main");
    await swapActiveWalletClient(env, env.identityKey, "https://store.txs.systems");
}
```

See also: [swapActiveWalletClient](./README.md#function-swapactivewalletclient)

Links: [API](#api), [Functions](#functions)

---
##### Function: swapActiveWalletClient

```ts
export async function swapActiveWalletClient(env: SetupEnv, identityKey: string, endpointUrl: string): Promise<SetupWallet> {
    const setup = await Setup.createWallet({
        env,
        rootKeyHex: env.devKeys[identityKey]
    });
    const client1 = new StorageClient(setup.wallet, endpointUrl);
    const client2 = new StorageClient(setup.wallet, "https://storage.babbage.systems");
    const settings1 = await client1.makeAvailable();
    const settings2 = await client2.makeAvailable();
    await setup.storage.addWalletStorageProvider(client1);
    await setup.storage.addWalletStorageProvider(client2);
    const activeStorageIdentity = setup.storage.getActiveStore();
    if (activeStorageIdentity === settings1.storageIdentityKey) {
        await setup.storage.setActive(settings2.storageIdentityKey);
    }
    else if (activeStorageIdentity === settings2.storageIdentityKey) {
        await setup.storage.setActive(settings1.storageIdentityKey);
    }
    else {
        throw new Error(`${activeStorageIdentity} is not an available storage identity`);
    }
    return setup;
}
```

Links: [API](#api), [Functions](#functions)

---
##### Function: walletBalance

And if your BRC-100 wallet supports the `balance` extension method
based on specOpWalletBalance, this is the fastest and easiest way.

This function can be run from the command line as:

```bash
npx txs balances walletBalance
```

```ts
export async function walletBalance(): Promise<void> 
```

Links: [API](#api), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->