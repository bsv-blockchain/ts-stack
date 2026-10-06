---
id: private-purchase-custody
title: 'Original Covenant Purchase Custody'
kind: guide
version: '1.0.1'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
review_cadence_days: 30
status: experimental
tags: [utxo, private-overlays, purchase, custody, recovery]
---

# Original covenant-purchase custody

The optional `@bsv/output-knowledge/private/node` entry provides
`PrivatePurchaseContracts`, `PrivatePurchaseCoordinator`, `PrivatePurchaseAccess`,
`PrivatePurchaseDisclosure`, the purchase progress functions and
`SQLitePrivatePurchaseStore` and `SQLitePrivatePurchaseEvidence` for the proposed BRC-196 companion. Compose them with
independent domain and release verification, the actual topic admission owner and
optional authenticated HTTP routes. Installing the native components alone does
not enable an endpoint or change ordinary overlay submission.

Unlike paid lookup acquisition, the purchase workflow pays through an actual
listing covenant transaction. It does not reserve a seller wallet credit or
charge an HTTP fee. A preparation retains the independently selected host and
topic, authenticated capability, complete original request, seller-signed terms,
domain evidence and disclosed release policy. The acquisition ID permanently
identifies that original request and recipient; a retry cannot select new terms
or replace an uncertain transaction.

## Prepare before the buyer funds

Install `PrivatePurchaseContracts` with explicit seller, chain, canonical base
URL, topic, rules digest, domain profile/schema, release policy, byte ceilings
and purchase/recovery intervals. `retain` checks a fresh authenticated BRC-101
capability. `restore` recovers the original retained selection without renewing
its promise or rejecting it merely because the catalogue has since expired.

An independently installed domain supplies verified listing authority, eligible
terms, private readiness and bounded material. `prepare` creates an owned
unsigned body; `authenticate` requires the exact original body signed by the
selected seller. Neither method establishes Bitcoin, domain or currentness
premises. For the BRC-197 profile, compose full genesis/lineage verification and
`RevenueListingPurchaseVerifier` as described in the
[lineage guide](./revenue-listing-lineage.md).

Before disclosing a payable preparation, `SQLitePrivatePurchaseStore.prepare`
atomically reserves the original signed terms and protected material, a
permanent request fence, the future candidate and complete delivered-result
slots, and every progress completion revision. It bounds the future complete
envelope, including the allowed STEAK and release evidence. It records the
actual native reservation observation and checks the construction cutoff again
inside commit. Insufficient capacity produces no payable preparation. An early
terminal outcome retains unused promised capacity; it cannot silently return
that capacity to another obligation.

Use `discloseTerms` to enqueue the original signed preparation. It restores the
protected original, rechecks current recipient authority and refuses an already
pinned or no-longer-payable preparation at the exclusive cutoff. Mutating a
previously returned local snapshot cannot substitute new terms at this boundary.

## Preserve one purchase and one result

`pin` is an internal effect reservation. Its caller must independently validate
the exact transaction, complete lineage, Script, original request association
and installed domain before calling it. A representation parser or valid seller
signature is insufficient. The store atomically retains one candidate and its
deterministic admission operation. Same-transaction retries recover the first
candidate; another transaction conflicts. New proof variants use the separately installed cumulative evidence owner and
cannot overwrite these first bytes.

An admission intent is not STEAK. Only actual retained topical processing may
advance it to `admitted-delivery-pending`. Save the original selected-topic
STEAK, assessment context and provider's original durable acceptance time. The
optional timed retained-history helper requires this provenance. Mongo derives
the time from the server timestamp atomically saved with the original committed
operation; later recovery cannot manufacture it. Ordinary receipt bytes remain
unchanged. A legacy provider without that time remains usable for its existing
profile but cannot establish the stronger timed premise.

The release owner independently verifies the disclosed policy and rechecks its
premises inside the final native commit. Local admission does not prove mining.
The mined verifier preserves its existing 131072-byte complete-evidence ceiling
and the caller's BEEF byte budget; it accepts a larger actual covenant BEEF only
when both fit. A processor attestation requires the independently selected
identity and registered format. The domain separately validates and issues the
recipient-bound secret or licence.

