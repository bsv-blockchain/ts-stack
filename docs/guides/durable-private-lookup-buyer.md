---
id: durable-private-lookup-buyer
title: 'Durable Private Lookup Buyer'
kind: guide
version: '1.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [overlay, lookup, wallet, recovery, custody]
---

# Durable private lookup buyer

A buyer must keep an obligation after the HTTP call ends. The optional
`@bsv/output-knowledge/private/buyer` entry composes the selected capability,
original request, protected custody, explicit payment and independent material
validation. It starts no listener, wallet operation, broadcast or background
recovery merely because it is imported or opened. Catalogue browsing remains a
separate uncharged query.

`PrivateLookupBuyer` owns one original acquisition. Its public installation
binding hashes the exact retained capability, request and derivation suffix, and
includes the payment owner's public configuration and material-policy identity.
It contains no private request or delivered material. Install a durable
`ProtectedOperationStateStore` for control and a durable
`ProtectedOperationObjectStore` for original bytes. Both must use that exact
binding; the object recipient must be the request's buyer. Native SQLite and
browser IndexedDB owners are interchangeable through these interfaces. Use the
original custody on reopen, including its wallet or supplied key resolver.

## Installation and complete reservation

First retain the selected capability contract, acquisition request and chosen
payment derivation suffix in application-owned protected storage. Compute
`privateLookupBuyerBinding` with those originals, the recovery trust settings,
the installed payment capability and the independent validation policy. The
state configuration must allow at least 16 KiB of plaintext control. Initialize
it explicitly with `PRIVATE_LOOKUP_BUYER_INITIAL`; the underlying encrypted CAS
store uses its separate `PROTECTED_OPERATION_INITIAL` sentinel. Existing stores
are opened rather than initialized.

The buyer reserves five immutable objects before financial work: the complete
request, original contract, payment plan, exact signed payment and first delivered
result. The request and result capacities are the selected profile's limits,
capped at four MiB. The remaining slots allow 512 KiB for the contract, 64 KiB for
the plan and 96 KiB for payment JSON. Configure at least five objects and a
per-object maximum large enough for every slot. Custody must accommodate complete
object framing and ciphertext expansion. The wallet-encrypted codec's two-MiB
plaintext ceiling cannot retain an arbitrary four-MiB profile; install a narrower
compatible profile or suitable protected custody explicitly. Do not truncate a
result or weaken the advertised wire limit to hide a local custody mismatch.

`initialize` creates the reservations and commits the original request and
contract. Only a public empty sentinel can become a first control record.
`open` checks existing control, every reservation and original bytes; it never
recreates missing custody or chooses another operation. A missing database,
wrong wallet, changed policy identity, altered contract or smaller capacity is an
installation failure. Logical reservation does not guarantee disk space, browser
quota, rollback detection or a retained backup. Applications still need the
[storage and restoration policy](./protected-operation-objects.md).

## Payment capability and explicit authority

`PrivateLookupBuyerPayment` is a local capability with three operations. `plan`
derives the exact construction without allocating or signing. `recover` reports
the original action's absent, prepared or finalized state without new financial
work. `finish` first recovers, then performs newly authorized preparation and
signing only when its synchronous guard succeeds. A generic BRC-100 wallet alone
does not promise durable action idempotence; there is no automatic fallback.

`WalletToolboxBuyerPayment` adapts the native recoverable action controller. Its
constructor compares independently selected wallet, storage, chain and originator
bindings with `actions.configuration()`. That descriptor exposes the actual
installed identities and network; it advertises no new RPC method. The full chain
context, including genesis, remains part of the application binding. The adapter
pins its methods and configuration across awaits and checks the wallet used for
key derivation.

The adapter derives the selected seller's BRC-29 P2PKH payment destination using
the original BRC-105 prefix and buyer suffix. It prepares one fixed-order exact
price output with `noSend: true` and `signAndProcess: false`, through one stable
operation ID. Finalized Atomic BEEF must identify the exact price, key and output.
The buyer retains those signed bytes before paid HTTP dispatch. The native
controller supplies cross-process allocation/signature recovery. Neither the
adapter nor buyer broadcasts. Applications must separately decide whether and
how a transaction is submitted elsewhere.

