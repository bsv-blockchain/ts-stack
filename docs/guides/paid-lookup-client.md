---
id: paid-lookup-client
title: 'Explicit Paid Lookup Clients and Protected Workflow State'
kind: guide
version: '1.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [overlay, lookup, wallet, recovery, custody]
---

# Explicit paid lookup clients and protected workflow state

A paid lookup has two owners. The selected seller retains its quoted obligation,
payment evidence and disclosure decision. The buyer retains the original request,
selected capability, payment construction and delivered material. An HTTP response
connects those owners; it does not replace either one's durable records.

`OutputPaidLookupTransport` in `@bsv/sdk` performs one immutable `quote`, `pay` or
`recover` operation. It authenticates against the original selected seller using
the original buyer's wallet. Its constructor takes an integrity-protected retained
capability, the corresponding recovery trust settings, and the exact Acquire
request. The `pay` operation also requires the original challenge and exact signed
BRC-105 payment. A `recover` operation can include the retained challenge; omitting
it supports recovery after the initial quote reply was lost.

The constructor binds the request to the selected service and chain. Responses
must preserve the original buyer, seller, listing, request, rules and challenge.
The transport checks challenge amount and derivation-prefix headers, the selected
release policy and minimum recovery commitment. Recovery uses the original
acquisition identity and endpoint even after the original manifest expires.
Manifest expiry does not authorize a new payment or another seller.

Every network operation is finite, authenticated, bounded and cancellable. The
client disables AuthFetch's automatic payment path and attaches a payment header
only for an explicit `pay` instance. It never constructs a wallet action, retries
with a new payment, polls for completion, fans payment out to catalogue hosts, or
stores results. A failed call can have an unknown remote outcome. Recover that
same operation before deciding what is known; a timeout is not proof of absence.
Existing AuthFetch callers and their defaults are unchanged.

An unpaid quote may return either a challenge or an already-retained status. A
paid or recovery call returns a status packet. Delivered data is a seller report
until the application independently verifies the listing's transaction and Script,
the exact payment output, release evidence and application material. Keep
received, validated and usable outcomes distinct. Retain unusable delivered data
for diagnosis and recovery instead of silently requesting or buying a replacement.

The selected profile's request and response bounds remain within the four-MiB
wire limit. A BRC-105 payment contains at most 64 KiB of Atomic BEEF; JSON/base64
framing can require a substantially larger HTTP header. The acquisition path
permits at most 128 KiB of aggregate outbound headers, and private-acquisition
Overlay Express hosts use the corresponding bounded listener allowance.
Reverse proxies must preserve those limits. Responses have a separate 16-KiB
header limit. Malformed Atomic BEEF is an invalid candidate; an uncertain wallet
or chain operation remains unavailable and must be reconciled.

## Encrypted local control state

The portable `@bsv/output-knowledge/operations/protected` entry adds
`ProtectedOperationStateStore`, `WalletProtectedOperationPayload`,
`protectedOperationBinding` and `PROTECTED_OPERATION_INITIAL`. These compose above
existing native SQLite or browser IndexedDB operation stores. Their schemas,
default capacities and ordinary public workflow behavior remain unchanged.

`WalletProtectedOperationPayload` uses the selected BRC-100 wallet's authenticated
self-encryption. It binds each ciphertext to the namespace, complete installed
configuration and exact revision through a fresh salted key identifier. It pins
the selected wallet identity and methods around awaited custody operations. The
public configuration must contain only public identifiers; private requests and
results belong in encrypted values. An installation does not create or export a
new root key, and losing access to the original custody cannot authorize a
replacement installation.

Create the underlying store with the exact `protectedOperationBinding` and the
public empty sentinel. Explicit `initialize` commits the first encrypted value at
revision one. Later `open` requires existing encrypted state and never initializes
an absent or empty store. Reserve the full plaintext frame and ciphertext
expansion before an operation can incur a financial effect. Values are bounded by
the installed `maximumValueBytes`; the wallet codec supports at most two MiB of
plaintext, including framing. A complete four-MiB delivery needs a separately
bounded protected result owner. A small encrypted control cell is not such an
owner, and increasing a wire limit would not solve that storage requirement.

Each CAS owns the supplied value before awaiting encryption. Multiple writers use
the original backing store's atomic revision check. A lost acknowledgement can be
recognized only when the immediately following revision decrypts to that exact
value; random encryption salts do not defeat this comparison. A later revision
is a conflict, not evidence that an uncertain earlier write rolled back. These
stores detect changed record bindings and custody. They do not detect restoration
of an entire earlier valid database. Backups, browser eviction, disk exhaustion,
restoration and paid-result deletion need explicit application policy.

## New signing and original recovery

The native recoverable action controller accepts an optional fourth `finalize`
argument, `checkNewSigning`. This synchronous callback returns void while the
original operation still has current authority to construct a new final
transaction, or throws. It is checked after awaited authorization and allocation,
around managed signing, after complete input Script verification, and immediately
before requesting retention. The shared managed signer preserves the original
unlock-template receivers, key batching and telemetry behavior.

The callback must read the current clock and current application authority at each
invocation. Capturing an earlier boolean or timestamp defeats that purpose. For a
quote deadline, reject when the current time is greater than or equal to
`payableUntil`; the deadline is exclusive. An async callback or a non-void return
is rejected. Ordinary callers that omit the callback retain their existing
behavior.

A callback cannot cancel an effect already underway or prove the commit time of
an awaited storage operation. Retention can commit after the last synchronous
check, and its response can be lost. Such uncertainty always belongs to the
original operation. `recover` reads and processes the exact retained final
without signing again. `finalize` also returns the same retained final without
consulting the new-signing callback. If recovery finds only a prepared allocation,
it may reconstruct the unsigned transaction but does not sign it. A separate
explicit advance needs current authority before it can continue new signing.
No path in this local capability broadcasts a transaction.

## Validation and composition status

The accompanying tests exercise selected-host authenticated HTTP, lost quote and
paid responses, one actual native seller-wallet credit, original recovery,
malformed and maximum-size payment envelopes, encrypted SQLite/IndexedDB state,
concurrent CAS, native process termination, and delayed signing authority.
The packed browser test uses a separate Chrome profile and native IndexedDB to
check ciphertext at rest, browser restart, cross-tab CAS and wrong-wallet refusal.
Those tests complement the required complete mutation and exact-head hosted gates;
they do not substitute for them.

These are reusable building blocks. The durable buyer orchestration, complete
four-MiB protected delivered-result owner, domain/LCH material adapters and their
end-to-end demonstrations remain under implementation. Applications must not
interpret a finite transport, encrypted control cell or local noSend transaction
as completion of that whole purchase workflow. See
[server acquisition and recovery](./private-acquisition-recovery.md) and
[local action recovery](./local-action-recovery.md) for the existing owners.
