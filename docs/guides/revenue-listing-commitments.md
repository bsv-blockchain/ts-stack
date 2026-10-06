---
id: revenue-listing-commitments
title: 'Purchase Commitments and Public Child Keys'
kind: guide
version: '1.0.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: experimental
tags: [utxo, sdk, private-overlays, recovery]
---

# Purchase commitments and public child keys

BRC-197 is an optional reference transaction domain for private-overlay
acquisition. The shared discovery, protected-operation and private-acquisition
ports support other independently specified domains. Its current definition is
[BRC PR295](https://github.com/bsv-blockchain/BRCs/pull/295) at immutable commit
`1b9a75e497b5856675af1ce01fd86843c37d07f9`.

A purchase has a stable economic commitment and one or more exact transaction
identifiers. `revenueListingPurchaseCommitment(transaction)`, exported through
`@bsv/sdk/script/templates/RevenueListingSpend`, calculates the complete 32-byte
SHA256d digest of the listing input's `SIGHASH_ALL|FORKID` preimage. The caller
supplies complete input-zero predecessor evidence. The calculator owns the bytes,
checks the source identity and purchase header/layout, and preserves the full
digest without reducing it modulo the curve order. It does not execute Script,
authenticate genesis, resolve conflicts or establish mining. Accept its result
only after the installed purchase domain verifies those independent premises.

`RevenueListingPurchaseVerifier` returns `purchaseCommitment` only after its
configured complete purchase verification succeeds. Qualifying that verifier for
the replacement frozen Script family remains a separate implementation gate.
Both unchanged signed purchase examples in the current independent BRC corpus
match the SDK calculation and closed envelope checks.

`verifyOutputPurchaseEnvelope` accepts an optional fourth argument containing
the independently established commitment. It requires an identical commitment
in every post-reservation BRC-197 result and its signed POTATOES. It continues to
require the exact historical release txid, policy and release evidence. Other
domains retain their existing optional-field behavior; interpreting a domain's
candidate identity remains that domain's responsibility.

An envelope may carry `currentAlias: {txid, beef}` as separate, unverified
transport evidence. The client independently verifies every input, the purchase
receipt, complete lineage, the matching commitment and selected-chain placement.
An advertised digest or similar outputs cannot establish equivalence. A later
current alias must not rewrite historical POTATOES, settlement, License or their
release evidence. Before first issuance, mined-policy release may select a fully
verified mined and admitted alias. Durable alias custody, bounded work and native
recovery remain acceptance items in the
[alignment inventory](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/SPEC-ALIGNMENT.md).

The same optional SDK family entry exports `revenueListingChildPublicKey(root)`
and the fixed authority protocol/key constants. Public derivation follows
BRC-42/BRC-29 with protocol `[2, "3241645161d8"]`, key ID `"brc197 authority"`,
and counterparty `anyone`. It returns a compressed public key; it neither obtains
nor returns the identity's private scalar. Fixed reuse is deliberately transparent
and makes no privacy claim. The current independent seller/recipient vectors and
the protected BRC-100 wallet's public derivation agree across the property profile.

The derived child is the future Script authority or P2PKH payout destination;
the root identity remains the independently authenticated identity. Applications
receive public keys and signatures through protected wallet interfaces. They
must never obtain a derived private scalar. On-chain activation must verify the
public links, and recipient wallet integration must verify and spend fixed-child
remittance before value is locked. Public key calculation alone proves none of
those integration steps.

These helpers are implemented parts of an ongoing pre-adoption replacement.
They do not qualify the complete replacement Script, native wallet, acquisition
or LCH flow. The
[checkpoint inventory](https://github.com/bsv-blockchain/ts-stack/blob/codex/utxo-application-runtime/specs/output-knowledge/CHECKPOINT2.md) identifies
the remaining integration and exact-source qualification requirements.
