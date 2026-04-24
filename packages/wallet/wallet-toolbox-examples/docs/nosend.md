# Internalize Examples: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers `@bsv/wallet-toolbox` support
for creating "unsent" and batched transactions.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

#### Functions

| |
| --- |
| [mintTokens](#function-minttokens) |
| [nosend](#function-nosend) |
| [redeemTokens](#function-redeemtokens) |
| [sendWith](#function-sendwith) |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: mintTokens

```ts
export async function mintTokens(setup: SetupWallet, args: PushDropArgs, count: number, size: number, noSendChange?: string[]): Promise<{
    tokens: PushDropToken[];
    noSendChange?: string[];
}> {
    const r: {
        tokens: PushDropToken[];
        noSendChange?: string[];
    } = {
        tokens: [],
        noSendChange
    };
    for (let i = 0; i < count; i++) {
        args.fields[0][0] = i % 255;
        const options: CreateActionOptions = {
            noSend: true,
            noSendChange: r.noSendChange
        };
        const token = await mintPushDropToken(setup, 37, args, options);
        r.tokens.push(token);
        r.noSendChange = token.noSendChange;
    }
    return r;
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [PushDropToken](./pushdrop.md#interface-pushdroptoken), [mintPushDropToken](./pushdrop.md#function-mintpushdroptoken)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: nosend

```ts
export async function nosend() {
    const env = Setup.getEnv("test");
    const setup = await Setup.createWalletClient({ env });
    const args: PushDropArgs = {
        protocolID: [2, "nosendexample"],
        keyID: randomBytesBase64(8),
        includeSignature: false,
        lockPosition: "before",
        counterparty: "self",
        fields: [Random(12)]
    };
    const mr = await mintTokens(setup, args, 3, args.fields[0].length);
    const swr1 = await sendWith(setup, mr.tokens.map(t => t.beef.atomicTxid!));
    const rr = await redeemTokens(setup, mr.tokens);
    const swr2 = await sendWith(setup, rr.beefs.map(b => b.atomicTxid!));
}
```

See also: [PushDropArgs](./pushdrop.md#interface-pushdropargs), [mintTokens](./nosend.md#function-minttokens), [redeemTokens](./nosend.md#function-redeemtokens), [sendWith](./nosend.md#function-sendwith)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: redeemTokens

```ts
export async function redeemTokens(setup: SetupWallet, tokens: PushDropToken[], noSendChange?: string[]): Promise<{
    beefs: Beef[];
    noSendChange?: string[];
}> {
    const r: {
        beefs: Beef[];
        noSendChange?: string[];
    } = {
        beefs: [],
        noSendChange
    };
    for (const token of tokens) {
        const options: CreateActionOptions = {
            noSend: true,
            noSendChange: r.noSendChange
        };
        const rr = await redeemPushDropToken(setup, token, options);
        r.beefs.push(rr.beef);
        r.noSendChange = rr.noSendChange;
    }
    return r;
}
```

See also: [PushDropToken](./pushdrop.md#interface-pushdroptoken), [redeemPushDropToken](./pushdrop.md#function-redeempushdroptoken)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: sendWith

```ts
export async function sendWith(setup: SetupWallet, txids: string[]): Promise<SendWithResult[]> {
    const car = await setup.wallet.createAction({
        options: {
            sendWith: txids
        },
        description: "sendWith"
    });
    return car.sendWithResults!;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

<!--#endregion ts2md-api-merged-here-->