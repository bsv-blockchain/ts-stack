---
id: private-purchase-alias-custody
title: 'Purchase Commitment and Transaction Alias Custody'
kind: guide
version: '0.1.5'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
review_cadence_days: 30
status: experimental
tags: [utxo, private-overlays, purchase, custody, recovery]
---

# Purchase commitment and transaction alias custody

This guide describes the explicit alias-custody companion for BRC-196 and BRC-198
as revised in [BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295). These
components are experimental and require explicit installation. Installing the
existing exact-transaction components does not enable this profile. The source
package and demonstrations still require the qualification described below.
BRC-197 is one independently verified purchase-domain exemplar. The custody and
coordination contracts do not depend on that particular listing Script or on an
application's asset terminology.

## Separate the three identities

The acquisition identifies the original authenticated request, recipient and
signed terms. The purchase commitment identifies one economic purchase under an
explicit independently verified domain. A transaction ID identifies exact Bitcoin
bytes and their own topical operation, admission history and chain placement.
These identities answer different questions. Equal outputs, a remote commitment
string or a signed catalogue response cannot establish purchase equivalence.

For the BRC-197 exemplar, the commitment is the full 32-byte SHA256d digest of the
authenticated listing-input preimage before scalar reduction. The installed domain
verifier must check the actual Script, every purchase input, complete lineage,
original terms and recipient binding for every incoming candidate. The coordinator
also verifies a proposed cumulative BEEF independently before retaining it. A
parser, native journal or chain inclusion adapter cannot replace that verifier.

`SQLitePrivatePurchaseAliases` preserves the first candidate, bounded unconfirmed
candidates, durable pending external operations, an independently selected-chain
candidate and the historical release candidate. An unconfirmed cache is separate
from the prepaid capacity for selected-chain work and incomplete external jobs.
An unknown external outcome remains a pending exact job. It cannot be evicted,
relabelled as rejection or substituted with another transaction's receipt.

## Prepare all mandatory custody before payment

`SQLitePrivatePurchaseAliasStore` explicitly owns `private-purchase-state/3` and
requires the native-observation and full-purchase-commitment profiles. Its request
fence distinguishes that owner from the historical stores. It refuses historical
formats. Existing owners and acquisitions keep their original formats and
behavior; selecting the new owner is an explicit installation for new work.
There is no automatic migration or inference from similarly shaped records.

Compose the owner and alias journal on the same `PrivateServiceDomain` and the
same immutable `PrivatePurchaseContracts`. Before payable terms can leave the
physical disclosure boundary, reserve every alias role, original material,
complete result slot and completion revision. The result reservation covers both
a first private release and an immutable local failure with its complete exact
candidate. Check aggregate bytes, native row capacity and the largest atomic
writer batch. A namespace that cannot honor that complete bounded promise must
refuse preparation. Staged local reservations without exposed signed terms grant
no payment or release authority and remain subject to explicit reconciliation.

The local atomic batch is a collection of independently bounded records, not a
single protocol packet. Keep each canonical record within the protocol JSON
ceiling and count its UTF-8 bytes, plus the batch brackets and commas, against the
separate installed native batch allowance. An allowance above 4 MiB must not be
passed as a wider protocol JSON limit. The native writer independently owns and
validates every record and the complete batch before any effect; neither the
wire limit nor record limits are increased by reserving a larger local batch.

The first economic identity, its exact raw candidate and the first native
reservation observation share one authenticated writer. Later pending selections
can change the transaction chosen for processing while preserving that original
identity and time. Byte-identical retries use no empty commit or extra revision.
A later transaction's topical admission never becomes the first transaction's
receipt. The journal records each definitive outcome at its actual committing
native observation.

## Coordinate admission and issuance separately

`PrivatePurchaseAliasCoordinator` retains the exact admission job before any
external call and requires the admission adapter to consult actual retained topic
history before replay. Recovery visits every retained pending job, independently
of the currently chosen candidate and historical entitlement. Each pass is bounded
by installed capacity. An unresolved job stays pending while the remaining jobs
can be reconciled. All external effects, result writers and physical disclosure
recheck current recipient authority and the original installed capabilities.

Pending jobs may occupy the original, selected or unconfirmed-cache roles as well
as the extra pending slots. Recovery deduplicates their transaction IDs and visits
all of those roles serially. The extra pending capacity does not require copying
an unresolved original into a second role. The maximum pass size is the sum of
the installed role capacities, including the original and selected roles.

