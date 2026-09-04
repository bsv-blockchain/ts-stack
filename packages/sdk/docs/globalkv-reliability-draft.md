# GlobalKVStore reliability proposal — unapproved, not ready for deployment

This is a local investigation and opt-in implementation proposal, based on
`98734b07cf` (2026-09-04). Nothing here authorizes merging, publishing, deployment,
changing discovery, or removing existing consumer overrides. The legacy path is
retained for compatibility and as an executable reproduction of the defect.

## Proven failure sequence

`LookupResolver.poison-reproduction.test.ts` uses synthetic storage and two
in-process hosts. A future `backoffUntil` excludes a working host entirely. An
empty peer then produces an empty answer. Resetting only the synthetic tracker
immediately restores the data without changing the query or host behavior.
Both assertions pass against the unchanged legacy implementation. A third test
uses only normal `recordFailure`/`flush` calls with a temporarily advanced browser
clock; correcting the clock and reloading turns the generated penalty into more
than 300 days of exclusion.

The root cause spans several shared boundaries:

1. `HostReputationTracker` loads v3, falling back to v2/v1. It coerces numbers
   instead of validating their bounds. TTL only removes sufficiently old,
   positive update times. Future timestamps survive. The nominal generated
   cooldown cap is 60 seconds, but imported cooldowns have no cap. Counters do
   not decay. The 256-entry, 30-day pruning does not repair these timestamps.
2. Its singleton keys entries by host only. Network, lookup service, SHIP and
   SLAP use no independent reputation scope. All failures except semantic HTTP
   errors share exponential backoff; some fetch/DNS strings skip its grace.
3. `prepareHostsForQuery` absolutely excludes backoff entries. No successful
   request can rehabilitate a host that is never contacted. All-backoff recovery
   refreshes discovery, but does not override the same persisted exclusion.
4. Discovery returns the first nonempty candidate set; later tracker results do
   not enlarge the returned/cache snapshot. An empty discovery result is cached
   for five minutes. Fresh GlobalKVStore instances can therefore appear to help.
5. Host queries themselves already run concurrently. The regression is not a
   serial host loop. Discovery (up to five seconds), possible discovery retry,
   and host lookup (normally two seconds) have separate budgets, however.
6. `queryDetailed` has completion counters, but GlobalKVStore uses `query` and
   discards them. All failed hosts can become `outputs: []`; undecodable token
   outputs are silently skipped. `get` then returns `undefined` or `[]`.
7. The legacy resolver accepts optional txid hints and structurally valid BEEF
   bytes before cryptographic validation. GlobalKVStore checks token signatures
   but does not establish transaction inclusion/currentness or reconcile tips.
8. `set` and `remove` ignore returned `BroadcastFailure`. The double-spend helper
   also ignores a returned error while broadcasting the competitor. Immediate
   re-query can race indexing. Locks live on each store instance and key only.
9. Current SDK `X-Topics` is comma-separated, matching current Overlay Express's
   documented OpenAPI encoding; older servers required JSON arrays. This draft
   changes neither wire encoding nor consumers' production compatibility patches.

Historical operator dossiers record retired advertisements, service 404s,
HyperTypist's fresh-instance retry, TrueLink's indexing-aware recovery, and
Metanet Docs's pinned backend and submission adapter. These are corroborating
historical evidence, not a new live inventory. No live data was fetched or
mutated for this investigation.

## Local timelines

| Case                                                           | Legacy path                                    | Proposed path                                      |
| -------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Persisted future cooldown, only recovered host                 | Immediate backoff error; zero requests         | Host is eligible for a probe immediately           |
| Empty peer plus cooled recovered host                          | Empty peer wins by exclusion                   | Both contacted; verified data retained             |
| Fast empty at 10 ms, valid data at 800 ms                      | May omit data through discovery/reputation     | Data at 800 ms; completeness remains partial       |
| Healthy peer plus stalled peers                                | Parallel host work, separate discovery budgets | One 2,000 ms host window, verified partial data    |
| Retired advertisement at 0 ms, healthy advertisement at 400 ms | First tracker candidate snapshot               | Union at 400 ms; dead host settles at 2,400 ms     |
| All hosts stall                                                | Can return an empty output list                | Explicit unavailable after 2,000 ms with overrides |
| Cold discovery stalls                                          | Up to 5,000 ms before host work                | Discovery budget 1,500 ms within total 5,000 ms    |
| Write accepted before index                                    | Returns success immediately                    | Poll exact outpoint; unconfirmed at 5,000 ms       |

Fake-timer figures are deterministic scheduling evidence, not production latency
measurements. The HTTP fault-injection suite uses real independent loopback
servers and real JSON, BEEF, signature and locally anchored Merkle verification.
It tests disabled, delayed, corrupt, stale and empty peers. Healthy path target
is 1–2 seconds; default cold discovery plus host settlement is at most about
3.5 seconds within the five-second deadline under bounded cooperative work.

## State machines and invariants

Legacy: unknown → success or failure → exponential backoff → exclusion until
wall-clock expiry. Success resets failure counters, but exclusion prevents a
probe. Persistence can recreate exclusion on every reload. Cross-tab writers
replace the entire stale map without locking; last writer wins.

