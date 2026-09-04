# SDK 3 overlay lookup migration

SDK 3 is a major version. It changes default scheduling,
error behavior, discovery caching, bounds, and persisted health handling. Publication and consumer upgrades follow the coordinated release process.

## Scope

Every SDK `LookupResolver` instance uses the same scheduling and reputation core,
regardless of service name, through `query`, `queryDetailed`, `query$`, or
`queryReliable`. This includes SDK consumers such as identity resolution and
SHIP discovery when they call this resolver. Custom third-party resolvers that
bypass it must adopt the shared API; server implementations do not change.

`ReliableLookupResolver` is an alias for the standard resolver. The optional KV
entrypoint remains for KV-specific cryptography, reconciliation, indexing-aware
writes, and retained UI state. Those protocol rules cannot be generalized to
arbitrary services. Standard output aggregation checks response shape, BEEF
parsing and txid hints, but does not verify Merkle proofs, service membership,
output semantics, freshness, conflicts or authoritative absence. Supply a
service validator through `queryReliable` where those checks are needed.

## Shared behavior

- Fresh union of up to 32 SLAP trackers, each with a 1,500 ms bound; no stale or
  empty discovery snapshot survives into the next operation.
- Up to 32 candidate hosts selected before reputation ordering. Every selected
  host is probed concurrently, including cooled hosts. Truncation is explicit;
  there is no unconditional availability guarantee outside the selected set.
- Default 2,000 ms host budget within one 5,000 ms operation budget, including
  discovery. `options.deadlineMs` and the existing timeout argument tune these
  within 1–30,000 ms. `queryReliable` also includes validation in its host budget.
- Standard HTTP responses are bounded to 4 MiB of streamed bytes before parsing,
  and output-list responses to 256 outputs per host. Custom facilitators and
  fetch implementations exposing only parsed bodies own their byte limits.
- Abort propagates through discovery and requests. Closing a progressive iterator
  cancels outstanding work. Non-cooperative custom promises cannot extend the
  caller's deadline, but arbitrary synchronous parsing/validator code cannot be
  preempted on the same JavaScript thread. Worker isolation remains unresolved.
- v4 reputation is scoped by network/service/normalized host, bounded and decays.
  v1–v3 records are ignored without deletion. Web Locks protect browser updates;
  custom persistence requires `reliableReputationStorage` with a lock. Unsupported
  storage environments and legacy get/set-only adapters use in-memory health.
- HTTP semantic rejection and valid freeform responses remain neutral for
  standard availability reputation. HTTP 408/425/429 and 5xx are availability
  failures. The explicit validator API can apply reason-specific rejection and
  invalid-proof penalties. Successful validated probes rehabilitate immediately.

Discovery cache knobs `hostsTtlMs`/`hostsMaxEntries` remain accepted but are
ignored. Transaction memo TTL is retained. Response wire encodings, HTTPS rules,
host overrides and additional hosts remain supported. Overrides for `ls_slap`
now follow the same precedence as other services.

## Failure and completion contracts

Before, `query()` could return `{ type: 'output-list', outputs: [] } when requests
failed. It now throws `LookupUnavailableError`with`retryable: true` and a
progress envelope for incomplete empty aggregates. A complete empty aggregate
still means only that the selected hosts answered empty. It is not a non-inclusion
proof or a claim about undiscovered hosts.

```ts
import { LookupResolver, LookupUnavailableError } from '@bsv/sdk'

const resolver = new LookupResolver()
try {
  const answer = await resolver.query(question)
  consumeObservedOutputs(answer.outputs)
} catch (error) {
  if (!(error instanceof LookupUnavailableError)) throw error
  retainLastKnownGoodAndOfferRetry()
}
```

`queryDetailed` and `query$` provide `progress.status` / `status`:

| Status        | Meaning                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `complete`    | Discovery completed without truncation and every selected host returned a structurally usable output list.            |
| `incomplete`  | At least one output-list response arrived, but some discovery or host work failed, was truncated or is still pending. |
| `unavailable` | No usable output-list response has arrived.                                                                           |

`query()` retains successful nonempty aggregate shapes, including partial data;
use `queryDetailed()` to inspect completeness before replacing cached collections.
`query$()` soft snapshots remain non-final and continue accumulating later answers.
`queryDetailed()` may return early when explicitly configured for soft/progressive
behavior; closing its iterator cancels remaining requests. Freeform results cannot
be aggregated and appear in the progress counters, never as authoritative empty.

Service-specific cryptographic validation is available on the standard export:

```ts
const result = await resolver.queryReliable(question, {
  signal,
  validate: async (answer, signal) => verifyServiceAnswer(answer, signal)
})
```

The validator must establish the service's correctness requirements. The resolver
returns per-host evidence; it does not invent generic quorums or reconcile
arbitrary application state. KV's validator/reconciler is one implementation.

## Proposed migration and rollback

Review the changed SDK contract and inventory each consumer's use of empty results,
custom timeouts, response sizes, discovery cache settings and custom facilitators.
First-party packages accept SDK 3 alongside their existing SDK 2 peer ranges,
with patch versions for the compatible manifest correction. Publish the coordinated
package set after maintainer approval; deployed consumer pins remain unchanged. Repack
and test each approved consumer, then adopt service-specific validators and UI
failure handling where needed. KV-specific write and authority guarantees have
additional unresolved requirements described in the companion design.

A later rollback uses the prior package/configuration. Old reputation keys remain
untouched, so the prior resolver can still encounter its original cooldown defect.
Keep production overrides and compatibility patches until an approved rollout
has independently validated their removal.