`complete` atomically saves the exact first signed POTATOES envelope and delivered
state. Recovery returns those original bytes. A newly signed equivalent body is
not a replacement for the first signature. Only delivered results contain
POTATOES and release evidence. A private delivery failure retains the already
accepted STEAK. A local rejection never establishes a global Bitcoin outcome.
An unconstructed preparation may expire; a pinned or admitted obligation remains
recoverable after its original deadline.

## Retain cumulative proof separately

For cumulative same-transaction proof retention, install `SQLitePrivatePurchaseEvidence`
on the same original `PrivateServiceDomain` and contracts, and supply it as the
coordinator's `evidence` option before the first preparation. Explicitly configure
`maximumCandidateBytes`, `maximumUpdates`, `maximumTransactions` and
`maximumDependencies`. The byte ceiling is at most 4194304; updates are 1 through
64, including the first retained proof. The transaction and dependency ceilings
are at most 4096 and 16384. Choose limits that fit the original advertised request
and the native domain's aggregate reserved capacity. A representation ceiling
alone does not establish sufficient physical storage.

Preparation reserves a native encrypted header and enough bounded chunks for
all future candidate bytes and update revisions before any payable terms leave
the host. Each data chunk reserves 197632 bytes and the header reserves 8192;
the number of chunks is `ceil(ceil(maximumCandidateBytes / 3) * 4 / 196608)`.
Include these reservations alongside the immutable purchase store's own originals,
candidate, result and completion capacity. Reservation and original preparation
are staged native transactions. A failure between them may leave a reserved proof
slot without an exposed preparation; do not silently reclaim it or substitute new
signed terms. Preserve its original identity for explicit operator reconciliation.
A database or configuration that cannot hold the complete promise refuses work.

Submission independently verifies the incoming complete evidence, proposes a
bounded union with the retained proof, and independently verifies that combined
view under the original domain and selected chain. It then pins the first immutable
financial candidate and retains the proof. Same-transaction proof variants must
name byte-identical target and shared raw transactions. The union preserves newly
supplied BEEF transactions and shared Merkle rows; it may use plain BEEF with the
same explicit target transaction ID. This does not make added rows truthful:
independent complete Script, genesis, chain and domain checks remain required.
Exact duplicates use no additional reserved update. Exhaustion refuses new proof
without discarding an already retained valid view.

Admission, release assessment and issuance receive the current durable combined
candidate, while financial intent, operation IDs and the first signed delivered
result retain their original bytes. The exact native proof revision is checked
again at the admission effect, after asynchronous release/issuance work and at
result commit. A changed view fails closed. Once delivered, additional valid proof
never repeats admission or issuance or replaces the first result.

A lost financial-pin reply can leave the original reserved proof empty. Recovery
may populate that existing slot only from the exact already retained financial
candidate, after independent incoming and combined validation. A lost proof-commit
reply recovers the original committed view without consuming another duplicate
update. Reads, preparation retries and recovery never create a missing namespace.
Close or reopen both owners with the same persistent identity and limits. The
optional owner is additive: omitted-companion calls preserve the earlier behavior,
but do not claim cumulative-proof support. Existing obligations require their
original custody owner; installing a new empty owner is not an automatic upgrade.

Native storage and coordinator tests exercise large multi-chunk evidence, richer
same-target proofs, native reopening, competing writers, exhausted capacity and
updates, lost replies at both stages, immutable delivered results and proof changes
across admission/release/signing. Their controlled lifecycle domain ports establish
these orchestration boundaries; they do not establish chain truth or real topical
admission. The separate complete domain and host demonstration supplies those
premises.

## Native disclosure and recovery

Use the same explicitly created or reopened `PrivateServiceDomain`, persistent
index/encryption custody, immutable validation policy and sealed limits. Native
records share its encrypted ledger and permanent namespace. Opening a missing
database, missing custody or a surviving fence without its original record does
not create replacement state. Whole-database rollback, physical quota and
independent backups remain operator obligations.

`disclose` checks current recipient authority, native head/record revisions,
original request binding and complete selected response capacity while holding
the writer gate through synchronous enqueue. Prepare and sign HTTP response
bytes first, then recheck the same retained record at physical enqueue. Never
send decrypted `PrivatePurchaseLoaded` material directly from an earlier read.
Current guards and enqueue ports must be synchronous. Drain physical verifier,
admission and issuer work before closing the native domain.

