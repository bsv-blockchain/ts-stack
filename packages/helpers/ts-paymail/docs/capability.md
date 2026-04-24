
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

# Interfaces

## Interface: TransactionNegotiationBody

```ts
export interface TransactionNegotiationBody {
    thread_id: string;
    fees: Array<{
        feeType: string;
        satoshis: number;
        bytes: number;
    }>;
    expanded_tx: {
        tx: string;
        ancestors: Array<{
            tx: string;
            merkle_proofs?: any[];
            miner_responses?: any[];
        }>;
        spent_outputs: Array<{
            value: number;
            locking_script: string;
        }>;
    };
    expiry: number;
    timestamp: number;
    reply_to: {
        handle: string;
        peer_channel?: string;
    };
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
# Classes

## Class: Capability

Represents a capability in the BSV Paymail protocol.
A capability is essentially a feature or service offered by a Paymail provider.

```ts
export default class Capability {
    constructor({ code, title, authors, version, supersedes, method }: {
        code?: string;
        title: string;
        authors?: string[];
        version?: string;
        supersedes?: string[];
        method?: "GET" | "POST";
    }) 
    public getCode(): string 
    public getMethod(): "GET" | "POST" 
}
```

<details>

<summary>Class Capability Details</summary>

### Constructor

Constructs a new Capability instance.

```ts
constructor({ code, title, authors, version, supersedes, method }: {
    code?: string;
    title: string;
    authors?: string[];
    version?: string;
    supersedes?: string[];
    method?: "GET" | "POST";
}) 
```

Argument Details

+ **params**
  + The parameters for the capability.

### Method getCode

Retrieves the code of the capability.

```ts
public getCode(): string 
```

Returns

The capability code or a generated code if not explicitly set.

### Method getMethod

Retrieves the HTTP method of the capability.

```ts
public getMethod(): "GET" | "POST" 
```

Returns

The HTTP method ('GET' or 'POST').

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
