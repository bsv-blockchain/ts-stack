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

A recipient checks its own child with `getPublicKey({ protocolID: [2,
"3241645161d8"], keyID: "brc197 authority", counterparty: "anyone",
forSelf: true })`. The public-key API defaults to the counterparty side; omitting
`forSelf: true` selects a different point. Signing and spending remain protected
inside the recipient wallet and use its own derived private child.
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

Protected spending follows the wallet's existing lifecycle. In default automatic
batch mode, a `noSend` action reserves its input and removes it from wallet-visible
spendable outputs. The stored spent flag changes when the batch commits through
`sendWith`; staging alone is not a persisted spend. Explicit legacy mode retains
its existing immediate persistence. Applications must retain and complete the
original action through the selected wallet lifecycle rather than interpreting a
raw storage flag as permission to spend a reserved output again.

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

The complete frozen Linux funding and intake profile passes all 65 tests in its
original ten suites, including credit, idempotence, wrong-recipient/wrong-Script,
unsupported-writer and generated remittance checks. Eight independent recipients
receive public synthetic fixed-child P2PKH payments, reopen, spend through their
protected wallets, commit and reopen again in both automatic and legacy modes.
The native purchase, current Script, state-clock and Chaintracks regression
profiles also pass. This is component evidence. Every protected profile route,
activation-before-funding, durable alias recovery and the final hosted,
package/platform/mutation campaign remain Checkpoint 2 gates. A capability shape
or a passing receipt example does not establish those broader prerequisites.

The fixed-child recipient identity must be a canonical lowercase compressed
secp256k1 key. The validator checks the point and requires its compressed
re-encoding to match the supplied bytes exactly; coordinates reduced modulo the
curve field cannot become a different accepted identity. This is specific to the
explicit fixed-child capability and does not change ordinary BRC-29 intake.

Native lifecycle fixtures independently cover a new mined receipt and existing
no-send receipts with and without a proof. Merging retains the transaction's
pre-existing accounting amount while its newly owned outputs change wallet
balance. The proof and request lifecycle, original transaction identity, fixed
remittance, labels and idempotent replay are asserted separately. Complete
current-head hosted qualification remains required.