## Compose the optional workflow

`PrivatePurchaseCoordinator.prepare` independently validates the installed domain,
private readiness and current recipient, signs exact preparation terms, and commits
their protected reservation. `submit` verifies the complete candidate before
pinning it. `recover` consults the same original intent and advances only justified
stages. Domain validation returns a locally installed synchronous `checkCurrent`
guard; a caller-supplied boolean or serialized verdict cannot implement this port.
The admission port receives an original-intent guard which it must check before
external effects. Cancellation leaves physically outstanding work counted until it
settles; `stop` aborts new work and drains those physical operations.

`@bsv/overlay/purchase-admission` exports `OverlayPurchaseAdmission`. Install the
Engine, seller, canonical base URL, topic, immutable rules, domain profile and
required successor index explicitly. The bridge restores the original selected
capability, checks exact target BEEF and topic association, reads actual retained
history first and submits only the public transaction when needed. It never sends
protected material to topic/lookup callbacks. A lost submit reply triggers a read
of original history. Missing original commit time or an unknown operation leaves
admission unresolved. This bridge requires prior independent covenant/domain
verification and a reserved private intent; it does not supply those premises.

`@bsv/overlay-express/private-purchase` supplies `createPrivatePurchaseRouter`.
`OverlayExpress.configurePrivatePurchase` installs it using the host's shared
authentication wallet and body ceilings. Mount a standalone router before body
parsers. The explicitly selected routes are `POST /overlay/v1/purchases/prepare`,
`submit` and `recover`, under the configured base path. Prepare returns the signed
terms; submit/recover return the purchase envelope. Each response is authenticated
and its exact bytes are rechecked through `PrivatePurchaseDisclosure` immediately
before enqueue. Current recipient permission shares the native writer gate.
Wrong recipients and missing custody use fixed not-found controls. Basic malformed
transport can be refused before authentication and cannot begin private work.

These endpoints reject HTTP payment headers, never return a BRC-105 challenge, and
expose only authentication/selection headers through credential-free private CORS.
Acquisition, publication and purchase can share one handshake owner; legacy routes
remain available. The application owns closing the coordinator before its native
domain and must preserve unknown public effects for original-operation recovery.

These components have focused signature, progress, SQLite reopen, lost commit
reply, reservation, stale-writer and disclosure tests, plus 300 generated native
interruption histories. Lifecycle fixtures deliberately contain unproved
candidate bytes; they establish custody behavior, not a Bitcoin or admission
verdict. The authenticated HTTP suites use actual BRC-103 middleware and native
custody, with controlled domain/admission fixtures. They establish transport,
recipient checks, staged responses and revoked physical disclosure, not chain
truth. The native licensed-purchase composition below separately exercises the
actual domain, wallet, admission and playback path. The
[checkpoint inventory](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/CHECKPOINT2.md) links the
complete reference workflows; the checkpoint still requires final qualification
of the published source.

## One original buyer and native wallet action

### Select commitment-bound transport separately

The SDK's `verifyOutputPurchaseEnvelope` retains its exact historical-txid
contract, including when its optional expected commitment is supplied. The
separate `verifyOutputPurchaseCommitmentEnvelope` accepts a local
`OutputPurchaseCommitmentBinding` with `profile: 'full-purchase-commitment-v1'`,
the original signed `domainProfile` and the independently verified full 32-byte
`purchaseCommitment`. It authenticates the complete response and its historical
release transaction without requiring that txid to equal the original funded
candidate. Every reserved response must match the bound commitment. Original
terms, recipient, signature, policy, STEAK, POTATOES and release-evidence checks
remain in the shared verifier. Prepared and unpinned expired responses still
contain no commitment.

Select this companion explicitly with `commitmentBinding` in
`OutputPurchaseTransport` submit or recover options. Both operations retain the
original signed terms and complete original funded candidate; preparation cannot
select the companion. The constructor owns the binding and checks its domain.
It changes no HTTP request body and requests no payment. Omitted options retain
the original transport behavior. A retained binding is an input from an independent
domain verifier, rather than authority inferred from the seller's response.