Proposed: unknown → probed → verified response or classified failure → advisory
penalty → decaying/half-open probe → immediate reset on verified response.
Every selected host is probed on the next lookup even during cooldown. There is
no autonomous background probe when the application is idle. This favors recovery
and bounded parallel work over suppressing every probe during an outage.

- Separate v4 keys include network, service and normalized host URL.
- Timeouts carry weight 1; transport/rejection 2; malformed 8; invalid 16.
- Penalty is capped at 64, halves per minute, and yields at most 30 s cooldown.
- Cooldown affects ordering only, never the decision to contact a selected host.
- State expires in 24 hours; malformed/nonfinite/future timestamps fail open.
- v1–v3 are ignored, not copied or deleted. Rolling back still sees legacy state.
- At most 256 entries and 1 MiB read input. No arbitrary server error text,
  query, user identity, value, or BEEF is persisted or logged.
- Browser read/modify/write is serialized using Web Locks. Without atomic
  storage/locks, the new path uses memory only. Custom adapters must provide
  equivalent serialization; the tests model two independent tabs sharing it.
- At most 32 candidate hosts and 32 trackers per operation. Truncation marks
  discovery incomplete. This is a resource bound, not a guarantee that an
  arbitrary 33rd healthy host will be contacted; scalable candidate scheduling
  needs review before a general guarantee can be made.

Discovery gathers all bounded tracker responses anew. The draft does not add a
new persistent discovery cache. Advertisement parsing is routing input, not proof
of authority or a guarantee of freshness. Duplicates normalize away; malformed
URLs cannot be contacted. Existing emergency host overrides remain available.

The total monotonic timer includes discovery, request parsing and validation.
Each host has its own smaller budget. AbortSignal is passed to facilitators;
standard fetch is cancelled. A non-cooperative custom facilitator cannot hold
the consumer promise open, but its own underlying work may continue. No early
first-answer cancellation is used because the current wire protocol supplies no
safe early-completion certificate. Cancellation at deadline/completion is tested.

## Correctness and structured API

`GlobalKVStore` imported from `@bsv/sdk/kvstore/reliable` exposes `getResult`, which requires an explicit, network-correct `ChainTracker`.
Each candidate validates BEEF parsing, actual txid versus any hint, output index,
PushDrop fields, protocol/controller/key/tags selectors, derived controller lock,
field signature and SPV verification before health credit or deduplication.
The optional HTTP facilitator bounds streamed responses to 4 MiB before parsing.
Bounds are 256 outputs and 4 MiB BEEF per host. Aggregate outputs are deduplicated
by the actual transaction hash and index. Within each protocol/controller/key,
proven spending successors supersede ancestors. Incomparable tips return conflict;
array order, latency and response cardinality never choose a winner.

| Outcome                  | Meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `data`                   | Verified observed entries, with `complete` or `partial` completeness and `observed` freshness |
| `absent`                 | Every configured authority and contacted host completed successfully and returned empty       |
| `incomplete`             | Some empty responses exist, but they do not establish absence                                 |
| `unavailable`            | No usable data and availability/discovery failed                                              |
| `malformed` / `rejected` | No usable data and validation/rejection evidence exists                                       |
| `conflict`               | Valid incomparable tips; no winner selected                                                   |
| `stale`                  | Caller-owned last-known-good state retained after a refresh failure                           |

Completeness requires an explicitly configured authority set, successful complete
discovery, no failed hosts and agreement on current membership. This deliberately
conservative rule does not infer independent votes from arbitrary discovered URLs.
A missing authority, failed peer or stale member list prevents authoritative
absence. The legacy-shaped `get` adapter throws `KVStoreUnavailableError` for
partial/failed outcomes when reliability is enabled. Consumers wanting partial
observations must use the structured API and display their status.

### Fundamental protocol gap

With one unknown accurate host and arbitrary stale/malicious peers, no client can
prove global currentness from inclusion proofs alone. Two worlds are identical
to the client: a token is current, or it was spent and the successor is withheld.
Empty responses carry no authenticated completeness/index watermark. Node identity
is not an independent authority quorum. Thus the unconditional requested guarantee
cannot honestly be delivered by a latency/reputation patch.

The draft exposes this limit rather than labeling observed data globally current.
Before promotion, define a versioned server capability for signed complete query
snapshots, authority membership/failure assumptions, index watermarks/read tokens,
and spend/absence evidence. Pagination requires snapshot-bound cursors and global
membership semantics. A server assertion alone still needs a stated trust policy.
No overlay wire-format change is proposed without that design review.

## Writes and consumer migration

Opt-in writes default to wallet `noSend` until overlay submission, reject returned broadcast errors, bound waiting, and poll for the
same outpoint after indexing. An ambiguous submission reports `unconfirmed` with
the transaction identity; it must be reconciled rather than recreated. Shared
same-origin Web Locks serialize operations by network/service/protocol/controller/
key; in-process fallback coordinates store instances. Existing instance locks
remain for legacy callers. The effective per-call protocol is used when unlocking.

