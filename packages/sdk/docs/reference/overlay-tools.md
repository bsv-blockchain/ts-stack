# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| | |
| --- | --- |
| [AdmittanceInstructions](#interface-admittanceinstructions) | [LookupResolverConfig](#interface-lookupresolverconfig) |
| [LookupAnswerProgress](#interface-lookupanswerprogress) | [LookupResponseReaderOptions](#interface-lookupresponsereaderoptions) |
| [LookupDiscoveryUpdate](#interface-lookupdiscoveryupdate) | [OverlayBroadcastFacilitator](#interface-overlaybroadcastfacilitator) |
| [LookupFreeformAnswer](#interface-lookupfreeformanswer) | [OverlayDiscoveryAdvertisement](#interface-overlaydiscoveryadvertisement) |
| [LookupLimits](#interface-lookuplimits) | [OverlayLookupFacilitator](#interface-overlaylookupfacilitator) |
| [LookupQueryOptions](#interface-lookupqueryoptions) | [RankedHost](#interface-rankedhost) |
| [LookupQuestion](#interface-lookupquestion) | [SHIPBroadcasterConfig](#interface-shipbroadcasterconfig) |
| [LookupRequestOptions](#interface-lookuprequestoptions) | [TaggedBEEF](#interface-taggedbeef) |
| [LookupResolution](#interface-lookupresolution) | [UnreachableHostInfo](#interface-unreachablehostinfo) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: AdmittanceInstructions

Instructs the Overlay Services Engine about which outputs to admit and which previous outputs to retain. Returned by a Topic Manager.

```ts
export interface AdmittanceInstructions {
    outputsToAdmit: number[];
    coinsToRetain: number[];
    coinsRemoved?: number[];
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
    discoveryComplete?: boolean;
    terminalReason?: "settled" | "deadline" | "cancelled" | "resource-limit";
    discoveredHosts?: number;
    skippedHosts?: number;
    receivedBytes?: number;
    retainedBytes?: number;
    evidenceBytes?: number;
    trackersTotal?: number;
    trackersCompleted?: number;
    trackersFailed?: number;
    limitsHit?: string[];
    type: "output-list";
    outputs: Array<{
        beef: number[];
        outputIndex: number;
        context?: number[];
        txid?: string;
    }>;
    txIds: string[];
    isFinal: boolean;
    hostCount: number;
    completedHosts: number;
    successfulHosts: number;
    emptyHosts: number;
    failedHosts: number;
    rejectedHosts: number;
    freeformHosts: number;
    correlationId?: string;
}
```

See also: [string](./remittance.md#function-string)

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
See also: [string](./remittance.md#function-string)

#### Property discoveryComplete

Transport coverage only, never cryptographic validity or global absence.

```ts
discoveryComplete?: boolean
```

#### Property emptyHosts

Successful hosts whose output list was empty.

```ts
emptyHosts: number
```

#### Property evidenceBytes

Receipt-copy octets handed to onEvidence, independently bounded.

```ts
evidenceBytes?: number
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

#### Property retainedBytes

Retained decoded BEEF/context octets; JavaScript arrays have additional heap overhead.

```ts
retainedBytes?: number
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
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupDiscoveryUpdate

```ts
export interface LookupDiscoveryUpdate {
    sources: Map<string, string[]>;
    trackersTotal: number;
    trackersCompleted: number;
    trackersFailed: number;
    skippedHosts: number;
    receivedBytes: number;
    limitsHit: Set<string>;
    done: boolean;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupFreeformAnswer

A valid non-aggregatable response returned by a lookup service.

```ts
export interface LookupFreeformAnswer {
    type: "freeform";
    result: unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupLimits

Operational client limits, not BEEF validity or service authority rules.

```ts
export interface LookupLimits {
    maxHosts: number;
    maxHostsPerTracker: number;
    maxTrackers: number;
    hostConcurrency: number;
    trackerConcurrency: number;
    maxResponseBytes: number;
    maxTotalBytes: number;
    maxOutputs: number;
    maxEvidenceOutputs: number;
    maxEvidenceBytes: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupQueryOptions

```ts
export interface LookupQueryOptions {
    signal?: AbortSignal;
    evidenceLimits?: {
        maxOutputs?: number;
        maxBytes?: number;
    };
    deadlineMs?: number;
    limits?: Partial<LookupLimits>;
    onEvidence?: (event: LookupEvidenceEvent) => void | Promise<void>;
    graceMs?: number;
    softTimeoutMs?: number;
    onUnreachableHost?: (info: UnreachableHostInfo) => void | Promise<void>;
    unreachableHostNotificationCooldownMs?: number;
    holdForUnknownHosts?: boolean;
    waitForAllHosts?: boolean;
    correlationId?: string;
}
```

See also: [LookupEvidenceEvent](./overlay-tools.md#type-lookupevidenceevent), [LookupLimits](./overlay-tools.md#interface-lookuplimits), [UnreachableHostInfo](./overlay-tools.md#interface-unreachablehostinfo), [string](./remittance.md#function-string)

#### Property correlationId

Correlates resolver and downstream wallet telemetry without logging the query payload.

```ts
correlationId?: string
```
See also: [string](./remittance.md#function-string)

#### Property deadlineMs

Whole attempt budget including discovery and queued hosts. Default 10000 ms.

```ts
deadlineMs?: number
```

#### Property evidenceLimits

Callback intake budget, independent of legacy aggregation. Defaults to 512
outputs / 16 MiB of BEEF and context bytes. Values must be positive safe
integers. Coordinate these with a downstream verifier's admission limits.
Precedence when both this and `limits.maxEvidenceOutputs`/`maxEvidenceBytes`
are supplied for the same call: `evidenceLimits` wins, then `limits`, then
the resolver's configured limits, then the library defaults.

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

#### Property limits

Per-query operational resource limits (discovery, transport and queueing
bounds). `limits.maxEvidenceOutputs`/`maxEvidenceBytes` also set the
evidence intake budget, but the `evidenceLimits` shorthand above takes
precedence over these two fields when both are supplied.

```ts
limits?: Partial<LookupLimits>
```
See also: [LookupLimits](./overlay-tools.md#interface-lookuplimits)

#### Property onEvidence

Owned, UNTRUSTED receipts before legacy txid/outpoint deduplication. Enqueue
promptly; callback completion is not awaited and failures are isolated.
Intake stops at the configured evidenceLimits, reporting one limit event.
No callbacks occur after the query iterator closes. Raw `query$` snapshots
remain unverified transport aggregates, not cryptographic proof.

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

#### Property signal

Abort this query without cancelling discovery still owned by another query.
`query()` and `queryDetailed()` reject with an `AbortError` once this
signal fires: a cancelled attempt never answered the question, so it is
never reported as an empty output list. `query$()` keeps emitting its
terminal snapshot with `terminalReason: 'cancelled'` instead.

```ts
signal?: AbortSignal
```

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
    service: string;
    query: unknown;
}
```

See also: [string](./remittance.md#function-string)

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
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupRequestOptions

Optional bounded transport settings; older custom facilitators may ignore these.

```ts
export interface LookupRequestOptions {
    maxResponseBytes?: number;
    maxOutputs?: number;
    consumeBytes?: (bytes: number) => void;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupResolution

A lookup answer together with the host settlement evidence behind it.

```ts
export interface LookupResolution {
    answer: LookupAnswer;
    progress: LookupAnswerProgress;
}
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupAnswerProgress](./overlay-tools.md#interface-lookupanswerprogress)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupResolverConfig

Configuration options for the Lookup resolver.

```ts
export interface LookupResolverConfig {
    limits?: Partial<LookupLimits>;
    networkPreset?: LookupNetworkPreset;
    facilitator?: OverlayLookupFacilitator;
    slapTrackers?: string[];
    hostOverrides?: Record<string, string[]>;
    additionalHosts?: Record<string, string[]>;
    cache?: CacheOptions;
    reputationStorage?: "localStorage" | {
        get: (key: string) => string | null | undefined;
        set: (key: string, value: string) => void;
    };
    telemetry?: TelemetryConfig;
}
```

See also: [LookupLimits](./overlay-tools.md#interface-lookuplimits), [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [OverlayLookupFacilitator](./overlay-tools.md#interface-overlaylookupfacilitator), [string](./remittance.md#function-string)

#### Property additionalHosts

Map of lookup service names to arrays of hosts to use in addition to resolving via SLAP.

```ts
additionalHosts?: Record<string, string[]>
```
See also: [string](./remittance.md#function-string)

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
See also: [string](./remittance.md#function-string)

#### Property limits

Defaults for the bounded discovery, scheduler and receipt intake.

```ts
limits?: Partial<LookupLimits>
```
See also: [LookupLimits](./overlay-tools.md#interface-lookuplimits)

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
See also: [string](./remittance.md#function-string)

#### Property slapTrackers

The list of SLAP trackers queried to resolve Overlay Services hosts for a
given lookup service. Signed advertisement fields are authenticated
locally, but these trackers remain authoritative for current/unspent
advertisement state and must be selected accordingly.

```ts
slapTrackers?: string[]
```
See also: [string](./remittance.md#function-string)

#### Property telemetry

Optional privacy-bounded telemetry sink. Query payloads are never emitted.

```ts
telemetry?: TelemetryConfig
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LookupResponseReaderOptions

Options controlling a bounded lookup response read.

```ts
export interface LookupResponseReaderOptions {
    signal?: AbortSignal;
    maxResponseBytes: number;
    consumeBytes?: (bytes: number) => void;
}
```

#### Property consumeBytes

Charges accepted bytes to the caller's aggregate response budget.

```ts
consumeBytes?: (bytes: number) => void
```

#### Property maxResponseBytes

Maximum number of response bytes to retain.

```ts
maxResponseBytes: number
```

#### Property signal

Cancels a pending stream read when the lookup request is aborted.

```ts
signal?: AbortSignal
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: OverlayBroadcastFacilitator

Facilitates transaction broadcasts that return STEAK.

```ts
export interface OverlayBroadcastFacilitator {
    send: (url: string, taggedBEEF: TaggedBEEF) => Promise<STEAK>;
}
```

See also: [STEAK](./overlay-tools.md#type-steak), [TaggedBEEF](./overlay-tools.md#interface-taggedbeef), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: OverlayDiscoveryAdvertisement

```ts
export interface OverlayDiscoveryAdvertisement {
    protocol: OverlayDiscoveryProtocol;
    identityKey: string;
    domain: string;
    topicOrService: string;
}
```

See also: [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: OverlayLookupFacilitator

Facilitates lookups to URLs that return answers.

```ts
export interface OverlayLookupFacilitator {
    lookup: (url: string, question: LookupQuestion, timeout?: number, signal?: AbortSignal, options?: LookupRequestOptions) => Promise<LookupFacilitatorAnswer>;
}
```

See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupRequestOptions](./overlay-tools.md#interface-lookuprequestoptions), [string](./remittance.md#function-string)

#### Property lookup

Returns a lookup answer for a lookup question

```ts
lookup: (url: string, question: LookupQuestion, timeout?: number, signal?: AbortSignal, options?: LookupRequestOptions) => Promise<LookupFacilitatorAnswer>
```
See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupRequestOptions](./overlay-tools.md#interface-lookuprequestoptions), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RankedHost

```ts
export interface RankedHost extends HostReputationEntry {
    score: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SHIPBroadcasterConfig

Configuration options for the SHIP broadcaster.

```ts
export interface SHIPBroadcasterConfig {
    networkPreset?: LookupNetworkPreset;
    facilitator?: OverlayBroadcastFacilitator;
    resolver?: LookupResolver;
    requireAcknowledgmentFromAllHostsForTopics?: TopicAcknowledgmentRequirement;
    requireAcknowledgmentFromAnyHostForTopics?: TopicAcknowledgmentRequirement;
    requireAcknowledgmentFromSpecificHostsForTopics?: Record<string, TopicAcknowledgmentRequirement>;
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [LookupResolver](./overlay-tools.md#class-lookupresolver), [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator), [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement), [string](./remittance.md#function-string)

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
See also: [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement), [string](./remittance.md#function-string)

#### Property resolver

The resolver used to locate suitable hosts with SHIP. Advertisement
authorship is verified locally, but this resolver's trackers remain the
authority for whether a signed advertisement is current and unspent.

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
    beef: number[];
    topics: string[];
    offChainValues?: number[];
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: UnreachableHostInfo

Info supplied to onUnreachableHost callbacks.

```ts
export interface UnreachableHostInfo {
    host: string;
    service: string;
    error: string;
    advertisedBy?: string;
}
```

See also: [string](./remittance.md#function-string)

#### Property advertisedBy

SLAP tracker URL that advertised this host, if known.

```ts
advertisedBy?: string
```
See also: [string](./remittance.md#function-string)

#### Property error

Error message from the facilitator.

```ts
error: string
```
See also: [string](./remittance.md#function-string)

#### Property host

Host URL that failed.

```ts
host: string
```
See also: [string](./remittance.md#function-string)

#### Property service

Lookup service that was being queried when the failure occurred.

```ts
service: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [HTTPSOverlayBroadcastFacilitator](#class-httpsoverlaybroadcastfacilitator) |
| [HTTPSOverlayLookupFacilitator](#class-httpsoverlaylookupfacilitator) |
| [HostReputationTracker](#class-hostreputationtracker) |
| [LookupDiscovery](#class-lookupdiscovery) |
| [LookupHTTPError](#class-lookuphttperror) |
| [LookupHostQueue](#class-lookuphostqueue) |
| [LookupResolver](#class-lookupresolver) |
| [LookupResourceLimitError](#class-lookupresourcelimiterror) |
| [OverlayAdminTokenTemplate](#class-overlayadmintokentemplate) |
| [TopicBroadcaster](#class-topicbroadcaster) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: HTTPSOverlayBroadcastFacilitator

```ts
export class HTTPSOverlayBroadcastFacilitator implements OverlayBroadcastFacilitator {
    httpClient: typeof fetch;
    allowHTTP: boolean;
    constructor(httpClient?: typeof fetch, allowHTTP: boolean = false)
    async send(url: string, taggedBEEF: TaggedBEEF): Promise<STEAK>
}
```

See also: [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator), [STEAK](./overlay-tools.md#type-steak), [TaggedBEEF](./overlay-tools.md#interface-taggedbeef), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: HTTPSOverlayLookupFacilitator

```ts
export class HTTPSOverlayLookupFacilitator implements OverlayLookupFacilitator {
    fetchClient: typeof fetch;
    allowHTTP: boolean;
    constructor(httpClient?: typeof fetch, allowHTTP: boolean = false)
    async lookup(url: string, question: LookupQuestion, timeout: number = 2000, signal?: AbortSignal, options?: LookupRequestOptions): Promise<LookupFacilitatorAnswer>
}
```

See also: [LookupFacilitatorAnswer](./overlay-tools.md#type-lookupfacilitatoranswer), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupRequestOptions](./overlay-tools.md#interface-lookuprequestoptions), [OverlayLookupFacilitator](./overlay-tools.md#interface-overlaylookupfacilitator), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: HostReputationTracker

Bounded availability/latency hints for ordering an already-authorized host
set. Reputation never authenticates a host and must not add a routing target
or replace advertisement, transport, or response verification.

```ts
export class HostReputationTracker {
    readonly #stats: Map<string, HostReputationEntry>;
    readonly #store: KeyValueStore | undefined;
    #saveTimer: ReturnType<typeof setTimeout> | null = null;
    constructor(store?: KeyValueStore)
    reset(): void
    recordSuccess(host: string, latencyMs: number): void
    recordFailure(host: string, reason?: unknown): void
    rankHosts(hosts: string[], now: number = Date.now()): RankedHost[]
    snapshot(host: string): HostReputationEntry | undefined
    flush(): void
    #getStorage(): any
    #getLocalStorageAdapter(): KeyValueStore | undefined
    #readStoredReputation(store: KeyValueStore): string | undefined
    #parseStoredEntry(key: string, value: unknown, now: number): HostReputationEntry | undefined
    #loadFromStorage(): void
    #scheduleSave(): void
    #saveToStorage(): void
    #computeScore(entry: HostReputationEntry, now: number): number
    #getOrCreate(host: string): HostReputationEntry
    #prune(now: number): void
    #evictOldestEntry(): void
}
```

See also: [RankedHost](./overlay-tools.md#interface-rankedhost), [string](./remittance.md#function-string)

#### Method flush

Flushes a pending debounced persistence write immediately.

```ts
flush(): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LookupDiscovery

One bounded refresh shared only by subscribers of the same resolver/configuration.

```ts
export class LookupDiscovery {
    readonly controller = new AbortController();
    readonly state: LookupDiscoveryUpdate;
    constructor(private readonly trackers: string[], private readonly limits: LookupLimits, private readonly lookup: (tracker: string, signal: AbortSignal, consume: (bytes: number) => void) => Promise<string[]>, private readonly finish: (state: LookupDiscoveryUpdate, abandoned: boolean) => void)
    subscribe(listener: (state: LookupDiscoveryUpdate) => void): () => void
}
```

See also: [LookupDiscoveryUpdate](./overlay-tools.md#interface-lookupdiscoveryupdate), [LookupLimits](./overlay-tools.md#interface-lookuplimits), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LookupHTTPError

An HTTP failure with enough classification for reputation handling.

```ts
export class LookupHTTPError extends Error {
    readonly status: number;
    readonly kind: LookupHTTPErrorKind;
    constructor(status: number, kind: LookupHTTPErrorKind, statusText?: string)
}
```

See also: [LookupHTTPErrorKind](./overlay-tools.md#type-lookuphttperrorkind), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LookupHostQueue

A bounded FIFO within each source, round-robin between sources.

```ts
export class LookupHostQueue {
    readonly done = new Promise<void>(resolve => { this.resolveDone = resolve; });
    constructor(private readonly maxHosts: number, private readonly concurrency: number, private readonly run: (host: string) => Promise<void>, private readonly skipped: (count: number, limited: boolean) => void)
    add(source: string, hosts: string[]): void
    finishSources(): void
    cancel(): void
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LookupResolver

Represents a Lookup Resolver.

```ts
export default class LookupResolver {
    constructor(config: LookupResolverConfig = {})
    async query(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupAnswer>
    async queryDetailed(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupResolution>
    query$(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): AsyncIterable<LookupAnswerProgress>
}
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupAnswerProgress](./overlay-tools.md#interface-lookupanswerprogress), [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupResolution](./overlay-tools.md#interface-lookupresolution), [LookupResolverConfig](./overlay-tools.md#interface-lookupresolverconfig)

#### Method query

Given a LookupQuestion, returns a LookupAnswer. Aggregates across multiple services and supports resiliency.

Optional `options.graceMs` overrides the per-call grace window (default 80 ms).
Optional `options.softTimeoutMs` resolves the query early with whatever has arrived once any host has
answered (or with an empty result if no host has answered by `softTimeoutMs`).

Throws an `AbortError` when `options.signal` aborted the attempt, so a
cancelled lookup is never mistaken for an authoritative empty answer.

```ts
async query(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupAnswer>
```
See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion)

#### Method query$

Cumulative unverified results. Discovery remains subscribed while trackers
settle; each new host enters the bounded queue immediately. Caller abort,
deadline and iterator close release this query's ownership.

```ts
query$(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): AsyncIterable<LookupAnswerProgress>
```
See also: [LookupAnswerProgress](./overlay-tools.md#interface-lookupanswerprogress), [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion)

#### Method queryDetailed

Performs a lookup and returns both its answer and the host settlement
evidence required by security-sensitive consumers to distinguish an
authoritative empty result from an availability failure.

Throws an `AbortError` when `options.signal` aborted the attempt, rather
than returning a resolution whose empty answer would have to be
re-qualified against `progress.terminalReason`. When a client resource
budget was exhausted during SLAP discovery, before any host could be
admitted, it throws `LookupResourceLimitError` naming that limit; the
historical no-competent-hosts error is reserved for a deadline or a
settled attempt that genuinely found no host.

```ts
async queryDetailed(question: LookupQuestion, timeout?: number, options?: LookupQueryOptions): Promise<LookupResolution>
```
See also: [LookupQueryOptions](./overlay-tools.md#interface-lookupqueryoptions), [LookupQuestion](./overlay-tools.md#interface-lookupquestion), [LookupResolution](./overlay-tools.md#interface-lookupresolution)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LookupResourceLimitError

```ts
export class LookupResourceLimitError extends Error {
    constructor(readonly limit: string)
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: OverlayAdminTokenTemplate

Script template enabling the creation, unlocking, and decoding of SHIP and SLAP advertisements.

```ts
export default class OverlayAdminTokenTemplate implements ScriptTemplate {
    pushDrop: PushDrop;
    static decode(script: LockingScript): OverlayDiscoveryAdvertisement
    static async decodeAndVerify(script: LockingScript, expectedProtocol?: OverlayDiscoveryProtocol): Promise<OverlayDiscoveryAdvertisement>
    constructor(wallet: WalletInterface, originator?: OriginatorDomainNameStringUnder250Bytes)
    async lock(protocol: OverlayDiscoveryProtocol, domain: string, topicOrService: string): Promise<LockingScript>
    unlock(protocol: OverlayDiscoveryProtocol): {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
    }
}
```

See also: [LockingScript](./script.md#class-lockingscript), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OverlayDiscoveryAdvertisement](./overlay-tools.md#interface-overlaydiscoveryadvertisement), [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol), [PushDrop](./script.md#class-pushdrop), [ScriptTemplate](./script.md#interface-scripttemplate), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [WalletInterface](./wallet.md#interface-walletinterface), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string)

#### Constructor

Constructs a new Overlay Admin template instance

```ts
constructor(wallet: WalletInterface, originator?: OriginatorDomainNameStringUnder250Bytes)
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletInterface](./wallet.md#interface-walletinterface)

Argument Details

+ **wallet**
  + Wallet to use for locking and unlocking

#### Method decode

```ts
static decode(script: LockingScript): OverlayDiscoveryAdvertisement
```
See also: [LockingScript](./script.md#class-lockingscript), [OverlayDiscoveryAdvertisement](./overlay-tools.md#interface-overlaydiscoveryadvertisement)

Returns

Structurally valid but not yet authenticated advertisement data

Argument Details

+ **script**
  + Locking script comprising a SHIP or SLAP token to decode

#### Method decodeAndVerify

Decodes and cryptographically authenticates a canonical advertisement,
including its claimed identity, field signature, and BRC-48 locking key.
This proves authorship of the advertised fields, not current UTXO status;
the configured discovery trackers remain authoritative for whether the
advertisement is active and unspent.

```ts
static async decodeAndVerify(script: LockingScript, expectedProtocol?: OverlayDiscoveryProtocol): Promise<OverlayDiscoveryAdvertisement>
```
See also: [LockingScript](./script.md#class-lockingscript), [OverlayDiscoveryAdvertisement](./overlay-tools.md#interface-overlaydiscoveryadvertisement), [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol)

#### Method lock

Creates a new canonical, publicly verifiable advertisement locking script.

```ts
async lock(protocol: OverlayDiscoveryProtocol, domain: string, topicOrService: string): Promise<LockingScript>
```
See also: [LockingScript](./script.md#class-lockingscript), [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol), [string](./remittance.md#function-string)

Returns

Locking script comprising the advertisement token

Argument Details

+ **protocol**
  + SHIP or SLAP
+ **domain**
  + Advertisable URI where the topic or service is available
+ **topicOrService**
  + Canonical topic or service name to advertise

#### Method unlock

Unlocks a canonical advertisement or an advertisement created by the
legacy SDK template. Legacy compatibility is limited to spending: legacy
advertisements were not publicly verifiable and remain ineligible for
authenticated discovery.

```ts
unlock(protocol: OverlayDiscoveryProtocol): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
}
```
See also: [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol), [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign)

Returns

Script unlocker capable of unlocking the advertisement token

Argument Details

+ **protocol**
  + SHIP or SLAP, depending on the token to unlock

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: TopicBroadcaster

Broadcasts transactions to one or more overlay topics.

```ts
export default class TopicBroadcaster implements Broadcaster {
    readonly #facilitator: OverlayBroadcastFacilitator;
    readonly #resolver: LookupResolver;
    readonly #requireAcknowledgmentFromAllHostsForTopics: TopicAcknowledgmentRequirement;
    readonly #requireAcknowledgmentFromAnyHostForTopics: TopicAcknowledgmentRequirement;
    readonly #requireAcknowledgmentFromSpecificHostsForTopics: Record<string, TopicAcknowledgmentRequirement>;
    readonly #networkPreset: LookupNetworkPreset;
    #interestedHostsCache: {
        hosts: Record<string, Set<string>>;
        expiresAt: number;
    } | null = null;
    #interestedHostsInFlight: Promise<Record<string, Set<string>>> | null = null;
    readonly #interestedHostsTtlMs: number;
    constructor(topics: string[], config: SHIPBroadcasterConfig = {})
    async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
    #resolveAllHostsRequirement(): {
        requiredTopics: string[];
        require: RequireMode;
    }
    #resolveAnyHostRequirement(): {
        requiredTopics: string[];
        require: RequireMode;
    }
    #checkAnyHostRequirement(hostAcknowledgments: Record<string, Set<string>>): BroadcastFailure | null
    #topicsMatchRequirement(acknowledgedTopics: Set<string>, requiredTopics: string[], require: RequireMode): boolean
}
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Broadcaster](./transaction.md#interface-broadcaster), [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [LookupResolver](./overlay-tools.md#class-lookupresolver), [OverlayBroadcastFacilitator](./overlay-tools.md#interface-overlaybroadcastfacilitator), [RequireMode](./overlay-tools.md#type-requiremode), [SHIPBroadcasterConfig](./overlay-tools.md#interface-shipbroadcasterconfig), [TopicAcknowledgmentRequirement](./overlay-tools.md#type-topicacknowledgmentrequirement), [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

#### Constructor

Constructs an instance of the SHIP broadcaster.

```ts
constructor(topics: string[], config: SHIPBroadcasterConfig = {})
```
See also: [SHIPBroadcasterConfig](./overlay-tools.md#interface-shipbroadcasterconfig), [string](./remittance.md#function-string)

Argument Details

+ **topics**
  + The list of SHIP topic names where transactions are to be sent.
+ **config**
  + Configuration options for the SHIP broadcaster.

#### Method

Resolves the (requiredTopics, require) pair for requireAcknowledgmentFromAllHostsForTopics.

```ts
#resolveAllHostsRequirement(): {
    requiredTopics: string[];
    require: RequireMode;
}
```
See also: [RequireMode](./overlay-tools.md#type-requiremode), [string](./remittance.md#function-string)

#### Method

Resolves the (requiredTopics, require) pair for requireAcknowledgmentFromAnyHostForTopics.

```ts
#resolveAnyHostRequirement(): {
    requiredTopics: string[];
    require: RequireMode;
}
```
See also: [RequireMode](./overlay-tools.md#type-requiremode), [string](./remittance.md#function-string)

#### Method

Returns true if `acknowledgedTopics` satisfies the given requirement against `requiredTopics`.

```ts
#topicsMatchRequirement(acknowledgedTopics: Set<string>, requiredTopics: string[], require: RequireMode): boolean
```
See also: [RequireMode](./overlay-tools.md#type-requiremode), [string](./remittance.md#function-string)

#### Method broadcast

Broadcasts a transaction to Overlay Services via SHIP.

```ts
async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
```
See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Transaction](./transaction.md#class-transaction)

Returns

A promise that resolves to either a success or failure response.

Argument Details

+ **tx**
  + The transaction to be sent.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| |
| --- |
| [decodeAndVerifyOverlayAdvertisement](#function-decodeandverifyoverlayadvertisement) |
| [lookupAbortError](#function-lookupaborterror) |
| [lookupLimits](#function-lookuplimits) |
| [normalizeLookupHost](#function-normalizelookuphost) |
| [readLookupResponseBytes](#function-readlookupresponsebytes) |
| [withDoubleSpendRetry](#function-withdoublespendretry) |
| [withLookupAbort](#function-withlookupabort) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: decodeAndVerifyOverlayAdvertisement

Decode and authenticate a canonical SHIP or SLAP advertisement.

```ts
export async function decodeAndVerifyOverlayAdvertisement(script: LockingScript, expectedProtocol?: OverlayDiscoveryProtocol): Promise<OverlayDiscoveryAdvertisement>
```

See also: [LockingScript](./script.md#class-lockingscript), [OverlayDiscoveryAdvertisement](./overlay-tools.md#interface-overlaydiscoveryadvertisement), [OverlayDiscoveryProtocol](./overlay-tools.md#type-overlaydiscoveryprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: lookupAbortError

```ts
export function lookupAbortError(): Error
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: lookupLimits

```ts
export function lookupLimits(...overrides: Array<Partial<LookupLimits> | undefined>): LookupLimits
```

See also: [LookupLimits](./overlay-tools.md#interface-lookuplimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeLookupHost

Preserve distinct paths and ports; remove only a final slash and URL fragments.

```ts
export function normalizeLookupHost(host: string, allowParameters: boolean = false): string | null
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: readLookupResponseBytes

Reads a lookup response incrementally while enforcing a per-response bound.

This deliberately does not use Response.text(), json(), or arrayBuffer(),
because those APIs buffer the complete body before a limit can be enforced.

```ts
export async function readLookupResponseBytes(response: Response, options: LookupResponseReaderOptions): Promise<Uint8Array>
```

See also: [LookupResponseReaderOptions](./overlay-tools.md#interface-lookupresponsereaderoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: withDoubleSpendRetry

Executes an operation with bounded retry logic for authenticated wallet
double-spend errors. Before retrying, every reported competing transaction is
parsed from bounded owned BEEF, bound to its txid, and successfully
acknowledged by the supplied overlay broadcaster.

`operation` must be safe to invoke again after throwing a review error. The
helper never retries malformed/name-spoofed errors and never retries when
conflict synchronization fails.

```ts
export async function withDoubleSpendRetry<T>(operation: () => Promise<T>, broadcaster: TopicBroadcaster, maxRetries: number = MAX_DOUBLE_SPEND_RETRIES): Promise<T>
```

See also: [TopicBroadcaster](./overlay-tools.md#class-topicbroadcaster)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: withLookupAbort

A non-cooperative transport cannot retain a cancelled waiter.

```ts
export async function withLookupAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

| |
| --- |
| [LookupAnswer](#type-lookupanswer) |
| [LookupEvidenceEvent](#type-lookupevidenceevent) |
| [LookupFacilitatorAnswer](#type-lookupfacilitatoranswer) |
| [LookupHTTPErrorKind](#type-lookuphttperrorkind) |
| [LookupNetworkPreset](#type-lookupnetworkpreset) |
| [OverlayDiscoveryProtocol](#type-overlaydiscoveryprotocol) |
| [RequireMode](#type-requiremode) |
| [STEAK](#type-steak) |
| [TopicAcknowledgmentRequirement](#type-topicacknowledgmentrequirement) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: LookupAnswer

An aggregatable output-list answer returned by the resolver.

```ts
export type LookupAnswer = {
    type: "output-list";
    outputs: Array<{
        beef: number[];
        outputIndex: number;
        context?: number[];
        txid?: string;
    }>;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: LookupEvidenceEvent

Additive evidence intake, independent of the legacy aggregated answer.

```ts
export type LookupEvidenceEvent = {
    type: "output";
    host: string;
    output: LookupAnswer["outputs"][number];
} | {
    type: "limit";
}
```

See also: [LookupAnswer](./overlay-tools.md#type-lookupanswer), [string](./remittance.md#function-string)

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
export type LookupHTTPErrorKind = "semantic" | "availability"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: LookupNetworkPreset

Public overlay network presets understood by lookup and SHIP routing.

```ts
export type LookupNetworkPreset = "mainnet" | "testnet" | "teratestnet" | "local"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: OverlayDiscoveryProtocol

```ts
export type OverlayDiscoveryProtocol = "SHIP" | "SLAP"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: RequireMode

The require mode for topic acknowledgment: all topics must be present, or any one suffices.

```ts
export type RequireMode = "all" | "any"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: STEAK

Submitted Transaction Execution AcKnowledgment

```ts
export type STEAK = Record<string, AdmittanceInstructions>
```

See also: [AdmittanceInstructions](./overlay-tools.md#interface-admittanceinstructions), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: TopicAcknowledgmentRequirement

Specifies which topics must be acknowledged: all, any, or a specific list.

```ts
export type TopicAcknowledgmentRequirement = RequireMode | string[]
```

See also: [RequireMode](./overlay-tools.md#type-requiremode), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

## Variables

| |
| --- |
| [DEFAULT_LOOKUP_LIMITS](#variable-default_lookup_limits) |
| [DEFAULT_SLAP_TRACKERS](#variable-default_slap_trackers) |
| [DEFAULT_TESTNET_SLAP_TRACKERS](#variable-default_testnet_slap_trackers) |
| [DEFAULT_TTN_SLAP_TRACKERS](#variable-default_ttn_slap_trackers) |
| [getOverlayHostReputationTracker](#variable-getoverlayhostreputationtracker) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_LOOKUP_LIMITS

```ts
DEFAULT_LOOKUP_LIMITS: Readonly<LookupLimits> = Object.freeze({
    maxHosts: 256,
    maxHostsPerTracker: 64,
    maxTrackers: 16,
    hostConcurrency: 8,
    trackerConcurrency: 4,
    maxResponseBytes: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxOutputs: 4096,
    maxEvidenceOutputs: 512,
    maxEvidenceBytes: 16 * 1024 * 1024
})
```

See also: [LookupLimits](./overlay-tools.md#interface-lookuplimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_SLAP_TRACKERS

```ts
DEFAULT_SLAP_TRACKERS: string[] = Object.freeze([
    "https://overlay-us-1.bsvb.tech",
    "https://overlay-eu-1.bsvb.tech",
    "https://overlay-ap-1.bsvb.tech",
    "https://users.bapp.dev"
] as string[]) as unknown as string[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_TESTNET_SLAP_TRACKERS

```ts
DEFAULT_TESTNET_SLAP_TRACKERS: string[] = Object.freeze([
    "https://testnet-users.bapp.dev"
] as string[]) as unknown as string[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_TTN_SLAP_TRACKERS

```ts
DEFAULT_TTN_SLAP_TRACKERS: string[] = Object.freeze([
    "https://staging-overlay.babbage.systems"
] as string[]) as unknown as string[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: getOverlayHostReputationTracker

```ts
getOverlayHostReputationTracker = (): HostReputationTracker => globalTracker
```

See also: [HostReputationTracker](./overlay-tools.md#class-hostreputationtracker)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