This is transport authentication, rather than transaction-alias validation.
Before accepting rights, independently verify both the complete original funded
transaction and the actual released transaction, including every input, outputs,
receipt and domain lineage, against the same full commitment. Independently check
selected-chain placement before displaying a current alias. An envelope's
`currentAlias` never rewrites historical signed release evidence or grants rights.
The native buyer's existing default path still selects exact-txid transport;
native alias custody and wallet reconciliation require their separate integration.

The buyer can explicitly select `candidateProfile: 'full-purchase-commitment-v1'`
before constructing its storage binding. Its independent validation port then
supplies `candidateBinding(request, terms, candidate, signal)`, verifying the
complete original transaction, every input, domain history and acquisition. The
result owns the full 32-byte commitment and a synchronous `checkCurrent` guard.
Identity and method changes, asynchronous guards and incomplete verification
refuse submission while retaining the original funded candidate for recovery.

This installation reserves a seventh immutable protected object of 8192 bytes
before preparation or finance. Storage configuration must permit at least seven
objects and bind the selected profile; existing six-object owners cannot be
reinterpreted. The original funded transaction and exact commitment are separate
immutable records. A retry after a lost identity-write reply reads the existing
record. Historical recovery authenticates the saved domain/identity without
introducing a new chain predicate or financial action. A missing identity beside
an already delivered result is unavailable, rather than authority to initialize
replacement custody.

The explicit buyer passes that protected binding to the SDK transport. It may
retain a signed response whose historical release names a different transaction,
but that response remains received until the installed `verify` independently
checks both original and released subjects, release policy and usable private
rights. The original funded transaction is always passed to that verifier.
`currentAlias` cannot replace either subject or confer entitlement. This buyer
companion does not implement the provider's per-txid alias journal, native wallet
alias reconciliation or the current exemplar's wallet construction.

`@bsv/output-knowledge/private/purchase-buyer` supplies the portable
`PrivatePurchaseBuyer`, its installation-binding helper and initial control value,
and interchangeable payment/validation ports. The independent
`@bsv/output-knowledge/private/purchase-wallet` entry supplies the current
`WalletToolboxProfilePurchasePayment` and retained historical
`WalletToolboxPurchasePayment`, separating native Script/lineage-aware transaction
construction from authenticated HTTP orchestration. Neither entry imports a native
wallet or Node storage implementation. A native host
may supply the existing Wallet Toolbox `RecoverableActionController`; a browser
needs a durable owner exposing the same original-action semantics. A plain
BRC-100 wallet interface cannot establish recovery of a lost action reply.

Compute `privatePurchaseBuyerBinding` from the independently selected retained
capability, original request, installed wallet payment configuration and independent
validation identity. Create protected control and object owners with that exact
binding. The default installation reserves six immutable objects: request,
contract, signed terms, wallet plan, complete signed candidate and delivered result.
The control journal needs at least 16384 bytes; the object installation needs six
slots and a maximum object ceiling of 4194304 bytes. Request/candidate and
terms/result reservations use the original advertised request/response ceilings
within that upper bound. Protect the encryption keys and original store identity,
account for aggregate reserved storage, and back up the owners together.

`initialize` creates only a deliberately selected new operation. `open` checks
the exact original binding, every reservation and retained request/contract; it
does not initialize missing custody or discover a replacement seller. Large
signed lineage and BEEF reside in separate protected objects, rather than the
small control value. The explicitly selected commitment companion additionally
reserves the seventh object described above. Successful retention proves custody only. The application
must supply independent preflight, delivered-material verification and current
usability, for example the covenant LCH domain. A seller signature or STEAK
cannot supply those premises.

Use `recover` for status and lost-reply reconciliation. It never requests new
preparation, allocates or signs wallet funding, or submits a transaction. It can
consult the seller's original recovery endpoint; delivered rights already retained
locally remain readable without another wallet query. Use `advance` only when
the user has explicitly authorized finishing that original purchase. Before new
preparation or funding/signing, it checks current recipient permission, selected
domain, original cutoff and a nondecreasing clock. An already finalized retained
transaction may be submitted after the construction cutoff under the original
recovery promise. This does not authorize constructing a replacement transaction.