Each native restore decrypts and authenticates the original custody afresh.
Its bounded encoding inspection owns the parsed value and checks duplicate keys,
Unicode, structural limits and both incoming and canonical byte limits. A canonical
value can pass directly into the same closed schema, installed-policy and original
contract checks. Other accepted encodings retain the original ownership and
normalization path, including negative zero. No custody value, schema decision,
key, authority or chain assessment is retained between restores.

The Node byte boundary owns a fresh Buffer under the original encoded-length
ceiling. Its required native Base64 round-trip proves canonical alphabet and
padding when the text matches. A mismatch still checks syntax before decoded
size and padding-bit refusal, preserving the SDK's error order. Every call
decodes independently; no byte representation or validation result is retained.

Alias proposals use the shared bounded value-ownership helper before their complete
purchase schema checks. A snapshot serializes its freshly constructed expected
binding once, within that call, while every stored state, header and chunk binding
is independently serialized and compared. Every row still undergoes the original
fresh authentication, capacity, digest, admission and native revision checks.

Before a result transition, the owner compares the complete loaded native head
and row revisions. The atomic write invalidates that old snapshot by design.
Its returned read authenticates the caller and domain against the newly committed
head; it must not apply the old snapshot fence to its own successful write.
An unrelated head change before the writer still refuses the transition, including
a change during private-result signing. Failure and mined-alias promotion use the
same separation between pre-effect snapshot checks and fresh readback.

Time may advance between authenticated reads without changing the retained head
or records. First result completion therefore retains revision fences and derives
the delivery progress at the actual `commitPrepared` observation. That writer
checks current authority and placement before and after derivation, validates the
original signed envelope and commits its protected result with the historical
alias in one transaction. A changed head, row or authority still refuses the
effect; a clock increment alone is not an unrelated state change.

The domain's issuance operation is pure and idempotent over retained material.
Ordinary issuance, signing or transport errors leave an admitted obligation
pending. A separate optional installed failure assessment may identify an
irrecoverable local material problem under its own synchronous current guard.
Only that explicit assessment can produce a retained `delivery-failed` decision.
It retains the accepted STEAK, the exact paid candidate and a local decision whose
global outcome remains unknown. It stores no POTATOES or historical private
release. Recovery and alias-cache turnover cannot rewrite that terminal decision.
A native conflict in any row rolls back all result and owner changes together.

## Obtain fresh chain placement before the first mined release

`SDKPrivatePurchaseAliasCurrentness` accepts an acquisition and chain derived from
fresh guarded native custody. It owns that bounded closed subject, obtains a
fresh installed verification context, and uses the existing SDK evidence verifier
against an immutable independently validated header ancestry. It checks exact
transaction bytes, Script and SPV placement in that selected view. The purchase
domain and actual topical admission remain separate required premises. The adapter
does not establish current unspentness, equivalent purchase semantics, private
rights or production-miner acceptance.

For a first mined release, an actually admitted alias must be selected in that
fresh ancestry and meet the original release policy. The selected placement guard
is rechecked in the native result writer. Missing dependencies, unavailable
ancestry, a changed view, cancellation or insufficient confirmations cannot produce
an initial mined-policy secret. An unconfirmed-cache limit cannot stand in for
this selected-chain check.

The complete first signed POTATOES, original release evidence and matching
historical candidate are committed in one writer. Recovery returns those first
bytes, including the original signature. A subsequent mined alias may update a
separate currentness report after a weaker-policy release. It cannot rewrite the
historical POTATOES, License, settlement, policy, admission or issuance time, and
historical entitlement recovery does not call the chain-currentness adapter again.

## Disclose a report without changing history

The coordinator's `currentAlias` operation is a separate optional assessment. It
checks the actual selected alias's admission, independently verifies its domain
and obtains fresh selected-chain placement. The returned guard is ephemeral and
must be checked again at selection or disclosure; storing it or its result does
not create a reusable currentness verdict. Its context, selected ancestry and
installed method must remain unchanged. A reorganization, deadline or capability
replacement invalidates the report. Unavailable currentness cannot revoke the
already retained entitlement.

