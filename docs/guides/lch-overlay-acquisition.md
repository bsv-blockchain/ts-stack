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
context. Its concrete buyer domain currently implements fixed-render,
whole-Asset, direct authorized seller collection through paid lookup. It is a
minor API addition requiring the coordinated SDK3 output/revenue companions;
ordinary imports, SDK2 peers and `CORE_CAPABILITIES` stay unchanged. The full
seller HTTP, covenant and reference-application demonstrations remain unfinished
checkpoint-two work.

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

## Executable evidence

Run `pnpm --dir packages/content/lch test` for ordinary BRC-170 and the optional
profile regressions. `overlay-acquisition-paid.test.ts` exercises actual payment
and License verification, encrypted native SQLite close/reopen after Offer expiry,
equivalent reissue and authenticated playback. It checks that online proof counts
do not increase on later use. Authority tests cover actual delegated signatures,
retained revocation, missing/ambiguous paths and referenced evidence. Custody tests
cover lost originals, smaller reservations and changed entitlements. Codec tests
cover exact CBOR/JCS, evidence ordering, duplicates, unknown fields and resource
ceilings, including 300 seeded generated histories. These are component evidence;
they do not imply a finished seller service, full HTTP workflow or production
publication.