An installed domain may also supply `fundingPreflight` for signed terms. It
returns an owned synchronous `checkCurrent` guard, rather than discarding its
same-view assessment. The buyer retains that exact guard across awaited wallet
planning and protected custody writes, then passes it into the wallet's final
new-effect callback. A changed stage, height, authority or preparation window
therefore refuses new funding. The hook replaces signed-term `preflight` only;
unsigned discovery still uses the existing hook. Its installation identity must
bind the complete selected domain contract, and both a present hook and its
absence are pinned. Inherited, accessor, asynchronous, changed or Promise-valued
guards are refused. Omit this companion to preserve the existing preflight path.
Read-only recovery of an already finalized candidate and previously verified
entitlement does not repeat a new-funding expiry check. Installing the companion
alone does not implement transaction-alias reconciliation or establish Script,
lineage, inclusion or licensing validity.

`WalletToolboxProfilePurchasePayment` explicitly selects the current immutable
two-stage exemplar. Supply a `RevenueListingProfile`, the independently selected
chain resolver and synchronous same-context guard, and an installed recoverable
native action owner. The adapter authenticates the complete original request and
signed lineage, requires reserve-only genesis followed by valid activation and
an active target, and verifies that history before creating the plan or allocating
funding. Its separately bound format-two plan contains both frozen program hashes.
An earlier format-one plan cannot be opened as a current-profile operation.

The verified chain view, partition, generation and policy must remain unchanged
through new allocation and signing. At each financial boundary the current tip
must be below the descriptor's mandatory `expiryHeight`. A changed view or height
refuses new work while retaining any original prepared native intent. Reconcile
that intent through the same owner; never fund a replacement after a lost reply.
Already finalized recovery reads the original transaction without applying a
fresh listing-expiry or offer-eligibility test. Independent delivery, License and
key validation still govern usable rights. Neither adapter grants a right merely
because its wallet action completed.

The historical `WalletToolboxPurchasePayment` adapter installs the original wallet/storage/chain/originator
and independently selected seller, actual covenant family, chain-view resolver,
verification identity and synchronous current-context guard. It authenticates the
signed complete genesis package and independently checks lineage before creating
a wallet plan and before new native allocation/signing. The permissionless purchase
uses the actual predecessor, required successor/recipient receipt and native
`noSend` action with stable output order. Stored plan BEEF is base64, while native
wallet arguments receive the original bytes. It requests no seller signature and
never broadcasts. Fees and native funding signatures remain wallet obligations.

Both adapters share the complete native intent, exact funding/layout, bounded
submission, finalization and recovery pipeline. The historical adapter retains
its public options, format-one plans, program identity and defaults. Installed
action, family and chain-resolver owners and their methods are pinned; replacing
an owner is not a migration of an existing operation. The current adapter does
not provide listing genesis funding, fixed-child payout remittance, host alias
custody or authenticated buyer/seller composition; those integrations remain
separate checkpoint requirements.

Each script adapter permits at most one native P2PKH change output. Install
the existing Wallet Toolbox managed-change policy with
`maxOutputsPerAction: 1` and `migrationInputsPerAction: 0` for this owner, and preserve
that installation through reopen. Native commission, migration or additional
outputs that do not fit the exact covenant layout are refused. This configuration
does not change wallet defaults or ordinary actions. Before new signing, the
adapter bounds complete BEEF plus the remaining P2PKH unlocking scripts against
its declared `maximumCandidateBytes`, which must fit the originally selected
request ceiling. A refused already prepared action remains an original reserved
intent. The application must report it and use the native wallet's explicit
recovery/abort policy; a timeout or failed capacity check is not an automatic
refund, cancellation or authorization for another payment.

Call `validate` after delivered bytes are retained, then `usableResult` only when
the independent domain has established usability. Reads recheck current permission
and owner identity. Guards must complete synchronously; Promise-valued guards are
refused and rejected promises are drained. `stop` prevents new work, cancels logical
requests and waits for physically outstanding owners to settle. Stop the buyer
before closing protected stores or the wallet, and preserve uncertain original
intents through restart.

Native buyer lifecycle tests cover committed object/control replies lost after
SQLite commit, concurrent owner completion, original cutoff, physical cancellation
drain and rights retained while the original wallet is offline. Separate actual
Wallet Toolbox tests construct and sign the permissionless covenant, recover its
byte-identical transaction after native reopen and verify the complete Script,
authorized genesis and selected synthetic header history independently. Public
synthetic keys and isolated databases are used; no live chain or broadcast is
claimed. The authenticated HTTP, retained topic admission and LCH playback
composition described below exercises these components together.