`PrivatePurchaseAccess` requires explicit `alias-custody-v1` selection together
with the full-commitment profile before interpreting state3. The generic physical
`PrivatePurchaseDisclosure` boundary preserves each owner's loaded type. It
prepares authenticated response bytes and enqueues them once under fresh native
recipient, permission, row and global-head checks. The immutable result excludes
`currentAlias`.

The explicit `PrivatePurchaseAliasDisclosure` companion obtains a fresh report,
checks its acquisition and full purchase identity, and includes only its bounded
`{txid, beef}` wire evidence. Its `prepareAsync` method is selected by the optional
Overlay Express disclosure hook. Existing synchronous disclosures remain unchanged.
The additional report fence executes against the SAME native view already used to
authorize and enqueue the historical response. It never re-enters the ledger with
a nested read. Prepared bytes are attempted at most once, and currentness changes
during asynchronous HTTP signing refuse physical disclosure of those bytes.

An absent, limited, unavailable, changed or independently nonqualifying report can be omitted before response
preparation without adding a chain gate to the historical grant. This includes a
retained alias orphaned by a fork: the optional assessment can refuse that placement,
while the original historical response still requires native custody, recipient
authentication and authorization. A malformed returned alias, mismatched purchase
identity or unexpected implementation exception remains a refusal, rather than
being substituted into the historical response. The full prepared
response must fit the original capability's response allowance; an optional report
that cannot fit is omitted. Once bytes are prepared for HTTP signing, their body
cannot change at enqueue. A failed fence produces the existing bounded authenticated
control response or aborts the response; a fresh recovery request can obtain the
original grant. The report never enters the immutable result payload or signed
release-evidence digest.

## Let the buyer assess its own currentness

A free recovery request still authenticates its recipient. A cold authenticated
transport first exchanges the BRC authentication handshake, then sends exactly one
recovery request. That handshake is separate from the application request and
does not authorize a payment, a new wallet action or another private issuance.

`PrivatePurchaseBuyerAliasCurrentness` authenticates the original seller and terms,
uses the buyer's independently retained full purchase binding, asks the installed
domain to verify the complete reported raw transaction and receipt/outputs/lineage,
and then asks the independently selected buyer chain to verify exact placement.
The resulting guard binds both assessments. A provider's statement that an alias
is current is never sufficient. The original funded bytes, a full domain verifier,
and the buyer's actual selected ancestry have separate roles.

`PrivatePurchaseBuyer.currentAlias(assessor, signal)` is an explicit, free fresh
recovery operation for a buyer already holding a delivered full-commitment
obligation. It reads original protected terms/candidate/result/identity, sends
only the uncharged recovery request and performs the two independent checks. It
neither prepares nor finishes a wallet action, submits a new transaction, accepts
a replacement secret/License, changes the persisted control revision nor rewrites
the historical result. Ordinary `recover` and `usableResult` keep their previous
behavior. Report absence or selected-view rejection does not erase usable rights.
Each call owns new bounded work; no positive verdict is cached across calls.

When submitting an equivalent transaction, independently verify both its complete
domain purchase and the originally funded transaction, require the same full
commitment, and explicitly supply `commitmentBinding` to `OutputPurchaseTransport`.
Keep both verification contexts current across the exchange. Omitting that option
retains the historical exact-transaction contract and correctly refuses a returned
grant bound to another transaction. The transport companion itself does not prove
economic equivalence or current placement.

Before the buyer retains its first delivery, ordinary `recover` may read the
original finalized wallet to reconcile that operation before querying the seller.
That read neither prepares nor finalizes another action. Once the immutable result
is retained, historical recovery and current-alias reporting do not need another
funding-action recovery query. Recipient key access remains a separate requirement
for licensed playback. The reference composition checks those stages separately.

Server constructors and native owner types are exported from
`@bsv/output-knowledge/private/node`. The buyer companion and SDK chain adapter
are exported from `@bsv/output-knowledge/private/purchase-buyer`; that portable
entry imports no native server owner. Construct the SDK adapter with your own
`ChainViewResolver` and `PrivatePurchaseAliasChainSelection`, and bind the complete
domain contract into the buyer validation installation ID. The seller and buyer
may use different selected views. An example's controlled domain or chain port
is not an interchangeable production verifier.

