---
id: brc197-fixed-child-wallet
title: 'Explicit Local Fixed-Child Wallet Intake'
kind: guide
version: '1.0.0'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
review_cadence_days: 30
status: experimental
tags: [wallet, utxo, private-overlays, brc197, payout]
---

# Explicit local fixed-child wallet intake

The current BRC-197 exemplar commits to one transparent BRC-42 child per
identity, using protocol `[2, "3241645161d8"]`, key ID `"brc197 authority"`
and counterparty `"anyone"`. Payout remittance carries literal
`derivationPrefix: "brc197"`, `derivationSuffix: "authority"` and the generator
public key as sender. These strings are not ordinary BRC-29 Base64 fields.
The ordinary `internalizeAction` API and its validation remain unchanged.
Never encode the literals to make that ordinary method accept them: encoding
would select a different child and could strand a payout.

Wallet Toolbox adds separately selected local
`getBrc197InternalizationCapabilities()` and `internalizeBrc197Action()` methods.
The capability checks the currently authorized storage writer and independently
matches its recipient identity and public child to protected wallet derivation.
Unsupported remote or older providers refuse explicitly. The local extension
is not a newly registered remote BRC-100 wire method, and ordinary wallet,
permissions, browser or mobile proxies do not gain it by upgrading a package.
Select a local integration deliberately; do not bypass a product's permissions
boundary to obtain it.

The selected request includes `profile: "brc197-fixed-child-v1"` and
`recipientIdentityKey`, plus the complete ordinary internalization arguments.
Every requested output must be a unique wallet payment with the exact fixed
remittance. The signer verifies complete, exactly framed AtomicBEEF against its
configured chain tracker, matches the actual protected child and its P2PKH
Script, and invokes the selected storage manager entry. The manager serializes
through its actual authorized writer. The provider matches the persisted user
identity and repeats the fixed-field and P2PKH checks before sharing the complete
existing evidence, transactional ownership, merge, spent-input and rollback
pipeline. Stored managed-output metadata retains the literal invoice fields.
No root or child private scalar leaves a wallet API.

The ordinary validator is reused for every other argument with call-local
Base64 validation scaffolding. Those placeholder bytes never enter derivation,
remittance, signing or storage. Fixed fields are independently checked first
and restored to owned argument copies before the complete selected pipeline.
Caller-selected validators or commit callbacks cannot replace that pipeline.
Ordinary calls, defaults, persisted output schema and historical recovery stay
compatible. The public derivation calculation uses established SDK primitives
so importing the ordinary wallet retains its existing SDK peer range.

Before creating and funding a listing, obtain the capability for every
recipient, independently match each identity and child to the descriptor, and
validate the complete activation transaction, chain context and protected
seller-child signing/layout support. A positive intake capability alone does
not prove those other prerequisites. It also does not establish miner fee or
resource acceptance, unspentness, asset authority, admission, private delivery,
a License, or permission to take another wallet action. A leaking public-child
scalar would reveal its root because the derivation tweak is public; this
profile makes no privacy claim.

This branch's selected intake is under qualification. The added native credit,
idempotence, wrong-recipient/wrong-Script, unsupported-writer and generated
remittance tests are source-prepared; they have not yet passed a frozen native
run. Full eight-recipient receipt, reopen and actual protected spending, every
profile route, activation-before-funding and the final package/platform/mutation
campaign remain Checkpoint 2 gates. Do not treat this guide or a capability
shape as proof that those gates have passed.
