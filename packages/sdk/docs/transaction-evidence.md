# Transaction evidence

This guide documents the bounded transaction-evidence APIs exported by the SDK.
The C02/C03 implementation is under review; these notes describe the current
source contract and its limits. They do not claim that the wider verification
plan or release gates have completed.

## Evidence and verification

The transaction entry point exports `TransactionEvidence`,
`VerifiedTransactionOutput`, `TransactionEvidenceError`,
`TransactionEvidenceLimits`, `defaultTransactionEvidenceLimits`, and
`TransactionEvidenceCoordinator`. The source contracts are in
[`TransactionEvidence.ts`](../src/transaction/TransactionEvidence.ts),
[`TransactionEvidenceCoordinator.ts`](../src/transaction/TransactionEvidenceCoordinator.ts),
and [`ChainTracker.ts`](../src/transaction/ChainTracker.ts).

`TransactionEvidence` is an untrusted receipt:

```ts
interface TransactionEvidence {
  beef: number[]
  outputIndex: number
  txid?: string
}
```

The optional `txid` is a consistency hint. The coordinator copies the BEEF
bytes before parsing or deriving a receipt, derives the selected transaction ID
from the atomic transaction (or the final transaction when no atomic ID is
present), and rejects a mismatched hint. A successful verification returns the
derived transaction ID, selected output index, canonical outpoint, and locking
script. It establishes transaction inclusion/ancestry and script validity
under the supplied verifier and chain tracker. It does not establish service
relevance, current unspentness, or ownership.

The parser walks the complete unconfirmed graph on every attempt, including
positive-cache use. It checks source transaction presence, source TXID
consistency, duplicate spent outpoints, input and serialized-script limits,
and rejects an unconfirmed zero-input leaf. Confirmed ancestors still require
canonical Merkle-root validation through the caller's tracker. Receipt bytes
are copied and owned by the SDK; host metadata is never chain authority.

## Caller context and bounded policy

The coordinator requires a caller-owned `chainTracker`, nonempty
`chainNamespace`, and nonempty `policyId`. The namespace identifies the
caller's network or application trust domain. The policy ID identifies the
semantic verification policy or backend. Neither is populated from lookup
metadata.

`ChainTracker.getVerificationContext?: () => string | number` is an optional
synchronous provider, policy, or recovery-generation marker. The optional
`getVerificationContextToken(signal?)` asynchronously obtains a fresh trusted
tip/context token. The coordinator brackets canonical-root and height checks
with that token and rejects a `context-changed` result when the token changes.
Chaintracks and local adapters include monotonic reorganization/reset epochs
and fence reset entry and failure paths. A remote tip read can still miss an
unobserved ABA transition back to the same tip, and a token over multiple
sources is not an atomic multi-source snapshot. Canonical roots and observed
heights are therefore still rechecked on every use, including positive-cache
reuse. The required tracker methods accept optional abort signals; existing
implementations may ignore them.

The limits in [`TransactionEvidence.ts`](../src/transaction/TransactionEvidence.ts)
are local admission and memory policy, not consensus limits. Defaults are:

| Limit                      |    Default |
| -------------------------- | ---------: |
| Candidate bytes            |      1 MiB |
| Retained evidence bytes    |     16 MiB |
| Transactions               |        256 |
| Inputs                     |      4,096 |
| Serialized script bytes    |    256 KiB |
| Script memory              |     16 MiB |
| Candidates per transaction |          8 |
| Pending transactions       |         32 |
| Concurrent transactions    |          4 |
| Pending chain calls        |          8 |
| Consumers                  |        128 |
| Positive cache entries     |        128 |
| Positive cache age         | 60 seconds |
| Attempt timeout            |  5 seconds |
| Request timeout            | 15 seconds |

Overrides must be positive safe integers. Invalid limits fail closed with
`TransactionEvidenceError` code `limit`. These limits are configurable local
policy, not consensus limits. Script resource exhaustion is also mapped to the
typed `limit` outcome; malformed or inconsistent evidence remains
`invalid-evidence`.

The coordinator shares bounded transaction work and canonical chain calls
among consumers. Consumer cancellation detaches that consumer. Non-abortable
script or backend work remains counted until its actual promise settles, and
one consumer cannot cancel another consumer's owned work. Positive results are
bounded by entry count, retained bytes, and age. Rejected receipts are evicted
and do not become permanent negative decisions for a transaction ID.

An internal `EvidenceScriptWork` hook is now present in
[`EvidenceScriptWork.ts`](../src/transaction/EvidenceScriptWork.ts). Its binding
covers the actual transaction, every input's source transaction/output bytes
and value, and the script policy/backend parameters. The binding is
transaction-wide; it is not an input-index-only key. A hit may skip
cryptographic script execution only. It must still perform source/value
binding, complete graph traversal, canonical chain calls, and policy/context
checks. Non-batch individual executions keep their own fulfilled or rejected
result, including the typed error; only a backend batch-level failure rejects
every in-flight entry. The cache and in-flight owners remain bounded by the
coordinator limits. A normal block arrival before the next reuse does not
erase exact script work when the transaction/source/policy binding remains
valid; canonical anchors and fresh context are still checked.

## Resolver evidence intake

`LookupQueryOptions.onEvidence` and `LookupEvidenceEvent` are additive optional
APIs in [`LookupResolver.ts`](../src/overlay-tools/LookupResolver.ts). The
callback receives copied, untrusted per-host receipts before legacy TXID and
outpoint aggregation:

```ts
type LookupEvidenceEvent =
  { type: 'output'; host: string; output: LookupAnswer['outputs'][number] } | { type: 'limit' }
```

Intake defaults to 512 outputs or 16 MiB per query and reports one `limit`
event. `evidenceLimits: { maxOutputs?, maxBytes? }` can configure those local
callback bounds; values must be positive safe integers. Coordinate them with
the downstream verifier's admission limits when admitting larger valid
evidence.
Callback completion is not awaited, callback failures are isolated, and no
callback is delivered after the query iterator closes. The legacy answer,
host scheduling, reputation behavior, timeout behavior, and existing
positional call forms remain unchanged. The additive callback preserves the
existing 2-second lookup default and 5-second tracker wait bound. Older or
custom resolvers can continue through the legacy aggregated-answer fallback.

Aggregated output may carry a host-supplied TXID hint. The resolver uses a
nonempty hint as a fast path and otherwise derives a TXID from BEEF with a
bounded memo. Security-sensitive consumers must still validate the bytes and
compare the derived TXID. Aggregation remains first-wins for each TXID/output
index key; use `onEvidence` when every bounded host receipt is needed.

## Compatibility

Existing two-method `ChainTracker` implementations and existing resolver
callers remain source-compatible. The new transaction exports, optional
tracker context and abort signals, and optional resolver callback are additive.
No caller migration is required for existing calls. The SDK's declared source
version is 2.5.0; the root release review owns final release evidence.

The synthetic shared-ancestor fixture is 556 BEEF bytes with three reachable
transactions, three inputs, and 314 serialized script bytes. Two child graphs
share the signed ancestor and result in three actual script executions. This
is characterization evidence for graph traversal and script-work sharing, not
a general performance or throughput claim.

No worker, latency, throughput, browser/mobile deployment, C04/C05, or whole
plan completion claim is made here. Run the package's declared build,
typecheck, lint, format, test, packed-consumer, browser, and documentation
checks before treating this guide as release evidence.