The buyer owns one `OutputPurchaseTermsVerifier` for its retained original request
and selected seller. Every terms read still parses the full returned packet and
checks its request association and BRC-77 signature. Neither signed responses nor
verification verdicts are cached. Domain constraints, original candidate and
release evidence, current access, and material usability are checked by their
independent installed ports at the relevant boundary.

## Optional bounded joint custody reads

`PrivatePurchaseBuyerOptions.objectReadProfile: 'joint-custody-v1'` explicitly
selects the optional protected-object store `readMany` companion. Omit it to
preserve individual reads. A selected store must implement the companion, and
its installed method and selected profile are checked before further work.
This local read strategy changes no wire packet, payment authorization, original
binding or stored format; it neither creates a namespace nor migrates custody.

`SQLiteProtectedOperationObjectStore.readMany` owns a closed, nonempty list of
unique object IDs and their complete original bindings before reading. It
refuses selectors beyond the installed object capacity or 64 native rows; the
row count includes each object's reserved chunks. It reads every selected slot
in one fresh authenticated native transaction, verifies the same header, chunk,
reservation and immutable-object checks as `read`, and returns independently
owned statuses in request order. Missing objects remain absent. A later binding
or custody failure returns no partial result and clears earlier detached
plaintext. Callers must clear returned stored buffers when finished with them.
The buyer owns only data slots in the finite requested-role range and never
invokes reply accessors. On malformed replies, cleanup visits at most that same
range, including after an oversized-length refusal. Detached buffers and failing
cleanup descriptors cannot replace the original refusal. The companion remains
responsible for buffers omitted from, or outside, the requested reply.

The buyer uses joint reads for original reservation checks and the complete
terms/candidate/result set used in validation and playback. Existing financial
intent, phase CAS, recipient access, complete packet signatures, domain and
release verification remain separate checks. A custody snapshot establishes no
current chain, admission, mining, entitlement or spending authority. Every call
reads again; there is no retained validity cache between calls. First-result
recovery still returns the immutable original entitlement.

The current-profile fixture explicitly selects this companion. Existing buyer
properties, seeds, case deadlines and minimum 300 generated runs remain intact.
Additional native tests cover row limits, malformed selectors, partial failure,
reopening and detached mutation. These sources are under qualification; strict
compilation alone is neither a measured performance result nor checkpoint-two
acceptance.

## Choose immutable candidate custody explicitly

`SQLitePrivatePurchaseCommitmentStore`, exported from `private/node`, installs the
local `full-purchase-commitment-v1` companion. Its constructor accepts the same
domain, contracts, limits, validation policy and optional clock profile as the
historical owner. Its sealed state uses `private-purchase-state/2` and records the
candidate profile. The original `SQLitePrivatePurchaseStore` retains its
five-argument constructor, exact-txid behavior and version-one state declarations.
Neither owner reads the other's obligations as its own. Select and identify the
owner before preparation; changing a class does not migrate custody.

Construct the matching `PrivatePurchaseAccess` with
`'full-purchase-commitment-v1'` as its fourth argument. The existing three-argument
constructor continues to accept only the historical state format. The explicit
companion requires both the protected version-two state and its sealed candidate
profile before reading original private request chunks or invoking application
policy. Recipient checks still precede those reads, and native permission is
checked again at physical response enqueue. Selecting one owner cannot implicitly
authorize access to obligations created under another profile.

With the companion installed, the domain's `verify` result supplies an own data
property `purchaseCommitment` containing the independently verified full 32-byte
identity, alongside an owned synchronous `checkCurrent` method. The coordinator
captures both and checks their identity before and after invoking the guard, across
awaited admission and issuance, and inside native commit guards. A label, seller
claim or digest calculation without complete domain verification is insufficient.
An absent, inherited, accessor or changed commitment cannot reserve a purchase.
Preparation and unpinned expiry omit the commitment; every pinned status and the
first signed POTATOES packet contain the same immutable commitment. Capacity
checks include both future digest fields before preparation leaves the owner.

The persistence companion currently retains one exact submitted transaction. It
does not implement per-txid alias custody, mined-alias selection or native wallet
alias reconciliation. These remain separate requirements for the updated BRC-196
reference profile. A domain that permits equivalent transactions must independently
verify every transaction and define its equivalence rule; adding this field alone
does not authorize another transaction, charge or private release. Other domains
may keep the historical exact-txid owner.