The reference test fixtures demonstrate encrypted native custody, restart,
per-alias admission, once-only HTTP enqueue, authenticated HTTP recovery and
retained buyer rights. Their domain, admission and selected-view premises are
explicitly controlled. The separate SDK currentness corpus executes real
Script/SPV against a small proof-of-work-checked ancestry. The actual BRC-197
Script and wallet-route suites separately exercise that reference exemplar; none
of these narrower layers alone establishes the whole composed financial profile.

## Compose the current selling exemplar end to end

`PrivatePurchaseProfileAliasNative.fixture.ts` is a separate integration fixture
for the current immutable BRC-197 reference family. It creates a signed LCH asset,
Offer and buyer Request against an independently selected public synthetic funding
checkpoint before preparing a native wallet action. The application original must
bind the same chain, anchor, fixed recipient, seller, asset and terms. The listing
uses reserve activation and the current active purchase Script; the historical
single-program fixture remains separate and retains its established behavior.
The exemplar does not introduce application-specific semantics into the generic
BRC-196/198 owner or its interfaces.

The composition uses the actual native noSend wallet and recoverable action
controller, full genesis/Script/purchase verifiers, Overlay Engine and retained
Mongo topic history, HTTP authentication and signed responses, encrypted native
private custody, and the current LCH buyer/seller domains. Full candidate binding
and joint object reads are explicitly selected before buyer creation. The buyer
installs separate domain verifiers and its own chain-selection guard. Every private
issuance follows exact admitted topical history and the original release policy.

The integration suite exercises recovery after reopening buyer, wallet, seller and
License custody; catalogue withdrawal without another payment; a distinct
Script-valid raw transaction with the same full listing-input purchase commitment;
authenticated free current-alias recovery without changing historical bytes or the
protected control revision; and a buyer rejecting an alias above its independently
selected tip. A fork invalidates the ephemeral report, while the already issued
License, settlement, POTATOES and playback remain available. For the first mined
release, the suite also checks that unmined admission returns no secret, a genuinely
proved and actually admitted equivalent alias satisfies the original policy, and
that first private grant remains historical after a later fork.

The alternative transaction changes only an unrelated disclosed funding signature;
it does not prepare another wallet action or modify the listing-input preimage.
It first links the complete original BEEF proof tree, then preserves those exact
source transactions when cloning raw bytes. Signing-only attachment provides
immediate parents and is insufficient for recursive Script/SPV verification.
The cloned alternative still executes every input against the independently
selected tracker before it can be submitted.
The signature's fixed nonce is a public test-key fixture and must never be used
with production keys. The proof fixture checks Script/SPV against a small synthetic
proof-of-work ancestry with an explicit Merkle commitment. It does not establish
production mining, a full production block body, miner fee/resource acceptance,
public TLS deployment, wallet database portability or live economic delivery.
Those remain separate qualification boundaries.

The separate current wallet-route demonstration retains the native wallet's
ordinary finality gate. It signs an expiry route at an earlier selected tip, then
advances the disclosed synthetic header view before finalizing the wallet action.
The same signed transaction is assessed under the retained earlier view, a mature
view and a regressed view. A non-final intent cannot consume output state in the
earlier view. This does not authorize the wallet to finalize non-final actions.

On the governed healthy synthetic Linux runtime, after preparing the repository's
native wallet and Mongo replica prerequisites, run the complete suite serially:

```sh
pnpm --filter @bsv/overlay-express test --runInBand --runTestsByPath src/__tests__/PrivatePurchaseProfileAliasNative.integration.test.ts
```

The existing historical integration suite and all original component/property
regressions remain required. The new suite keeps the existing 120-second per-case
deadline. Adding an example or passing its source compilation does not qualify the
whole profile; retain exact source/runtime inputs and runtime receipts before
advertising the composition as validated.

## Qualification status

The source declarations and native composition interfaces undergo strict virtual
compilation, lint and complete-definition preservation checks. Those checks do not execute tests or
qualify SQLite, Bitcoin Script, topical admission, signing isolation or HTTP
behavior. The prior alias-foundation native cohort exposed an incomplete-BEEF
fixture; its failed seed and receipts are retained. The source correction restores
funding ancestry without weakening the production completeness guard. Source
review, changed-source native unit/property execution, original regressions,
whole-source mutation testing, packed/browser/platform checks, actual domain and
wallet-route demonstrations, and exact-head hosted CI remain necessary before
this companion or Checkpoint 2 can be called complete.