`advance` is explicit consent to new work for this original operation. It checks
current access and the original exclusive `payableUntil` deadline before
preparation, signing and paid dispatch. Its signing guard reads current authority
each time; it must not capture an earlier permission or timestamp. A retained
final may be recovered after expiry, but expiry prohibits another new signing or
paid dispatch. Clock rollback refuses new work. Cancellation cannot undo an
already committed allocation, signature, credit or remote acceptance.

## Recovery, validation and use

`recover` reads the retained first result or reconciles the original wallet and
unpaid original seller status. It never allocates, signs, attaches a payment header
or discovers a replacement seller. A lost quote can be recovered by the original
request identity even when the challenge reply was never received. A lost final
wallet reply can reveal the same retained payment. A lost delivery reply can
recover the original seller's stored result after reopening and after expiry.
A missing status or unavailable dependency remains unknown; it does not authorize
another payment. Only an explicit later `advance`, while authority is current,
can dispatch the same retained payment. Concurrent network attempts can therefore
repeat identical bytes; durable buyer action identity and the seller's funding
fence establish one economic payment rather than an exactly-once HTTP guarantee.

The installed validation policy must also provide `preflight(request, challenge,
signal)`. A null challenge checks the original domain terms before a new quote;
a retained challenge additionally checks its price, deadlines and release terms
before wallet construction, preparation or paid dispatch. The buyer passes copies
of its immutable originals and repeats current access and deadline checks after
each asynchronous preflight. The owner remembers its latest checked new-work time and retains it monotonically
in subsequent control commits, so a backwards clock cannot enable another paid
dispatch after restart. This observation is not protection against restoring an
older backup or a clock change during an unacknowledged external operation.
This policy must validate any required agreement,
licensing authority, supported critical mechanisms and selected ciphertext before
payment; it cannot allocate, sign, broadcast or release plaintext. Ordinary
recovery never reruns new-work preflight: withdrawal or expiry of an offer does
not erase a payment already made. Independent delivered-result validation still
applies to recovered material.

The first delivered response is retained immutably before independent validation.
The public stages are `ready`, `quoted`, `funding`, `paid`, `received`, `validated`
and `usable`. `PrivateLookupBuyerValidation.verify` checks the original listing,
payment, release evidence and domain material independently of the seller's
signed report. `usable` checks the application's current ability to use it. A
policy must supply real transaction/Script/SPV and material checks appropriate to
its profile. `validated` may remain unusable. A failed material check keeps the
first received result and never buys a replacement silently.

`validate` promotes a retained result only after those checks. `usableResult`
returns it only from the usable stage, repeats current usability and access
checks, and rejects if the control revision changed during the read. A persisted
usable stage is not permanent permission or proof of present decryption ability.
The generic buyer does not itself parse a licence, decrypt content or implement
an LCH or covenant release profile; those are explicit domain adapters.

One physical operation is permitted per buyer owner. Caller cancellation rejects
promptly but keeps its physical capacity occupied until the underlying work
settles. `stop` aborts and drains those calls. Await `stop` before closing either
custody owner; applications own the stores' eventual shutdown. Cross-process
control conflicts must be reconciled through the same original operation.

## Concrete evidence and scope

The native buyer tests fund one synthetic noSend action, reopen the controller,
and recover the same final bytes after expiry without another preparation or
signature. They also retain a prepared allocation when authority expires before
signing. The buyer model runs 300 bounded interruption histories, including lost
quote/payment replies, reopen, expiry, validation and unusable material; encrypted
CAS acknowledgement-loss cases cover funding, paid and received stages.
Cancellation tests retain physical capacity and refuse late validation promotion.

`PrivateBuyerHTTP.integration.test.ts` composes the actual buyer and seller wallet
controllers, encrypted SQLite owners, authenticated transport and opt-in Overlay
Express router. It loses the first delivery response after one seller credit,
reopens the buyer, recovers unpaid after expiry, and independently verifies
listing and payment Script/SPV before material becomes usable. It uses isolated
loopback transport and synthetic funds; it does not claim TLS, broadcast, mining,
LCH playback or covenant/POTATOES qualification. Complete protocol campaigns and
final-head hosted qualification remain required before the reference release.