## Choose the native purchase clock profile explicitly

Both native purchase owners accept an optional fifth constructor argument,
`'native-observation-v1'`. Install it when creating new purchase custody if progress
must be derived from the protected ledger's transaction clock observation. The
profile uses the additive synchronous `SQLiteProtectedLedger.commitPrepared`
method: check the current head and authority, derive and own a bounded write plan
from that observation, check authority again, and apply the existing native record
CAS and capacity rules in the same transaction. The frozen view expires when the callback
returns. The callback must perform local calculation only; it must not sign,
broadcast, disclose material or perform another ledger transaction.

This avoids deriving a progress timestamp in an earlier read and then refusing
every attempt because owning or sealing a large payload advanced the clock before
commit. The original exact timestamp guard remains. The observation is the native
transaction's monotonic clock sample, not a claim about the later instant when
SQLite finishes writing or about block time. Original signed terms, deadlines,
financial identity, admission and delivered result bytes remain immutable.

The default constructor and existing `commit` method preserve their prior
behavior, including timestamp-conflict refusals. Each opt-in purchase records the
profile in its authenticated private state. A differently configured owner refuses
that custody with `context-changed`; changing the profile does not migrate an
existing obligation. Older readers also refuse opt-in state. Keep the original
profile available until every retained obligation has been reconciled, and use a
separately identified installation for a new profile rather than recreating old
requests or fences. This is a local persistence choice and changes no wire packet
or payment authorization.

## Run the native licensed-purchase composition

This composition currently exercises the historical single-program sale-listing
family. It is compatibility and integration evidence, rather than qualification
of the current optional BRC-197 two-stage exemplar. The current exemplar's native
wallet, alias and selected-chain integration remains tracked in the
[specification alignment record](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/SPEC-ALIGNMENT.md).

The executable `PrivatePurchaseNative.integration.test.ts` demonstration composes
these public implementations with actual Wallet Toolbox SQLite action recovery,
full signed listing genesis and selected-chain Script verification, BRC-103/104
HTTP authentication, Engine submission, retained Mongo admission, cumulative
private proof custody, protected buyer state and LCH licence playback. Build the
workspace dependencies and run it from the repository root:

```sh
pnpm --filter @bsv/overlay-express... --filter @bsv/output-knowledge... --filter @bsv/lch... --workspace-concurrency=4 run build
pnpm --filter @bsv/overlay-express test --runInBand --runTestsByPath src/__tests__/PrivatePurchaseNative.integration.test.ts
```

Each scenario owns fresh local wallet and private SQLite databases, a randomly
named database on a three-member Mongo fixture, and loopback HTTP ports. The Mongo
fixture may download its pinned binary on first use. All identities, funding and
content keys are disclosed public fixtures. An explicit local adapter maps the
selected fixture HTTPS origin to the actual authenticated loopback listener;
it does not establish TLS termination or a live-chain outcome. Neither wallet
nor Engine has an external broadcaster installed.

The buyer first reserves its original request, contract, terms, plan, candidate
and delivered result, together with the domain's separate licence custody. The
real wallet funds and signs the permissionless listing purchase once. The seller
independently verifies the complete lineage and purchase, durably retains the
same-transaction proof, submits through the actual topic owner, and obtains the
original committed Mongo receipt. The issuer supplies recipient-bound LCH licence
material only after independently checking that original local admission. Both
roles in this local installation read the selected host's retained admission
history; a remote deployment must provide its own independently selected evidence
owner. A response claiming admission is insufficient by itself.

The scenarios cut replies after preparation, actual wallet finalization and the
first delivered authenticated response. Delivery can arrive through submission or
recovery, so its cut follows the result rather than assuming one particular
route. They reopen original seller custody, native wallet recovery, protected
buyer control/objects and LCH licence custody, and require one original allocation
and signature. The old wallet connection is closed before the reopened wallet is
installed. Seller restart here reopens its original private SQLite owner; the
HTTP listener, Engine and Mongo fixture remain running. Read-only buyer recovery
cannot start either financial effect.
The delivered bytes remain identical and decrypt the actual encrypted content
after catalogue withdrawal; a current authorization change refuses usability.

