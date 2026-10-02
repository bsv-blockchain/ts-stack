
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

# Interfaces

| | |
| --- | --- |
| [Arrival](#interface-arrival) | [RaceOutcome](#interface-raceoutcome) |
| [DiscoveredHost](#interface-discoveredhost) | [RaceResult](#interface-raceresult) |
| [DiscoveryOptions](#interface-discoveryoptions) | [RaceTask](#interface-racetask) |
| [EQCOptions](#interface-eqcoptions) | [RankedHost](#interface-rankedhost) |
| [HashGroup](#interface-hashgroup) | [Rejection](#interface-rejection) |
| [HostTransport](#interface-hosttransport) | [ReputationStore](#interface-reputationstore) |
| [LookupResolverLike](#interface-lookupresolverlike) | [Settlement](#interface-settlement) |
| [PayoutPlan](#interface-payoutplan) | [TopicConsistency](#interface-topicconsistency) |
| [QueryRequest](#interface-queryrequest) | [TransportResponse](#interface-transportresponse) |
| [QueryResult](#interface-queryresult) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Interface: Arrival

A verified attestation and the local time it arrived. `host` is the identity key.

```ts
export interface Arrival {
    url: string;
    host: string;
    attestation: Attestation;
    arrivedAt: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: DiscoveredHost

```ts
export interface DiscoveredHost {
    url: string;
    identityKeys?: string[];
}
```

<details>

<summary>Interface DiscoveredHost Details</summary>

### Property identityKeys

Every identity key a SLAP token advertised for this URL, without duplicates. SLAP is
permissionless, so anyone may advertise anyone's URL: when the list is present, the BRC-103
session key must be one of its entries, and no single token can bind the URL to a wrong key.

```ts
identityKeys?: string[]
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: DiscoveryOptions

Network options carry the same names and meaning as `LookupResolverConfig`.

```ts
export interface DiscoveryOptions {
    networkPreset?: LookupNetworkPreset;
    slapTrackers?: string[];
    hostOverrides?: Record<string, string[]>;
    additionalHosts?: Record<string, string[]>;
    resolver?: LookupResolverLike;
    hostsTtlMs?: number;
    now?: () => number;
}
```

See also: [LookupResolverLike](#interface-lookupresolverlike)

<details>

<summary>Interface DiscoveryOptions Details</summary>

### Property additionalHosts

Per market key, hosts used in addition to discovery.

```ts
additionalHosts?: Record<string, string[]>
```

### Property hostOverrides

Per market key, hosts used in place of discovery.

```ts
hostOverrides?: Record<string, string[]>
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: EQCOptions

```ts
export interface EQCOptions extends DiscoveryOptions {
    threshold?: number;
    topK?: number;
    raceMs?: number;
    floorFeeSats?: number;
    maxFeeSats?: number;
    feeSats?: number;
    queryTtlMs?: number;
    hostTimeoutMs?: number;
    paramsTimeoutMs?: number;
    paramsTtlMs?: number;
    maxHosts?: number;
    reputation?: ReputationStore;
    transport?: HostTransport;
    originator?: string;
    clock?: () => number;
}
```

See also: [DiscoveryOptions](#interface-discoveryoptions), [HostTransport](#interface-hosttransport), [ReputationStore](#interface-reputationstore)

<details>

<summary>Interface EQCOptions Details</summary>

### Property clock

Monotonic milliseconds for arrival stamps. `now` is wall-clock time.

```ts
clock?: () => number
```

### Property feeSats

A fee to offer above the floor. It is still capped by `maxFeeSats`.

```ts
feeSats?: number
```

### Property maxHosts

Most hosts contacted per query, best reputation first.

```ts
maxHosts?: number
```

### Property paramsTimeoutMs

Deadline for one `/economic/params` probe. Shorter than `hostTimeoutMs` because every query
waits for every probe, and any advertised host can stall its own.

```ts
paramsTimeoutMs?: number
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: HashGroup

```ts
export interface HashGroup {
    contentHash: string;
    hosts: string[];
    firstArrival: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: HostTransport

```ts
export interface HostTransport {
    getParams: (url: string, timeoutMs: number) => Promise<HostParams>;
    post: (url: string, path: string, body: unknown, timeoutMs: number) => Promise<TransportResponse>;
}
```

See also: [TransportResponse](#interface-transportresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: LookupResolverLike

Satisfied by the SDK `LookupResolver`; injectable for tests.

```ts
export interface LookupResolverLike {
    query: (question: LookupQuestion, timeout?: number) => Promise<LookupAnswer>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PayoutPlan

```ts
export interface PayoutPlan {
    host: string;
    url: string;
    rank: number;
    satoshis: number;
}
```

<details>

<summary>Interface PayoutPlan Details</summary>

### Property host

Host identity key.

```ts
host: string
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: QueryRequest

```ts
export interface QueryRequest {
    type: string;
    params: Record<string, unknown>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: QueryResult

```ts
export interface QueryResult {
    queryId: string;
    contentHash: string;
    payload: number[];
    supplement: number[];
    ranking: RankedHost[];
    txid: string;
    feeSats: number;
    attestations: Attestation[];
    consistency: TopicConsistency[];
    rejected: Rejection[];
    completion: Promise<void>;
}
```

See also: [RankedHost](#interface-rankedhost), [Rejection](#interface-rejection), [TopicConsistency](#interface-topicconsistency)

<details>

<summary>Interface QueryResult Details</summary>

### Property rejected

Grows until `completion` resolves, as the remaining collects finish.

```ts
rejected: Rejection[]
```
See also: [Rejection](#interface-rejection)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: RaceOutcome

```ts
export interface RaceOutcome {
    thresholdMet: boolean;
    winningHash?: string;
    ranked: Arrival[];
    minority: Arrival[];
    groups: HashGroup[];
}
```

See also: [Arrival](#interface-arrival), [HashGroup](#interface-hashgroup)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: RaceResult

```ts
export interface RaceResult {
    arrivals: Arrival[];
    rejections: Rejection[];
    unfinished: string[];
}
```

See also: [Arrival](#interface-arrival), [Rejection](#interface-rejection)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: RaceTask

`promise` must resolve to a `Rejection` instead of rejecting.

```ts
export interface RaceTask {
    url: string;
    promise: Promise<Arrival | Rejection>;
}
```

See also: [Arrival](#interface-arrival), [Rejection](#interface-rejection)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: RankedHost

```ts
export interface RankedHost {
    host: string;
    url: string;
    rank: number;
    arrivalMs: number;
    payoutSats: number;
}
```

<details>

<summary>Interface RankedHost Details</summary>

### Property arrivalMs

Milliseconds behind the fastest ranked host, as measured by this client.

```ts
arrivalMs: number
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: Rejection

```ts
export interface Rejection {
    url: string;
    host?: string;
    reason: RejectionReason;
    detail?: string;
}
```

See also: [RejectionReason](#type-rejectionreason)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: ReputationStore

Local, per-client reputation keyed by host URL. Never fed by another party's claims.

```ts
export interface ReputationStore {
    record: (url: string, event: ReputationEvent, now: number) => void;
    isExcluded: (url: string, now: number) => boolean;
    score: (url: string) => number;
}
```

See also: [ReputationEvent](#type-reputationevent)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: Settlement

```ts
export interface Settlement {
    txid: string;
    envelopes: Map<string, PaymentEnvelope>;
}
```

<details>

<summary>Interface Settlement Details</summary>

### Property envelopes

One envelope per paid host, keyed by identity key; only the suffix differs.

```ts
envelopes: Map<string, PaymentEnvelope>
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: TopicConsistency

```ts
export interface TopicConsistency {
    topic: string;
    status: ConsistencyStatus;
    blockHeight?: number;
    tac?: string;
    hosts: Array<{
        host: string;
        status: ConsistencyStatus;
        blockHeight?: number;
        tac?: string;
    }>;
}
```

See also: [ConsistencyStatus](#type-consistencystatus)

<details>

<summary>Interface TopicConsistency Details</summary>

### Property blockHeight

Highest tip corroborated by at least two distinct winners; omitted when no height qualifies.

```ts
blockHeight?: number
```

### Property tac

The TAC at that height, when every host at that height agrees.

```ts
tac?: string
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: TransportResponse

```ts
export interface TransportResponse {
    status: number;
    body: unknown;
    identityKey?: string;
}
```

<details>

<summary>Interface TransportResponse Details</summary>

### Property body

Parsed JSON, or `undefined` when the body was not JSON.

```ts
body: unknown
```

### Property identityKey

The BRC-103 session identity of the host that answered.

```ts
identityKey?: string
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Classes

| |
| --- |
| [AuthFetchTransport](#class-authfetchtransport) |
| [EQC](#class-eqc) |
| [HostDiscovery](#class-hostdiscovery) |
| [InMemoryReputationStore](#class-inmemoryreputationstore) |
| [TransportStatusError](#class-transportstatuserror) |
| [TransportTimeoutError](#class-transporttimeouterror) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Class: AuthFetchTransport

```ts
export class AuthFetchTransport implements HostTransport {
    constructor(wallet: WalletInterface, options: {
        originator?: string;
        fetch?: typeof fetch;
        maxResponseBytes?: number;
    } = {}) 
    async getParams(url: string, timeoutMs: number): Promise<HostParams> 
    async post(url: string, path: string, body: unknown, timeoutMs: number): Promise<TransportResponse> 
}
```

See also: [HostTransport](#interface-hosttransport), [TransportResponse](#interface-transportresponse)

<details>

<summary>Class AuthFetchTransport Details</summary>

### Method getParams

`/economic/params` is unauthenticated, so it is read with a plain, bounded fetch.

```ts
async getParams(url: string, timeoutMs: number): Promise<HostParams> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: EQC

Economic Query Client for BRC-178. Discovers hosts from SLAP trackers, asks all of them the
same authenticated query, ranks their attestations by local arrival time, pays the fastest
hosts that agree from one transaction, and returns bytes whose hash it verified.

```ts
export class EQC {
    constructor(wallet: WalletInterface, options: EQCOptions = {}) 
    async lookup(question: LookupQuestion, overrides: QueryOverrides = {}): Promise<LookupAnswer> 
    async listMessages(args: {
        messageBox: string;
    }, overrides: QueryOverrides = {}): Promise<CanonicalMessage[]> 
    async params(url: string): Promise<HostParams> 
    async query(request: QueryRequest, overrides: QueryOverrides = {}): Promise<QueryResult> 
}
```

See also: [EQCOptions](#interface-eqcoptions), [QueryOverrides](#type-queryoverrides), [QueryRequest](#interface-queryrequest), [QueryResult](#interface-queryresult)

<details>

<summary>Class EQC Details</summary>

### Method listMessages

Races the caller's own message box listing.

```ts
async listMessages(args: {
    messageBox: string;
}, overrides: QueryOverrides = {}): Promise<CanonicalMessage[]> 
```
See also: [QueryOverrides](#type-queryoverrides)

### Method lookup

Races an overlay lookup and rebuilds the `LookupAnswer` from the verified bytes.

```ts
async lookup(question: LookupQuestion, overrides: QueryOverrides = {}): Promise<LookupAnswer> 
```
See also: [QueryOverrides](#type-queryoverrides)

### Method params

Reads and caches a host's unauthenticated `/economic/params`, bounded by `paramsTimeoutMs`.
A 4xx answer is the host saying it runs no market and is remembered for `paramsTtlMs`. A
timeout, a network or parse failure, and a 5xx answer may pass, so they are remembered only
for `min(paramsTtlMs, 15 s)`: long enough that a host which stalls its probe costs one wait
per interval instead of one per query, short enough that a blip is forgotten. The cause is
never replaced: the error a caller sees from a cache hit is the very error the transport raised.

```ts
async params(url: string): Promise<HostParams> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: HostDiscovery

Bootstraps from SLAP trackers, as `LookupResolver` does. Discovery runs on the free BRC-24
`/lookup` route and makes no wallet call; the fee of the query that follows covers it.

```ts
export class HostDiscovery {
    constructor(options: DiscoveryOptions = {}) 
    async hostsFor(target: DiscoveryTarget): Promise<DiscoveredHost[]> 
}
```

See also: [DiscoveredHost](#interface-discoveredhost), [DiscoveryOptions](#interface-discoveryoptions), [DiscoveryTarget](#type-discoverytarget)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: InMemoryReputationStore

```ts
export class InMemoryReputationStore implements ReputationStore {
    constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) 
    record(url: string, event: ReputationEvent, now: number): void 
    isExcluded(url: string, now: number): boolean 
    score(url: string): number 
}
```

See also: [ReputationEvent](#type-reputationevent), [ReputationStore](#interface-reputationstore)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: TransportStatusError

A host answered, but with a status other than 200. `status` is what makes the answer worth
caching: a 4xx is the host stating it runs no market, while a 5xx is a passing failure.

```ts
export class TransportStatusError extends Error {
    readonly status: number;
    constructor(url: string, status: number) 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: TransportTimeoutError

```ts
export class TransportTimeoutError extends Error {
    constructor(url: string, timeoutMs: number) 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Functions

| |
| --- |
| [assessConsistency](#function-assessconsistency) |
| [classifyMinority](#function-classifyminority) |
| [decideRace](#function-deciderace) |
| [discoveryTarget](#function-discoverytarget) |
| [nonPayingWallet](#function-nonpayingwallet) |
| [orderByScore](#function-orderbyscore) |
| [planPayouts](#function-planpayouts) |
| [runRace](#function-runrace) |
| [settle](#function-settle) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Function: assessConsistency

Compares BRC-136 topic anchors across the winning hosts. Agreement means `t` hosts with
distinct identity keys, not necessarily distinct operators, share the answer and the topic's whole confirmed history through that height. A matching TAC
proves agreement on admission only; bans and janitor removals are node-local. The reference tip
is corroborated (see `referenceFor`); when no height is corroborated for a topic there is no
reference, every winner that reported the topic is `unknown`, and the topic itself is `unknown`.

```ts
export function assessConsistency(winners: Arrival[]): TopicConsistency[] 
```

See also: [Arrival](#interface-arrival), [TopicConsistency](#interface-topicconsistency)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: classifyMinority

Explains a minority answer for reputation, against the same corroborated reference as
`assessConsistency`. A host that is behind the reference is excused; a host whose admission
state matches the winners at the reference height yet answered differently is not. Any anchor
that is not behind and does not match the reference — including one with no corroborated
reference at all, a TAC-less (diverged) reference, or a claim above the reference height — is
treated as non-matching rather than excused, so a fabricated high tip from one winner can never
launder a genuinely diverged minority host into `lagging`.

```ts
export function classifyMinority(minority: Arrival, winners: Arrival[]): "lagging" | "diverged-answer" | "minority-hash" 
```

See also: [Arrival](#interface-arrival)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: decideRace

Picks the hash attested by the most distinct hosts (ties go to the hash seen first) and ranks
its hosts by client-measured arrival. Host-claimed `attestedAt` is never read.

```ts
export function decideRace(arrivals: Arrival[], params: {
    threshold: number;
    topK: number;
}): RaceOutcome 
```

See also: [Arrival](#interface-arrival), [RaceOutcome](#interface-raceoutcome)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: discoveryTarget

The market key is the lookup service name for `overlay-lookup`, else the class name.

```ts
export function discoveryTarget(type: string, params: Record<string, unknown>, client: string): DiscoveryTarget 
```

See also: [DiscoveryTarget](#type-discoverytarget)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: nonPayingWallet

The wallet `AuthFetch` sees. Hosts here are advertised permissionlessly, so they are untrusted,
and `AuthFetch` would otherwise pay any well-formed HTTP 402 with no cap and answer a host's
BRC-103 certificate request with the user's identity certificates. This facade is an allowlist:
only the five calls authentication needs reach the real wallet. `listCertificates` answers an
empty list, so a certificate request is answered with nothing instead of failing the session,
and every other method rejects. The EQC spends only through `settle`.

```ts
export function nonPayingWallet(wallet: WalletInterface): WalletInterface 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: orderByScore

Orders `items` best score first and shuffles every run of equal scores (Fisher-Yates). Without
the shuffle, ties keep discovery order, so whoever answers a tracker first decides which hosts a
`maxHosts` cut ever contacts. `random(bound)` returns an integer in `[0, bound)`.

```ts
export function orderByScore<T>(items: readonly T[], score: (item: T) => number, random: (bound: number) => number = randomBelow): T[] 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: planPayouts

Fibonacci split over the ranked hosts. Shares are non-increasing, so zeros only trail.

```ts
export function planPayouts(ranked: Arrival[], feeSats: number): PayoutPlan[] 
```

See also: [Arrival](#interface-arrival), [PayoutPlan](#interface-payoutplan)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: runRace

Collects attestations until the race window closes: `raceMs` after the first valid arrival,
or sooner when every host has settled or `topK` hosts already share one hash. With no valid
arrival the race ends at `hostTimeoutMs`.

```ts
export async function runRace(tasks: RaceTask[], options: {
    raceMs: number;
    hostTimeoutMs: number;
    topK: number;
}): Promise<RaceResult> 
```

See also: [RaceResult](#interface-raceresult), [RaceTask](#interface-racetask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Function: settle

Builds the single payout transaction. A normal action is used, so the client wallet
broadcasts: a host's `internalizeAction` broadcasts on receipt anyway, and aborting a
`noSend` action after dispatch would leave the wallet believing spent inputs are free.

```ts
export async function settle(wallet: WalletInterface, queryId: string, plans: PayoutPlan[], originator?: string): Promise<Settlement> 
```

See also: [PayoutPlan](#interface-payoutplan), [Settlement](#interface-settlement)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Types

| |
| --- |
| [ConsistencyStatus](#type-consistencystatus) |
| [DiscoveryTarget](#type-discoverytarget) |
| [QueryOverrides](#type-queryoverrides) |
| [RejectionReason](#type-rejectionreason) |
| [ReputationEvent](#type-reputationevent) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Type: ConsistencyStatus

```ts
export type ConsistencyStatus = "agreed" | "lagging" | "diverged" | "unknown"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: DiscoveryTarget

```ts
export type DiscoveryTarget = {
    kind: "overlay-lookup";
    service: string;
} | {
    kind: "message-list";
    recipient: string;
} | {
    kind: "static";
    key: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: QueryOverrides

```ts
export type QueryOverrides = Pick<EQCOptions, "threshold" | "topK" | "raceMs" | "floorFeeSats" | "maxFeeSats" | "feeSats">
```

See also: [EQCOptions](#interface-eqcoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: RejectionReason

```ts
export type RejectionReason = "timeout" | "http" | "malformed" | "bad-signature" | "identity-mismatch" | "wrong-query" | "minority-hash" | "late" | "collect-failed" | "hash-mismatch"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: ReputationEvent

`unadvertised-identity` is a host whose session key no SLAP token names for its URL. It shares
the `identity-mismatch` rejection reason but not its penalty, because the advertisement is
third-party data.

```ts
export type ReputationEvent = "success" | "lagging" | "diverged-answer" | "unadvertised-identity" | RejectionReason
```

See also: [RejectionReason](#type-rejectionreason)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Variables

