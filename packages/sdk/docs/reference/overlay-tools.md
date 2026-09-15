# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

|                                                             |                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| [AdmittanceInstructions](#interface-admittanceinstructions) | [OverlayBroadcastFacilitator](#interface-overlaybroadcastfacilitator) |
| [LookupAnswerProgress](#interface-lookupanswerprogress)     | [OverlayLookupFacilitator](#interface-overlaylookupfacilitator)       |
| [LookupFreeformAnswer](#interface-lookupfreeformanswer)     | [RankedHost](#interface-rankedhost)                                   |
| [LookupQueryOptions](#interface-lookupqueryoptions)         | [SHIPBroadcasterConfig](#interface-shipbroadcasterconfig)             |
| [LookupQuestion](#interface-lookupquestion)                 | [TaggedBEEF](#interface-taggedbeef)                                   |
| [LookupResolution](#interface-lookupresolution)             | [UnreachableHostInfo](#interface-unreachablehostinfo)                 |
| [LookupResolverConfig](#interface-lookupresolverconfig)     |                                                                       |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: AdmittanceInstructions

Instructs the Overlay Services Engine about which outputs to admit and which previous outputs to retain. Returned by a Topic Manager.

```ts
export interface AdmittanceInstructions {
  outputsToAdmit: number[]
  coinsToRetain: number[]
  coinsRemoved?: number[]
}
```

#### Property coinsRemoved

The indices of all inputs from the provided transaction which reference previously-admitted outputs,
which are now considered spent and have been removed from the managed topic.

```ts
coinsRemoved?: number[]
```

#### Property coinsToRetain

The indices of all inputs from the provided transaction which spend previously-admitted outputs that should be retained for historical record-keeping.

```ts
coinsToRetain: number[]
```

#### Property outputsToAdmit

The indices of all admissible outputs into the managed topic from the provided transaction.

```ts
outputsToAdmit: number[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupAnswerProgress

```ts
export interface LookupAnswerProgress {
  type: 'output-list'
  outputs: Array<{
    beef: number[]
    outputIndex: number
    context?: number[]
    txid?: string
  }>
  txIds: string[]
  isFinal: boolean
  hostCount: number
  completedHosts: number
  successfulHosts: number
  emptyHosts: number
  failedHosts: number
  rejectedHosts: number
  freeformHosts: number
  correlationId?: string
}
```

#### Property completedHosts

Number of hosts that have settled (success / fail / timeout).

```ts
completedHosts: number
```

#### Property correlationId

Correlation id used for privacy-safe distributed diagnostics.

```ts
correlationId?: string
```

#### Property emptyHosts

Successful hosts whose output list was empty.

```ts
emptyHosts: number
```

#### Property failedHosts

Hosts that failed due to availability, timeout, or malformed responses.

```ts
failedHosts: number
```

#### Property freeformHosts

Hosts that returned a valid but non-aggregatable freeform response.

```ts
freeformHosts: number
```

#### Property hostCount

Number of ranked hosts that were queried.

```ts
hostCount: number
```

#### Property isFinal

True only for the final emission, after every in-flight host has settled.

```ts
isFinal: boolean
```

#### Property rejectedHosts

Hosts that rejected this query semantically (for example, HTTP 400).

```ts
rejectedHosts: number
```

#### Property successfulHosts

Hosts that returned a structurally valid output-list response.

```ts
successfulHosts: number
```

#### Property txIds

Parallel array of resolved tx ids for each output (same index as `outputs`).

```ts
txIds: string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupFreeformAnswer

A valid non-aggregatable response returned by a lookup service.

```ts
export interface LookupFreeformAnswer {
  type: 'freeform'
  result: unknown
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupQueryOptions

```ts
export interface LookupQueryOptions {
  onEvidence?: (event: LookupEvidenceEvent) => void | Promise<void>
  evidenceLimits?: {
    maxOutputs?: number
    maxBytes?: number
  }
  graceMs?: number
  softTimeoutMs?: number
  onUnreachableHost?: (info: UnreachableHostInfo) => void | Promise<void>
  unreachableHostNotificationCooldownMs?: number
  holdForUnknownHosts?: boolean
  waitForAllHosts?: boolean
  correlationId?: string
}
```

See also: [LookupEvidenceEvent](./overlay-tools.md#type-lookupevidenceevent), [UnreachableHostInfo](./overlay-tools.md#interface-unreachablehostinfo)

#### Property correlationId

Correlates resolver and downstream wallet telemetry without logging the query payload.

```ts
correlationId?: string
```

#### Property evidenceLimits

Callback intake budget, independent of legacy aggregation. Defaults to 512
outputs / 16 MiB of BEEF and context bytes. Values must be positive safe
integers. Coordinate these with a downstream verifier's admission limits.

```ts
evidenceLimits?: {
    maxOutputs?: number;
    maxBytes?: number;
}
```

#### Property graceMs

Override the grace window (ms) between the first valid response and the resolution of the query.
Late responders arriving within this window are merged into the result. Default 80 ms.
Raise for identity-style paths (e.g. ~300 ms) where divergence between hosts matters.

```ts
graceMs?: number
```

#### Property holdForUnknownHosts

Compatibility alias for `waitForAllHosts`. Prefer `waitForAllHosts` in new
code. `waitForAllHosts` takes precedence when both are supplied.

```ts
holdForUnknownHosts?: boolean
```

#### Property onEvidence

Owned, UNTRUSTED receipts before legacy txid/outpoint deduplication. Enqueue
promptly; callback completion is not awaited and failures are isolated.
Intake stops at the configured evidenceLimits, reporting one limit event.
No callbacks occur after the query iterator closes. Legacy answers, host
scheduling, timeout and reputation behavior are unchanged.

```ts
onEvidence?: (event: LookupEvidenceEvent) => void | Promise<void>
```

See also: [LookupEvidenceEvent](./overlay-tools.md#type-lookupevidenceevent)

#### Property onUnreachableHost

Fired when a SLAP-advertised host fails (network error, timeout, malformed
response). The resolver itself does not email or escalate — downstream
consumers (e.g. overlay-express) wire this up to the BSVA notification API
to let the originating overlay operator know about a stale advertisement.

```ts
onUnreachableHost?: (info: UnreachableHostInfo) => void | Promise<void>
```

See also: [UnreachableHostInfo](./overlay-tools.md#interface-unreachablehostinfo)

#### Property softTimeoutMs

Soft timeout (ms). When set:

- `query()` resolves with whatever has arrived as soon as any host answers, or after this timeout.
- `query$()` emits a (possibly empty) snapshot after this timeout if no host has answered yet,
  then continues yielding late-host enrichments until the iterator is broken or final emission.

```ts
softTimeoutMs?: number
```

#### Property unreachableHostNotificationCooldownMs

Minimum interval between unreachable notifications for the same host and
service. Defaults to 60 seconds to prevent notification storms. Set to 0
to disable deduplication.

```ts
unreachableHostNotificationCooldownMs?: number
```

#### Property waitForAllHosts

Wait for every queried host to settle before the first emission. This is
the default for `query()` because generic output cardinality is not proof
of freshness or authority. It defaults to `false` for progressive
`query$()` consumers. `holdForUnknownHosts` remains as a compatibility
alias; `waitForAllHosts` takes precedence when both are supplied.

```ts
waitForAllHosts?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupQuestion

The question asked to the Overlay Services Engine when a consumer of state wishes to look up information.

```ts
export interface LookupQuestion {
  service: string
  query: unknown
}
```

#### Property query

The query which will be forwarded to the Lookup Service.
Its type depends on that prescribed by the Lookup Service employed.

```ts
query: unknown
```

#### Property service

The identifier for a Lookup Service which the person asking the question wishes to use.

```ts
service: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupResolution

A lookup answer together with the host settlement evidence behind it.

```ts
export interface LookupResolution {
  answer: LookupAnswer
  progress: LookupAnswerProgress
}
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupAnswerProgress](./overlay-tools.md#interface-lookupanswerprogress)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: LookupResolverConfig

Configuration options for the Lookup resolver.

```ts
export interface LookupResolverConfig {
  networkPreset?: LookupNetworkPreset
  facilitator?: OverlayLookupFacilitator
  slapTrackers?: string[]
  hostOverrides?: Record<string, string[]>
  additionalHosts?: Record<string, string[]>
  cache?: CacheOptions
  reputationStorage?:
    | 'localStorage'
    | {
        get: (key: string) => string | null | undefined
        set: (key: string, value: string) => void
      }
  telemetry?: TelemetryConfig
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [OverlayLookupFacilitator](./overlay-tools.md#interface-overlaylookupfacilitator)

#### Property additionalHosts

Map of lookup service names to arrays of hosts to use in addition to resolving via SLAP.

```ts
additionalHosts?: Record<string, string[]>
```

#### Property cache

Optional cache tuning.

```ts
cache?: CacheOptions
```

#### Property facilitator

The facilitator used to make requests to Overlay Services hosts.

```ts
facilitator?: OverlayLookupFacilitator
```

See also: [OverlayLookupFacilitator](./overlay-tools.md#interface-overlaylookupfacilitator)

#### Property hostOverrides

Map of lookup service names to arrays of hosts to use in place of resolving via SLAP.

```ts
hostOverrides?: Record<string, string[]>
```

#### Property networkPreset

The network preset to use, unless other options override it.

- mainnet: use mainnet SLAP trackers and HTTPS facilitator
- testnet: use testnet SLAP trackers and HTTPS facilitator
- teratestnet: use TerraTestNet SLAP trackers and HTTPS facilitator
- local: directly query from localhost:8080 and a facilitator that permits plain HTTP

```ts
networkPreset?: LookupNetworkPreset
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset)

#### Property reputationStorage

Optional storage for host reputation data.

```ts
reputationStorage?: "localStorage" | {
    get: (key: string) => string | null | undefined;
    set: (key: string, value: string) => void;
}
```

#### Property slapTrackers

The list of SLAP trackers queried to resolve Overlay Services hosts for a given lookup service.

```ts
slapTrackers?: string[]
```

#### Property telemetry

Optional privacy-bounded telemetry sink. Query payloads are never emitted.

```ts
telemetry?: TelemetryConfig
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: OverlayBroadcastFacilitator

Facilitates transaction broadcasts that return STEAK.

```ts
export interface OverlayBroadcastFacilitator {
  send: (url: string, taggedBEEF: TaggedBEEF) => Promise<STEAK>
}
```

See also: [STEAK](./overlay-tools.md#type-steak), [TaggedBEEF](./overlay-tools.md#interface-taggedbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: OverlayLookupFacilitator

Facilitates lookups to URLs that return answers.

```ts
export interface OverlayLookupFacilitator {
  lookup: (
    url: string,
    question: LookupQuestion,
    timeout?: number
  ) => Promise<LookupFacilitatorAnswer>
}
```

See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion)

#### Property lookup

Returns a lookup answer for a lookup question

```ts
lookup: (url: string, question: LookupQuestion, timeout?: number) =>
  Promise<LookupFacilitatorAnswer>
```

See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: RankedHost

```ts
export interface RankedHost extends HostReputationEntry {
  score: number
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: SHIPBroadcasterConfig

Configuration options for the SHIP broadcaster.

```ts
export interface SHIPBroadcasterConfig {
  networkPreset?: LookupNetworkPreset
  facilitator?: OverlayBroadcastFacilitator
  resolver?: LookupResolver
  requireAcknowledgmentFromAllHostsForTopics?: TopicAcknowledgmentRequirement
  requireAcknowledgmentFromAnyHostForTopics?: TopicAcknowledgmentRequirement
  requireAcknowledgmentFromSpecificHostsForTopics?: Record<string, TopicAcknowledgmentRequirement>
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [LookupResolver](./overlay-tools.md#class-lookupresolver), [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator), [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement)

#### Property facilitator

The facilitator used to make requests to Overlay Services hosts.

```ts
facilitator?: OverlayBroadcastFacilitator
```

See also: [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator)

#### Property networkPreset

The network preset to use, unless other options override it.

- mainnet: use mainnet resolver and HTTPS facilitator
- testnet: use testnet resolver and HTTPS facilitator
- teratestnet: use TerraTestNet resolver and HTTPS facilitator
- local: directly send to localhost:8080 and a facilitator that permits plain HTTP

```ts
networkPreset?: LookupNetworkPreset
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset)

#### Property requireAcknowledgmentFromAllHostsForTopics

Determines which topics (all, any, or a specific list) must be present within all STEAKs received from every host for the broadcast to be considered a success. By default, all hosts must acknowledge all topics.

```ts
requireAcknowledgmentFromAllHostsForTopics?: TopicAcknowledgmentRequirement
```

See also: [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement)

#### Property requireAcknowledgmentFromAnyHostForTopics

Determines which topics (all, any, or a specific list) must be present within STEAK received from at least one host for the broadcast to be considered a success.

```ts
requireAcknowledgmentFromAnyHostForTopics?: TopicAcknowledgmentRequirement
```

See also: [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement)

#### Property requireAcknowledgmentFromSpecificHostsForTopics

Determines a mapping whose keys are specific hosts and whose values are the topics (all, any, or a specific list) that must be present within the STEAK received by the given hosts, in order for the broadcast to be considered a success.

```ts
requireAcknowledgmentFromSpecificHostsForTopics?: Record<string, TopicAcknowledgmentRequirement>
```

See also: [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement)

#### Property resolver

The resolver used to locate suitable hosts with SHIP

```ts
resolver?: LookupResolver
```

See also: [LookupResolver](./overlay-tools.md#class-lookupresolver)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: TaggedBEEF

Tagged BEEF

```ts
export interface TaggedBEEF {
  beef: number[]
  topics: string[]
  offChainValues?: number[]
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: UnreachableHostInfo

Info supplied to onUnreachableHost callbacks.

```ts
export interface UnreachableHostInfo {
  host: string
  service: string
  error: string
  advertisedBy?: string
}
```

#### Property advertisedBy

SLAP tracker URL that advertised this host, if known.

```ts
advertisedBy?: string
```

#### Property error

Error message from the facilitator.

```ts
error: string
```

#### Property host

Host URL that failed.

```ts
host: string
```

#### Property service

Lookup service that was being queried when the failure occurred.

```ts
service: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Classes

|                                                                             |
| --------------------------------------------------------------------------- |
| [HTTPSOverlayBroadcastFacilitator](#class-httpsoverlaybroadcastfacilitator) |
| [HTTPSOverlayLookupFacilitator](#class-httpsoverlaylookupfacilitator)       |
| [HostReputationTracker](#class-hostreputationtracker)                       |
| [LookupHTTPError](#class-lookuphttperror)                                   |
| [LookupResolver](#class-lookupresolver)                                     |
| [OverlayAdminTokenTemplate](#class-overlayadmintokentemplate)               |
| [TopicBroadcaster](#class-topicbroadcaster)                                 |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: HTTPSOverlayBroadcastFacilitator

```ts
export class HTTPSOverlayBroadcastFacilitator implements OverlayBroadcastFacilitator {
  httpClient: typeof fetch
  allowHTTP: boolean
  constructor(httpClient = fetch, allowHTTP: boolean = false)
  async send(url: string, taggedBEEF: TaggedBEEF): Promise<STEAK>
}
```

See also: [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator), [STEAK](./overlay-tools.md#type-steak), [TaggedBEEF](./overlay-tools.md#interface-taggedbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: HTTPSOverlayLookupFacilitator

```ts
export class HTTPSOverlayLookupFacilitator implements OverlayLookupFacilitator {
  fetchClient: typeof fetch
  allowHTTP: boolean
  constructor(httpClient = defaultFetch, allowHTTP: boolean = false)
  async lookup(
    url: string,
    question: LookupQuestion,
    timeout: number = 2000
  ): Promise<LookupFacilitatorAnswer>
}
```

See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [OverlayLookupFacilitator](./overlay-tools.md#interface-overlaylookupfacilitator)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: HostReputationTracker

```ts
export class HostReputationTracker {
  constructor(store?: KeyValueStore)
  reset(): void
  recordSuccess(host: string, latencyMs: number): void
  recordFailure(host: string, reason?: unknown): void
  rankHosts(hosts: string[], now: number = Date.now()): RankedHost[]
  snapshot(host: string): HostReputationEntry | undefined
  flush(): void
}
```

See also: [RankedHost](./overlay-tools.md#interface-rankedhost)

#### Method flush

Flushes a pending debounced persistence write immediately.

```ts
flush(): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: LookupHTTPError

An HTTP failure with enough classification for reputation handling.

```ts
export class LookupHTTPError extends Error {
  readonly status: number
  readonly kind: LookupHTTPErrorKind
  constructor(status: number, kind: LookupHTTPErrorKind, statusText?: string)
}
```

See also: [LookupHTTPErrorKind](./overlay-tools.md#type-lookuphttperrorkind)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: LookupResolver

Represents a Lookup Resolver.

```ts
export default class LookupResolver {
  constructor(config: LookupResolverConfig = {})
  async query(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupAnswer>
  async queryDetailed(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): Promise<LookupResolution>
  async *query$(
    question: LookupQuestion,
    timeout?: number,
    options?: LookupQueryOptions
  ): AsyncIterable<LookupAnswerProgress>
}
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupAnswerProgress](./overlay-tools.md#interface-lookupanswerprogress), [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupResolution](./overlay-tools.md#interface-lookupresolution), [LookupResolverConfig](./overlay-tools.md#interface-lookupresolverconfig)

#### Method query

Given a LookupQuestion, returns a LookupAnswer. Aggregates across multiple services and supports resiliency.

Optional `options.graceMs` overrides the per-call grace window (default 80 ms).
Optional `options.softTimeoutMs` resolves the query early with whatever has arrived once any host has
answered (or with an empty result if no host has answered by `softTimeoutMs`).

```ts
async query(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupAnswer>
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion)

#### Method queryDetailed

Performs a lookup and returns both its answer and the host settlement
evidence required by security-sensitive consumers to distinguish an
authoritative empty result from an availability failure.

```ts
async queryDetailed(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupResolution>
```

See also: [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupResolution](./overlay-tools.md#interface-lookupresolution)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: OverlayAdminTokenTemplate

Script template enabling the creation, unlocking, and decoding of SHIP and SLAP advertisements.

```ts
export default class OverlayAdminTokenTemplate implements ScriptTemplate {
  pushDrop: PushDrop
  static decode(script: LockingScript): {
    protocol: 'SHIP' | 'SLAP'
    identityKey: string
    domain: string
    topicOrService: string
  }
  constructor(wallet: WalletInterface, originator?: OriginatorDomainNameStringUnder250Bytes)
  async lock(
    protocol: 'SHIP' | 'SLAP',
    domain: string,
    topicOrService: string
  ): Promise<LockingScript>
  unlock(protocol: 'SHIP' | 'SLAP'): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  }
}
```

See also: [LockingScript](./script.md#class-lockingscript), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [PushDrop](./script.md#class-pushdrop), [ScriptTemplate](./script.md#interface-scripttemplate), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [WalletInterface](./wallet.md#interface-walletinterface), [sign](./compat.md#variable-sign)

#### Constructor

Constructs a new Overlay Admin template instance

```ts
constructor(wallet: WalletInterface, originator?: OriginatorDomainNameStringUnder250Bytes)
```

See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletInterface](./wallet.md#interface-walletinterface)

Argument Details

- **wallet**
  - Wallet to use for locking and unlocking

#### Method decode

Decodes a SHIP or SLAP advertisement from a given locking script.

```ts
static decode(script: LockingScript): {
    protocol: "SHIP" | "SLAP";
    identityKey: string;
    domain: string;
    topicOrService: string;
}
```

See also: [LockingScript](./script.md#class-lockingscript)

Returns

Decoded SHIP or SLAP advertisement

Argument Details

- **script**
  - Locking script comprising a SHIP or SLAP token to decode

#### Method lock

Creates a new advertisement locking script

```ts
async lock(protocol: "SHIP" | "SLAP", domain: string, topicOrService: string): Promise<LockingScript>
```

See also: [LockingScript](./script.md#class-lockingscript)

Returns

Locking script comprising the advertisement token

Argument Details

- **protocol**
  - SHIP or SLAP
- **domain**
  - Domain where the topic or service is available
- **topicOrService**
  - Topic or service to advertise

#### Method unlock

Unlocks an advertisement token as part of a transaction.

```ts
unlock(protocol: "SHIP" | "SLAP"): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
}
```

See also: [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

Returns

Script unlocker capable of unlocking the advertisement token

Argument Details

- **protocol**
  - SHIP or SLAP, depending on the token to unlock

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: TopicBroadcaster

Broadcasts transactions to one or more overlay topics.

```ts
export default class TopicBroadcaster implements Broadcaster {
  constructor(topics: string[], config: SHIPBroadcasterConfig = {})
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
}
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Broadcaster](./transaction.md#interface-broadcaster), [SHIPBroadcasterConfig](./overlay-tools.md#interface-shipbroadcasterconfig), [Transaction](./transaction.md#class-transaction)

#### Constructor

Constructs an instance of the SHIP broadcaster.

```ts
constructor(topics: string[], config: SHIPBroadcasterConfig = {})
```

See also: [SHIPBroadcasterConfig](./overlay-tools.md#interface-shipbroadcasterconfig)

Argument Details

- **topics**
  - The list of SHIP topic names where transactions are to be sent.
- **config**
  - Configuration options for the SHIP broadcaster.

#### Method broadcast

Broadcasts a transaction to Overlay Services via SHIP.

```ts
async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Transaction](./transaction.md#class-transaction)

Returns

A promise that resolves to either a success or failure response.

Argument Details

- **tx**
  - The transaction to be sent.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Functions

### Function: withDoubleSpendRetry

Executes an operation with automatic retry logic for double-spend errors.
When a double-spend is detected, broadcasts the competing transaction to
update the overlay with missing state, then retries the operation.

```ts
export async function withDoubleSpendRetry<T>(
  operation: () => Promise<T>,
  broadcaster: TopicBroadcaster,
  maxRetries: number = MAX_DOUBLE_SPEND_RETRIES
): Promise<T>
```

See also: [TopicBroadcaster](./overlay-tools.md#class-topicbroadcaster)

Returns

The result of the successful operation

Argument Details

- **operation**
  - The async operation to execute (e.g., createAction + signAction)
- **broadcaster**
  - The TopicBroadcaster to use for syncing missing state
- **maxRetries**
  - Maximum number of retry attempts (default: MAX_DOUBLE_SPEND_RETRIES)

Throws

If max retries exceeded or non-double-spend error occurs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Types

|                                                                        |
| ---------------------------------------------------------------------- |
| [LookupAnswer](#type-lookupanswer)                                     |
| [LookupEvidenceEvent](#type-lookupevidenceevent)                       |
| [LookupFacilitatorAnswer](#type-lookupfacilitatoranswer)               |
| [LookupHTTPErrorKind](#type-lookuphttperrorkind)                       |
| [LookupNetworkPreset](#type-lookupnetworkpreset)                       |
| [RequireMode](#type-requiremode)                                       |
| [STEAK](#type-steak)                                                   |
| [TopicAcknowledgmentRequirement](#type-topicacknowledgmentrequirement) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupAnswer

An aggregatable output-list answer returned by the resolver.

```ts
export type LookupAnswer = {
  type: 'output-list'
  outputs: Array<{
    beef: number[]
    outputIndex: number
    context?: number[]
    txid?: string
  }>
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupEvidenceEvent

Additive evidence intake, independent of the legacy aggregated answer.

```ts
export type LookupEvidenceEvent =
  | {
      type: 'output'
      host: string
      output: LookupAnswer['outputs'][number]
    }
  | {
      type: 'limit'
    }
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupFacilitatorAnswer

Responses a facilitator may return before the resolver aggregates them.

```ts
export type LookupFacilitatorAnswer = LookupAnswer | LookupFreeformAnswer
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupFreeformAnswer](./overlay-tools.md#interface-lookupfreeformanswer)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupHTTPErrorKind

```ts
export type LookupHTTPErrorKind = 'semantic' | 'availability'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupNetworkPreset

Public overlay network presets understood by lookup and SHIP routing.

```ts
export type LookupNetworkPreset = 'mainnet' | 'testnet' | 'teratestnet' | 'local'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: RequireMode

The require mode for topic acknowledgment: all topics must be present, or any one suffices.

```ts
export type RequireMode = 'all' | 'any'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: STEAK

Submitted Transaction Execution AcKnowledgment

```ts
export type STEAK = Record<string, AdmittanceInstructions>
```

See also: [AdmittanceInstructions](./overlay-tools.md#interface-admittanceinstructions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: TopicAcknowledgmentRequirement

Specifies which topics must be acknowledged: all, any, or a specific list.

```ts
export type TopicAcknowledgmentRequirement = RequireMode | string[]
```

See also: [RequireMode](./overlay-tools.md#type-requiremode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Enums

## Variables

|                                                                              |
| ---------------------------------------------------------------------------- |
| [DEFAULT_SLAP_TRACKERS](#variable-default_slap_trackers)                     |
| [DEFAULT_TESTNET_SLAP_TRACKERS](#variable-default_testnet_slap_trackers)     |
| [DEFAULT_TTN_SLAP_TRACKERS](#variable-default_ttn_slap_trackers)             |
| [getOverlayHostReputationTracker](#variable-getoverlayhostreputationtracker) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_SLAP_TRACKERS

```ts
DEFAULT_SLAP_TRACKERS: string[] = [
    "https://overlay-us-1.bsvb.tech",
    "https://overlay-eu-1.bsvb.tech",
    "https://overlay-ap-1.bsvb.tech",
    "https://users.bapp.dev"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_TESTNET_SLAP_TRACKERS

```ts
DEFAULT_TESTNET_SLAP_TRACKERS: string[] = [
    "https://testnet-users.bapp.dev"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_TTN_SLAP_TRACKERS

```ts
DEFAULT_TTN_SLAP_TRACKERS: string[] = [
    "https://staging-overlay.babbage.systems"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: getOverlayHostReputationTracker

```ts
getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
```

See also: [HostReputationTracker](./overlay-tools.md#class-hostreputationtracker)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
