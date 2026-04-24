### API

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

#### Interfaces

#### Functions

| |
| --- |
| [al](#function-al) |
| [ar](#function-ar) |
| [listChange](#function-listchange) |

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---

##### Function: al

"Align Left" function for simple table formatting.
Adds spaces to the end of a string or number value to
return a string of minimum length `w`

```ts
export function al(v: string | number, w: number): string 
```

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: ar

"Align Right" function for simple table formatting.
Adds spaces to the start of a string or number value to
return a string of minimum length `w`

```ts
export function ar(v: string | number, w: number): string 
```

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
##### Function: listChange

Run this function using the following command:

```bash
npx tsx listChange
```

```ts
export async function listChange(): Promise<void> {
    const env = Setup.getEnv("test");
    for (const identityKey of [env.identityKey, env.identityKey2]) {
        const setup = await Setup.createWalletClient({
            env,
            rootKeyHex: env.devKeys[identityKey]
        });
        console.log(`

Change for:
  identityKey ${identityKey}
`);
        const { actions, totalActions } = await setup.wallet.listActions({
            labels: [],
            includeOutputs: true,
            limit: 1000
        });
        for (const stati of [["nosend"], ["completed", "unproven"]])
            for (const a of actions.reverse()) {
                if (stati.indexOf(a.status) >= 0) {
                    for (const o of a.outputs!) {
                        if (o.spendable && o.basket === "default") {
                            console.log(`${ar(o.satoshis, 10)} ${al(a.status, 10)} ${ar(o.outputIndex, 3)} ${a.txid}`);
                        }
                    }
                }
            }
    }
}
```

See also: [al](./listChange.md#function-al), [ar](./listChange.md#function-ar)

Links: [API](#api), [Interfaces](#interfaces), [Functions](#functions)

---
