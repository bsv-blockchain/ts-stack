
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

# Interfaces

| | |
| --- | --- |
| [EconomicQueryHost](#interface-economicqueryhost) | [PendingStore](#interface-pendingstore) |
| [EconomicQueryHostOptions](#interface-economicqueryhostoptions) | [PendingStoreLimits](#interface-pendingstorelimits) |
| [HostRequest](#interface-hostrequest) | [ProviderContext](#interface-providercontext) |
| [HostResponse](#interface-hostresponse) | [ProviderResult](#interface-providerresult) |
| [LookupEngineLike](#interface-lookupenginelike) | [QueryProvider](#interface-queryprovider) |
| [MessageListSource](#interface-messagelistsource) | [RouterLike](#interface-routerlike) |
| [PendingQuery](#interface-pendingquery) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Interface: EconomicQueryHost

```ts
export interface EconomicQueryHost {
    params: HostHandler;
    query: HostHandler;
    collect: HostHandler;
    mount: (router: RouterLike) => void;
}
```

See also: [HostHandler](#type-hosthandler), [RouterLike](#interface-routerlike)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: EconomicQueryHostOptions

```ts
export interface EconomicQueryHostOptions {
    wallet: WalletInterface;
    providers: QueryProvider[];
    threshold?: number;
    topK?: number;
    floorFeeSats?: number | ((payloadSize: number) => number);
    minPayoutSats?: number;
    maxQueryTtlMs?: number;
    maxPayloadBytes?: number;
    store?: PendingStore;
    now?: () => number;
    originator?: string;
    logger?: {
        error: (...args: unknown[]) => void;
    };
}
```

See also: [PendingStore](#interface-pendingstore), [QueryProvider](#interface-queryprovider)

<details>

<summary>Interface EconomicQueryHostOptions Details</summary>

### Property floorFeeSats

Minimum total fee for a query, optionally scaled by canonical payload size.

```ts
floorFeeSats?: number | ((payloadSize: number) => number)
```

### Property maxPayloadBytes

Largest delivery this host attests, as the estimated size of the collect response: base64 of
the payload and of the supplement, plus 1024 bytes for the JSON envelope. Default 2 MiB. Keep
it under the response limit of the server the routes are mounted on, or the host takes a
payment for an answer the server then replaces with a 413.

```ts
maxPayloadBytes?: number
```

### Property minPayoutSats

Smallest output this host serves a collect for, even when its Fibonacci share is smaller.

```ts
minPayoutSats?: number
```

### Property threshold

Advertised default; the client chooses the threshold it actually uses.

```ts
threshold?: number
```

### Property topK

Advertised, and enforced: the largest `topK` this host accepts. A query asking for more is
answered 400 `ERR_INVALID_QUERY`, because a longer ranking dilutes every share. The smallest
share this host can be held to is `max(minPayoutSats, requiredShare(quote, topK, topK))`.

```ts
topK?: number
```

### Property wallet

Signs attestations and deliveries and internalizes payouts, so it needs a storage provider.
An authentication-only wallet, such as the one `@bsv/overlay-express` hands a registered
router, signs but cannot internalize: every collect then fails with a logged 500. Build a
storage-backed wallet from the same root key instead.

```ts
wallet: WalletInterface
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: HostRequest

The slice of an express `Request` the handlers read. `auth` is set by BRC-103 middleware.

```ts
export interface HostRequest {
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
    auth?: {
        identityKey?: string;
    };
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: HostResponse

The slice of an express `Response` the handlers write.

```ts
export interface HostResponse {
    status(code: number): HostResponse;
    json(body: unknown): unknown;
    set(name: string, value: string): unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: LookupEngineLike

The part of `@bsv/overlay` `Engine` this package uses, typed structurally.

```ts
export interface LookupEngineLike {
    lookup: (question: LookupQuestion) => Promise<{
        type: string;
        outputs?: unknown;
    }>;
    provideTopicAnchorTip?: (topic: string) => Promise<{
        topic: string;
        blockHeight: number;
        blockHash?: string;
        tac: string;
    }>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: MessageListSource

```ts
export interface MessageListSource {
    listMessages: (recipient: string, messageBox: string) => Promise<CanonicalMessage[]>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PendingQuery

```ts
export interface PendingQuery {
    queryId: string;
    query: EconomicQuery;
    clientIdentityKey: string;
    attestation: Attestation;
    payload: number[];
    supplement: number[];
    expiresAt: number;
    state: PendingState;
}
```

See also: [PendingState](#type-pendingstate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PendingStore

Asynchronous so a shared store can back several host instances.

```ts
export interface PendingStore {
    get: (queryId: string) => Promise<PendingQuery | undefined>;
    put: (record: PendingQuery) => Promise<PendingPutResult>;
    beginSettle: (queryId: string) => Promise<boolean>;
    abortSettle: (queryId: string) => Promise<void>;
    completeSettle: (queryId: string) => Promise<void>;
}
```

See also: [PendingPutResult](#type-pendingputresult), [PendingQuery](#interface-pendingquery)

<details>

<summary>Interface PendingStore Details</summary>

### Property beginSettle

Atomically claims a pending query for settlement. False when it is not claimable.

```ts
beginSettle: (queryId: string) => Promise<boolean>
```

### Property put

Never overwrites: a queryId the store already holds answers `duplicate`.

```ts
put: (record: PendingQuery) => Promise<PendingPutResult>
```
See also: [PendingPutResult](#type-pendingputresult), [PendingQuery](#interface-pendingquery)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PendingStoreLimits

```ts
export interface PendingStoreLimits {
    maxEntries: number;
    maxBytes: number;
    maxPendingPerClient: number;
    settledGraceMs: number;
}
```

<details>

<summary>Interface PendingStoreLimits Details</summary>

### Property maxEntries

Every record counts, including expired and settled ones still inside the grace period.

```ts
maxEntries: number
```

### Property maxPendingPerClient

Unsettled, unexpired records one client may hold.

```ts
maxPendingPerClient: number
```

### Property settledGraceMs

How long a record outlives its expiry, so a late collect is answered 409 or 410 instead of
404. Only the record is kept: an unsettled record gives up its payload at expiry.

```ts
settledGraceMs: number
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: ProviderContext

```ts
export interface ProviderContext {
    clientIdentityKey: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: ProviderResult

```ts
export interface ProviderResult {
    payload: number[];
    supplement?: number[];
    extensions?: {
        anchors?: TopicAnchor[];
    };
}
```

<details>

<summary>Interface ProviderResult Details</summary>

### Property supplement

Bytes delivered with the payload but outside the content hash, such as BEEF.

```ts
supplement?: number[]
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: QueryProvider

Answers one query class. Throw `HostError` for a caller mistake; anything else becomes a 500.

```ts
export interface QueryProvider {
    readonly type: string;
    execute: (query: EconomicQuery, context: ProviderContext) => Promise<ProviderResult>;
}
```

See also: [ProviderContext](#interface-providercontext), [ProviderResult](#interface-providerresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: RouterLike

Satisfied by an express `Router` or `Application`.

```ts
export interface RouterLike {
    get(path: string, handler: HostHandler): unknown;
    post(path: string, handler: HostHandler): unknown;
}
```

See also: [HostHandler](#type-hosthandler)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Classes

## Class: InMemoryPendingStore

Attestation is free and caches a payload, so the store is bounded. A full store rejects new
queries instead of evicting live ones, which would break honest clients mid-race.

An unsettled record whose `expiresAt` has passed is dead: collect answers 410 for it. It gives
up its payload and supplement and stops counting toward `maxPendingPerClient` the next time
`get`, `put`, or `beginSettle` runs, while the emptied record stays through the grace period.

```ts
export class InMemoryPendingStore implements PendingStore {
    constructor(limits: Partial<PendingStoreLimits> = {}, clock: () => number = Date.now) 
    async get(queryId: string): Promise<PendingQuery | undefined> 
    async put(record: PendingQuery): Promise<PendingPutResult> 
    async beginSettle(queryId: string): Promise<boolean> 
    async abortSettle(queryId: string): Promise<void> 
    async completeSettle(queryId: string): Promise<void> 
}
```

See also: [PendingPutResult](#type-pendingputresult), [PendingQuery](#interface-pendingquery), [PendingStore](#interface-pendingstore), [PendingStoreLimits](#interface-pendingstorelimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Functions

| |
| --- |
| [bytesProvider](#function-bytesprovider) |
| [createEconomicQueryHost](#function-createeconomicqueryhost) |
| [messageListProvider](#function-messagelistprovider) |
| [overlayLookupProvider](#function-overlaylookupprovider) |
| [verifyAndInternalizePayment](#function-verifyandinternalizepayment) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Function: bytesProvider

Races any read whose answer is a byte string, such as `relay-lookup` or `message-body`.

```ts
export function bytesProvider(type: string, resolve: (params: Record<string, unknown>, context: ProviderContext) => Promise<number[] | undefined>): QueryProvider 
```

See also: [ProviderContext](#interface-providercontext), [QueryProvider](#interface-queryprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: createEconomicQueryHost

```ts
export function createEconomicQueryHost(options: EconomicQueryHostOptions): EconomicQueryHost 
```

See also: [EconomicQueryHost](#interface-economicqueryhost), [EconomicQueryHostOptions](#interface-economicqueryhostoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: messageListProvider

Races BRC-33 message listings. Only the authenticated recipient may list its own inbox.

```ts
export function messageListProvider(source: MessageListSource): QueryProvider 
```

See also: [MessageListSource](#interface-messagelistsource), [QueryProvider](#interface-queryprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: overlayLookupProvider

Races BRC-24 lookups. The hashed payload is the sorted outpoint section; BEEF travels as the
supplement because honest hosts hold different proof state for the same outputs.

```ts
export function overlayLookupProvider(options: {
    engine: LookupEngineLike;
    anchorTopics?: Record<string, string[]>;
}): QueryProvider 
```

See also: [LookupEngineLike](#interface-lookupenginelike), [QueryProvider](#interface-queryprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: verifyAndInternalizePayment

Verifies a BRC-178 payout for this host. `@bsv/payment-express-middleware` cannot be used: it
demands a server-minted derivation prefix and always internalizes output 0. Here the prefix is
the query ID, and the host finds its own output by deriving the script it expects.

```ts
export async function verifyAndInternalizePayment(args: {
    wallet: WalletInterface;
    envelope: PaymentEnvelope;
    queryId: string;
    rank: number;
    clientIdentityKey: string;
    requiredSats: number;
    originator?: string;
}): Promise<PaymentVerification> 
```

See also: [PaymentVerification](#type-paymentverification)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Types

| |
| --- |
| [HostHandler](#type-hosthandler) |
| [PaymentVerification](#type-paymentverification) |
| [PendingPutResult](#type-pendingputresult) |
| [PendingState](#type-pendingstate) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Type: HostHandler

```ts
export type HostHandler = (req: HostRequest, res: HostResponse) => Promise<void>
```

See also: [HostRequest](#interface-hostrequest), [HostResponse](#interface-hostresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: PaymentVerification

```ts
export type PaymentVerification = {
    ok: true;
    txid: string;
    outputIndex: number;
    satoshis: number;
} | {
    ok: false;
    reason: "malformed" | "no-output" | "underpaid" | "rejected" | "wallet-error";
    required?: number;
    paid?: number;
    message?: string;
    txid?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: PendingPutResult

The outcome of a `put`. `duplicate` means the store already holds that queryId, untouched.

```ts
export type PendingPutResult = "stored" | "duplicate" | "too-many-pending" | "too-large"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: PendingState

```ts
export type PendingState = "pending" | "settling" | "settled"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Variables