A sixth scenario submits a genuinely richer proof for the same already-delivered
raw transaction through the authenticated host. It preserves every supplied raw
transaction and proof record, adds an inclusion path at ordinary transaction
position one, and checks that path against an explicitly selected, hash/link/work
checked synthetic header view. Its synthetic sibling leaf is not proof of a
consensus-valid block body or a live-chain inclusion. Complete authorized listing
history and actual covenant execution remain required even for the proved purchase.
The cumulative owner retains the additional checked proof across native seller
restart, while the first financial candidate, original admission, delivered bytes,
local-admission release policy and licence remain unchanged. Actual admission,
issuance and wallet counters must not advance on either submission or recovery.

Plain BEEF carries no Atomic BEEF subject marker. These domain adapters therefore
select its target from the explicit purchase or lineage-entry txid and require
that exact raw transaction. Proof changes can reorder records; the last record
cannot supply a second implicit identity. An Atomic BEEF marker, when present,
must still match the explicit target. Missing raw subjects, txid-only subjects and
mislabeled atomic markers remain refusals, and all byte, dependency, Script,
economic and authorized-genesis checks still apply. Ordinary BRC-170 use is unchanged.

The concurrent-buyer scenario releases the physically held first reply as soon as
the second buyer recovers it, before additional Script and playback work. A
bounded request can nevertheless reach its unchanged deadline while held. That
specific unavailable outcome must recover the same original delivered result;
other errors fail the scenario. A deadline never authorizes another financial action.

An optimistic clock or CAS conflict is an explicit refusal, not permission to
replace a request or transaction. The demonstration performs a bounded retry
through the original durable buyer. It preserves all existing commit guards and
explicitly installs the native observation profile for new seller custody. It
never freezes the clock, changes the financial ID or signs replacement bytes.
An exhausted retry leaves the original obligation unresolved for explicit
reconciliation. The local-admission policy exercised here deliberately makes no
mining claim. The independent release-policy adapters and economic script routes
have their own qualification; this test alone does not establish their complete
composition or checkpoint readiness.

## Historical economic route compatibility with the native wallet

The following retained tests exercise the earlier sale-listing family. Merge,
schedule amendment and root transaction signatures are historical compatibility
behavior; they do not implement or qualify the current immutable two-stage
profile. Its separately selected native adapter remains an integration requirement.

`private-purchase-wallet-routes.test.ts` funds and signs purchase, split, merge,
payout, amendment and retirement through the actual Wallet Toolbox SQLite owner.
Every action closes its original connection after preparation and recovers that
same prepared intent through a fresh connection before finalization. Independent
Script and selected synthetic-chain verification checks every final transaction;
the lineage verifier checks the complete authorized genesis and both merge paths.

The example supplies dedicated public fixture authority keys separately from
wallet funding. All old recipients sign the amendment, including a recipient
removed by the new schedule; omission is refused. Payout uses weights 7:3,
distributes 693 and 297 satoshis, and retains 12 in the listing. After a unanimously
authorized 4:3 schedule change, retirement explicitly funds a two-satoshi top-up
and pays 8 and 6 to the new recipients. The required one-satoshi receipt and wallet
fees are funded separately. Retirement requires seller authorization and exact
Script-enforced recipient outputs; it does not require recipients to sign again.

Sequential `noSend` actions carry the wallet's originally identified change
outpoints under each finalized transaction ID. This allows the next action to
use those unbroadcast outputs through the existing wallet mechanism. It does not
change wallet defaults or waive input ownership. Complete history packages use
the existing compact representation: a declared ancestor's complete bytes are
retained once across the package rather than copied into every descendant BEEF.
All original covenant resource bounds remain in force; exceeding them is a
`limited` result, not permission to omit history.

Run the demonstration after building workspace dependencies:

```sh
pnpm --filter @bsv/output-knowledge test --runInBand --runTestsByPath test/private-purchase-wallet-routes.test.ts
```

These are disclosed synthetic-chain, public-key, isolated native database tests.
They perform no broadcast, establish no current unspentness or live mining, and do
not qualify a miner's fee/resource policy. Altered purchase and merge outputs
are rejected by actual Script execution; the dedicated covenant corpus separately
re-signs negative economic vectors to distinguish covenant rejection from stale
transaction signatures. Neither result substitutes for production review.
