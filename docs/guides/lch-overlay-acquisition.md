---
id: lch-overlay-acquisition
title: 'LCH Overlay Acquisition'
kind: guide
version: '0.3.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [lch, overlay, acquisition, custody, payment]
---

# LCH overlay acquisition

The optional `@bsv/lch/overlay-acquisition` entry adds the proposed
[BRC-198](https://github.com/bsv-blockchain/BRCs/pull/284) overlay profile to
ordinary licensed content. Its wire codecs cover paid lookup and covenant
context. Its concrete buyer domains implement fixed-render,
whole-Asset, authorized collector acquisition through paid lookup and covenant
purchase. The covenant domain has a separate `@bsv/lch/overlay-covenant` entry. It is a
minor API addition requiring the coordinated SDK3 output/revenue companions;
ordinary imports, SDK2 peers and `CORE_CAPABILITIES` stay unchanged. The full
covenant and reference-application demonstrations remain unfinished checkpoint-two
work. The concrete paid-lookup seller and authenticated native-wallet recovery
flow are implemented and locally tested.

## Original consent before financial work

Install `LCHOverlayPaidDomain` with complete original Header bytes, signed Offer,
signed License Request bytes, the outer acquisition request and independently
selected authenticated capability. Install a bounded content source, local proof
adapters, exact buyer wallet, clock and current-access guard. `create()` validates
these originals without quoting, allocating, signing, paying or broadcasting.
Its installation ID binds the originals, authority selection, source/proof IDs,
content ceiling, authority network and retained-revocation policy. Methods and
configuration remain pinned across asynchronous work.

The domain checks the actual Offer/Request signatures, Asset and Offer IDs,
original Request bytes, buyer consent to policy and human-term digests, service,
chain, endpoint, price, mechanisms, ciphertext and original capability binding.
The concrete policy is inline ODRL with one fixed-render Permission and one
compensation precondition. Compensation uses an Action refinement with
`payAmount`, `eq`, exact `xsd:integer` amount and the LCH satoshi unit. Unsupported
constraints, inheritance, partial selection, payment proxies, additional duties,
unknown policy terms and ambiguous JSON fail before funding. Accepted
Prohibitions remain in the derived Agreement.

Role authority is independent of a signature. The seller must be authorized to
issue the Offer and receive payment; the selected issuer must be authorized to
issue the License for every required Asset interest. Controllers act inherently.
Other actors require an explicit finite selection of actual BRC-170 Authority
chains. Missing, ambiguous, unrelated, invalid or unresolved paths fail closed.
Offer Authority references must exist in that selection. Every selected path is
validated before funding. No unbounded discovery or guessed signer role is hidden
in the adapter.

Preflight repeats these checks before new quote, planning and paid dispatch when
used as the [durable buyer](./durable-private-lookup-buyer.md)'s validation port.
It also checks the installed wallet identity, current Offer window and frozen
challenge's exact price, cutoff and recovery promise. Funded recovery uses the
retained original obligation after the Offer window closes.

## Protected local custody

Before passing the domain to a buyer, compute `lchOverlayCustodyBinding(domain.id)`
and install a durable protected immutable-object owner with that binding and the
exact recipient. Reserve at least two objects and a per-object ceiling large
enough for the complete original and 16 KiB verification slot. Call
`initializeCustody(objects)` explicitly. A buyer's own five original/payment/result
slots remain separate. SQLite and IndexedDB protected operation-object owners
implement the structural custody interface; native Node or wallet-encrypted
codecs remain explicit installation choices.

Retain `domain.id` and `domain.original()` in protected application storage.
`LCHOverlayPaidDomain.open(options, retained, objects)` checks the original
bytes and existing reservations without allocating replacements. Missing or
changed original material, lost verification capacity, wrong recipient or changed
installation refuses use. The receipt stores an entitlement digest, never
plaintext content or CEKs. These logical reservations do not guarantee physical
quota, backup integrity or detection of a wholesale storage rollback; retain the
application's [restoration policy](./protected-operation-objects.md).

## Independent acquisition verification

Install `LCHOverlayPaidVerification` from trusted local implementations. Funding
verification must execute the transaction and validate the exact BRC-29 seller
output. `SDKPrivateAcquisitionFunding.verifyForBuyer` derives the seller's public
payment key using the actual buyer wallet and performs independent Script/SPV
verification; it requires no seller private key. Listing verification must check
the selected outpoint and Atomic BEEF in the independently selected immutable
chain view. Release verification must assess the exact selected policy and return
a live `checkCurrent()` guard. A remote seller's report is evidence for these
checks, never their implementation.

`verify(request, challenge, payment, delivered, signal)` checks these proofs,
the exact signed lookup settlement, funding and release digests, original
challenge, BEEF and derivation suffix. It requires the exact compensation
fulfillment under the paid settlement profile, original IDs and buyer, persistent
whole-Asset rights, and the critical acquisition/settlement bindings. It compares
the derived Agreement, all typed evidence and finite historical role authorities.
Every expected period needs its actual BRC-78 grant, authorized sender, exact
recipient and Key-ID/CEK commitment. Only complete success commits the immutable
positive verification receipt.

Historical revocation assessments come from the installed `revocations.at(time)`
policy. They must be authenticated and retained for the actual role time. A
current live status response cannot be backdated to establish past authority.
Missing evidence remains unresolved; recovery never charges again to work around
it. The reference tests use actual signatures, ciphertext, Script/SPV and retained
local admission evidence on synthetic data.

## Retained entitlement and playback

`usable()` and explicit `playback()` require the retained positive entitlement.
They authenticate the offered representation and its exact rights/settlement
bindings again, recover recipient-bound CEKs and verify ciphertext. Playback
returns plaintext only after AES-GCM authentication and current local access.
It does not repeat online payment, listing, release or historical authority calls
for an already verified entitlement. Actual offline operation also requires an
available local ciphertext source and local wallet key recovery.

An equivalent License reissue may have a fresh BRC-77 signature, fresh BRC-78
encryption randomness and later issuance time. The retained entitlement still
requires the same Agreement bytes/digest, rights, subject/issuer, selection,
fulfilled settlement, key commitments, grant sender/recipient and original
payment/release basis. `lchOverlayPaidEntitlementDigest` identifies these repeated
commitments but explicitly does not authenticate them. A forged signature or
altered encrypted grant remains invalid even when its unverified fingerprint
matches. The generic durable buyer continues retaining its first delivered bytes
immutably.

## Concrete paid-lookup seller

`LCHOverlayPaidSeller<C>` implements the structural domain port of
`PrivateAcquisitionCoordinator` without importing an application or native store.
Install it alongside that coordinator, its protected store and its actual native
wallet credit adapter. The catalogue supplies complete original Header/Offer,
selected listing BEEF, immutable verification context, finite authority paths and
the actual CEKs. Catalogue rules must establish the application's relationship
between that outpoint and the Asset; transaction validity alone does not establish
that relationship. These rules and their digest belong in the selected service
contract.

Preparation authenticates original consent, all required roles, ciphertext and
every key commitment before quoting. It snapshots complete originals and CEKs into
bounded off-chain material for the coordinator's encrypted custody, and reserves
the conservative complete context allowance before money. CEKs never appear in
public context or the issued License. New work requires an eligible Offer; a
retained funded obligation remains recoverable after Offer expiry or catalogue
withdrawal. The stable installation and current-access guard are independent of
catalogue availability.

Issuance requires the exact retained accepted payment and native credit operation.
The mandatory `credited(operation, operationId, signal)` port must independently
read and authenticate the original native wallet's durable credit record, including
its funding, amount, wallet/storage ownership and operation ID. A serialized saved
receipt, a remote seller assertion or ordinary non-idempotent internalization does
not implement this port. This port is read-only: credit and financial recovery stay
in the coordinator and native wallet adapter.

After independent funding, listing, credit and release assessment, the seller
checks authority at the original selection, actual acceptance and actual issuance
times. It signs the exact lookup settlement, derives the Agreement retaining every
accepted Prohibition, encrypts all period CEKs to the original buyer through BRC-78
and issues the critical acquisition/settlement-bound persistent License. The
coordinator durably retains its first returned bytes before disclosing them. Lost
replies recover that original result; they do not allocate or charge again.
Unresolved credit, revocation evidence, access, ciphertext, key recovery or
chronology keeps delivery unresolved and requires restoration of the original
capability. It never selects replacement terms or a different financial operation.

Header, Offer, Request, delegation and License checks share a 256-actual-signature
budget per assessment. Identical cryptographic checks may reuse a result, with
preimage and signature separately bound in the cache key. Role, policy, current
access and historical revocation checks remain separate from that cache.

## Executable evidence

Run `pnpm --dir packages/content/lch test` for ordinary BRC-170 and the optional
profile regressions. `overlay-acquisition-paid.test.ts` exercises actual payment
and License verification, encrypted native SQLite close/reopen after Offer expiry,
equivalent reissue and authenticated playback. It checks that online proof counts
do not increase on later use. Authority tests cover actual delegated signatures,
retained revocation, missing/ambiguous paths and referenced evidence. Custody tests
cover lost originals, smaller reservations and changed entitlements. Codec tests
cover exact CBOR/JCS, evidence ordering, duplicates, unknown fields and resource
ceilings, including 300 seeded generated histories. Seller component tests exercise
real settlement/License/key issuance, withdrawal/expiry recovery, exact native
credit refusal and invalid chronology. Detached representations use the installed
bounded source during quotation, retained-material validation and issuance; the
result then passes independent buyer verification and authenticated playback.
Missing or tampered ciphertext, an oversized source response, access loss and
cancellation during a read refuse a new quote before native credit.

Run `pnpm --dir packages/overlays/overlay-express test --runTestsByPath
src/__tests__/PrivateBuyerLCH.integration.test.ts` for the complete disposable
native-wallet HTTP flow. It uses mutual BRC-103 authentication, actual native buyer
allocation/signing and seller credit, actual independent buyer Script/SPV checks,
signed settlement/License, BRC-78 grants and AES-GCM plaintext authentication. The
paid reply is lost after seller commit; buyer control, object, LCH and native action
custody reopen before unpaid recovery after Offer expiry and catalogue withdrawal.
Exactly one payment header and one seller credit remain. The fixture uses signed
synthetic funding and isolated loopback HTTP, never broadcasts, and does not qualify
TLS, production publication or the unfinished operator/workbench demonstrations.

## Reusable standing Offer and individual covenant consent

The optional covenant terms adapter separates the reusable Offer from each
buyer. Install `LCH_OVERLAY_COVENANT_MECHANISMS` explicitly, then call
`validateLCHOverlayCovenantTerms` with complete original Header, Offer and signed
Request bytes, the outer BRC-196 preparation, exact listing descriptor, bounded
reader and independently selected authenticated topic capability. E, C, S,
the fixed-render/encryption/key mechanisms and the registered BRC-197 family
must all be installed and advertised. The payment endpoint names the selected
base plus `/overlay/v1/purchases/prepare`; this flow has no BRC-105 charge.

The sole standing requirement must omit the buyer. Its policy must leave the
assignee open; the actual Request authenticates and fixes the individual
buyer. Two buyers can therefore consent to one unchanged Offer/descriptor and
receive distinct Agreements without modifying that Offer. The adapter compares
the exact anchor, seller/collector, Asset/Offer IDs, price and complete initial
revenue schedule. It requires all administrative routes under seller-v1,
unanimous current-recipient amendments, retained remainders and externally
funded exact retirement. It rejects payout-less listings and incompatible
immediate separate-payee duties. A schedule representation is not genesis or
Script proof.

`validateLCHOverlayCovenantWindow(terms, signedTerms, now)` applies the current
Offer and purchase cutoff only to new work. For an already retained obligation,
`validateLCHOverlayCovenantPromise` checks the exact signed original preparation,
selected release policy, BRC-197 domain/schema and recovery interval. The floor
is the maximum of one day, the original capability promise and the Offer's
payment recovery period. Neither function redirects an outstanding purchase to
a new listing or opens an expired Offer. Retain the original Request signature
bytes; re-signing the same body changes its outer request digest.

The accepted-policy checks are shared with the existing paid adapter. Human
term digests, explicit mechanism choices, full-Asset Selection and deterministic
Request bytes retain the same rules. Standing-offer terms alone do not establish
role authority, complete Bitcoin lineage, exact actual purchase increment,
retained topical admission, release-policy satisfaction, license validity or
usable keys. Those independent proof and issuance stages remain required for
the full covenant reference flow.

## Concrete covenant buyer and settlement

Install `LCHOverlayCovenantDomain` from `@bsv/lch/overlay-covenant` with the
complete original Header, reusable standing Offer, individual signed Request,
outer preparation, exact descriptor and independently selected capability.
Its protected original and positive verification slots follow the same custody
rules as the paid domain. `create()` checks consent and the actual buyer wallet;
it never constructs, funds, signs, submits or broadcasts a transaction.

The installed `verification.preparation` must authenticate the authorized genesis,
every related listing transition and the exact prepared outpoint before wallet
construction. `RevenueListingLineageVerifier` provides the complete Script and
selected-chain implementation. The installed `verification.purchase` must
validate the actual full transaction and both histories of any merge, and bind
the original acquisition ID, request digest, buyer, descriptor, price and receipt.
`RevenueListingPurchaseVerifier` provides that implementation. Their independently
selected chain context and currentness are local installation responsibilities.
The release port separately assesses the originally selected release policy.
Every port must return an owned synchronous `checkCurrent()` guard; unresolved,
limited, cancelled or changed proof contexts cannot become positive receipts.

`decodeLCHOverlayCovenantPurchaseEvidence` parses a closed portable lineage package
and authenticates its signed genesis commitment. That is a representation check;
it cannot replace either full Bitcoin verifier. `bindLCHOverlayCovenantSettlement`
then authenticates the collector's settlement and STEAK/POTATOES envelope against
the original signed preparation and the same transaction. It binds predecessor,
successor, initial economics, contribution amount, buyer, Request/Offer/Asset IDs,
release evidence and chronology. The C context contains purchase evidence and
cannot silently switch to paid lookup. The exact context bytes must equal the
signed POTATOES secret.

`verify(request, terms, submission, delivered, signal)` performs those bindings,
checks the original wallet transaction's raw identity, invokes full purchase and
release verification and validates the exact License, Agreement, finite typed
authority evidence and recipient-bound BRC-78 key grants. Guards are rechecked
after asynchronous key recovery. Complete success alone commits the immutable
positive entitlement. A signed License, topical admission or parseable lineage
package alone cannot authorize decryption.

`open()` restores the original domain and existing custody after Offer expiry.
`usable()` and explicit `playback()` require its locally recorded entitlement,
authenticate the signed material again and enforce current local access. They
perform no new purchase or online lineage/release assessment. Equivalent signed
reissue may vary signature and encrypted grant randomness without changing rights;
every grant is authenticated again before use. The unverified
`lchOverlayCovenantEntitlementDigest` is only a representation fingerprint, useful
inside that protected positive receipt. It is never a remote authorization token.

The disclosed synthetic native fixture executes actual genesis and purchase
transactions against the installed BRC-197 family, verifies their complete BEEF
and easy-work test chain, issues real signed C settlement/License/key grants and
decrypts real ciphertext. It closes and reopens encrypted SQLite buyer custody
after expiry. The lifecycle property checks at least 300 seeded cancellation and
local-access histories: each refusal produces no plaintext, retained originals
and the positive receipt remain identical, and restored endpoint playback still
uses one purchase. Separate tests cover equivalent reissue, corrupted encrypted
grants, changed installations, ciphertext bounds and invalid asynchronous guards.
The fixture constructs public synthetic funding directly. The reusable wallet
action owner, actual topical admission and concrete seller still need the complete
combined reference workflow; these buyer tests do not claim that workflow is done.

## Concrete covenant seller and retained purchase evidence

`LCHOverlayCovenantSeller` implements the protected purchase coordinator's domain
port. Its installation ID binds seller/issuer identities, verifier and retained
revocation-source IDs, authority network, content ceiling and purchase interval.
The catalogue supplies complete original Header/Offer, descriptor, authorized
lineage, finite role paths and actual whole-Asset CEKs. Preparation owns these
bytes, checks consent and key commitments, and independently executes full genesis
and lineage verification before returning private material and a bounded promise.
The coordinator reserves that material and future completion slots before signed
terms leave the host. CEKs belong to protected off-chain custody and never to
public lookup, ordinary topical metadata or GASP payloads.

Advertised request limits must be small enough for the complete portable C
context to fit its 2 MiB ceiling. The seller reserves conservative framing for
original lineage and its repeated signed-terms commitment, the complete accepted
request, bounded release/License/settlement fields, exact typed authority archive,
derived Agreement and every permitted 64 KiB BRC-78 payload. It also reserves the
outer base64 and response framing. It refuses an incompatible capability before
preparation; reducing an already advertised contract after purchase is invalid.
The demonstrated profile accepts 512 KiB requests and 4 MiB responses. These are
explicit installation bounds, not new defaults imposed on unrelated services.

`verify()` independently checks the complete original candidate and exact purchase
receipt before admission. `issue()` receives the native owner's complete retained
candidate as the optional fifth domain-port argument. New C issuers require it;
existing four-argument adapters continue working. Transaction ID alone cannot
replace full BEEF, and a transient in-memory candidate cache cannot substitute for
native custody after restart. Issuance independently repeats full purchase checks
and selected-release assessment, validates historical Offer/payment roles and
current License authority, and emits the exact C settlement, derived Agreement,
recipient License and encrypted key grants. It makes no wallet, admission,
broadcast or HTTP payment call. The coordinator retains the first complete result
bytes; later recovery returns that same result without another issuance or payment.

The seller component tests use the registered executable, genuine public-fixture
Bitcoin/BEEF/genesis/purchase evidence and actual buyer decryption. They cover
missing keys, wrong issuer, fabricated proof, incomplete admission, original-byte
substitution, detached source bounds, changed or asynchronous guards, finite
signed-authority archives, catalogue withdrawal and Offer expiry. At least 300
seeded histories preserve original custody while current access controls issuance.
The local native wallet test separately funds/signs/recovers all six routes,
including retained payout remainders, unanimous amendment and external retirement
top-up. These component receipts do not complete the combined native wallet,
actual topical-admission, authenticated HTTP and workbench acceptance row.