The optional `ReliableTopicBroadcaster` now rediscovers SHIP hosts on every
submission, bounds discovery and parallel submissions under one five-second
deadline, propagates fetch cancellation and checks acknowledgment indices.
Returned errors are failures. Legacy broadcaster behavior is unchanged.
Competing replacement transactions now wait for independent indexing confirmation
before the retry helper resumes. Replacement output zero is the GlobalKVStore
contract; removal transactions still require a separate absence confirmation.
Remaining write blockers are material: cross-device uniqueness requires atomic
server admission/reservation or an explicit protocol conflict policy. A browser
lock cannot provide that. The draft blocks subsequent same-key writes after an ambiguous/rejected result,
shares up to 256 pending records across instances, and exposes
`reconcilePendingWrite` to resubmit the same retained signed transaction and
confirm without creating another transaction. BEEF is held in private memory,
never attached to an error object or written to reputation storage. A durable
cross-tab pending-write journal and tested restart reconciliation are required before claiming idempotence across reloads. Reliable
history is intentionally rejected by legacy-shaped `get` until ancestor values
receive the same verification policy. No current value is substituted for history.

`KVStoreReadState` retains last-known-good entries in caller-owned memory on
transient failure, exposes stale status, and clears on explicit account/query
change or authoritative absence. It never hides a conflict or replaces a known successor with a proven stale
ancestor. Partial list refreshes retain previously observed missing records as
stale rather than silently dropping them. Consumers should
render refreshing/degraded state, offer Retry and trigger bounded re-fetch on
foreground/reconnect. UI copy should say “Temporarily unavailable” rather than
exposing host cooldowns. The optional `KVStoreReadSession` adds coalesced refresh, automatic two-second retry,
cancellation and observer notifications. Local Metanet Docs and Gloss adapters
use it directly; a local Metanet Docs status component has a tested Retry button.
These previews are not wired into production factories or published consumers.

Proposed sequence after human design approval:

1. Review authority/currentness, bounded candidate scheduling, parser/CPU resource
   limits, history and durable write semantics; finish the uncovered cases.
2. Complete server capability and atomic write-admission design in overlay-topics
   and the overlay engine, including portable protocol vectors.
3. Finish SDK browser/mobile, property/mutation, packed consumer and CI evidence.
4. Publish an approved SDK minor and coordinated server capability releases only
   through protected workflows, in a separate explicitly authorized task.
5. Integrate structured reads in Metanet Docs and an independent consumer; retain
   production pins and compatibility adapters until their backend capabilities
   are independently validated. Roll out read-only observation first.
6. Verify synthetic canaries, tail latency, stale-state visibility and pending-write
   recovery before any write-path upgrade. Human approval gates every deployment.
7. Roll back via prior package/config; v4 is additive and legacy records untouched.

## Review guide

Start with the two legacy reproduction tests. Review `ReliableHostReputation`,
then `ReliableLookupResolver.queryReliable`/`ReliableLookup`, then the cryptographic and reconciliation
boundary in `ReliableKVStore`. Review the opt-in adapter in `ReliableGlobalKVStore` last. The optional subpath keeps the legacy UMD
payload within its unchanged size budget.
Run deterministic tests and real loopback fault injection before package checks.
Read the limitations above before evaluating latency or completeness claims.
This proposal must remain a draft: it is not a complete implementation of all
requested protocol, restart, consumer UX or deployment guarantees.

## Local use and explicit non-goals of the prototype

```ts
import { GlobalKVStore, KVStoreReadSession } from '@bsv/sdk/kvstore/reliable'

const store = new GlobalKVStore({
  wallet,
  reliability: { chainTracker: trustedTracker, authoritativeHosts: approvedAuthorities }
})
const session = new KVStoreReadSession(
  signal => store.getResult(query, {}, signal),
  snapshot => render(snapshot)
)
await session.refresh() // Retry uses the same method; failures auto-retry while mounted.
// On unmount or account/query change:
session.stop()
```

The placeholders above must be supplied by the application; no permissive tracker
or authority is silently invented. Main SDK imports retain legacy behavior. The
new subpath has ESM, CJS and TypeScript export contracts. No production app pin or
compatibility patch has been removed.

Open design decisions: authority membership and fault model; signed index
watermarks/currentness evidence; discovery authentication and candidate limits;
snapshot pagination; worker-isolated parsing/validation for strict adversarial CPU
bounds; cross-device atomic key admission; durable pending-write recovery; verified
history; half-open probe load under many tabs; and production UI adoption. These
are blockers to the unconditional end-state guarantee, not hidden successes.

## Validation and consumer preview scope

The local validation record is in `globalkv-reliability-validation.md` beside this
proposal. Both consumer previews are retained on local task branches. They depend
on the unpublished local SDK tarball and are intentionally not proposed as
consumer dependency upgrades. Only the shared SDK change receives a draft PR.
There is no overlay-topics PR: currentness/absence and cross-device reservation
semantics require agreement before a defensible server implementation can be
reviewed. No live advertisements were inspected or altered during this task.
