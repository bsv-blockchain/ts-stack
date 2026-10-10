---
id: revenue-listing-authority
title: 'Historical Revenue Listing Authorities'
kind: guide
version: '1.0.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: experimental
tags: [utxo, scripts, revenue, signing, custody]
---

# Historical Revenue Listing Authorities

This guide describes the earlier root-authority family retained for compatibility.
It is not the current BRC-197 signing model. The
[immutable two-stage profile](./revenue-listing-profile.md) uses fixed public
child derivation and protected child transaction signing; its identity root
never signs a transaction or receives a payout. Select that profile for new work.

An authority key identifies who may administer a listing or consent to a revenue
schedule change. The funding wallet supplies fee inputs, signs its own inputs and
retains its own operation state. These are separate responsibilities. The optional
`@bsv/output-knowledge/revenue-listing` entry supplies `RevenueListingAuthority`
and an explicit software reference adapter for a separately provisioned authority
key. Nothing signs as a consequence of lookup, ingestion or history verification.

In this historical descriptor, the seller identity must authorize both the BRC-77
`sale-genesis` packet and the seller's Script signatures. A BRC-100 wallet protocol
derivation may expose a suitable Script public key while its ordinary BRC-77
messages identify a different root. Verifying either signature against a different
key does not bridge those identities. Never extract the funding wallet's root
secret to make them match. Provision a dedicated authority with both capabilities
and put that exact public identity in the descriptor. Recipients similarly need
the transaction-signing capability for their exact old-schedule identities.

## Explicit software and installed signing ports

`createSoftwareRevenueListingAuthority(dedicatedKey)` copies an explicitly
supplied nonzero private key and returns the checked authority adapter. The same
key produces raw Bitcoin transaction signatures and anyone-verifiable BRC-77
genesis packets. This adapter is ordinary JavaScript software, with no hardware
isolation, durable key storage, secure erasure or automatic backup. Provision,
protect and back up the dedicated key independently; losing an administrative or
recipient key can make its authorized routes unavailable. Funding wallet backup
does not implicitly include this key.

Alternatively construct `new RevenueListingAuthority(port)`. An installed
`RevenueListingAuthorityPort` has an explicit identity, `signTransaction(request)`
and `signGenesis(body)`. A hardware or remote implementation must retain its own
authorization, access, consent and key custody controls. This port is an interface
and validation boundary; it does not claim an implementation for any particular
hardware device or remote signing service. Do not expose either method as an
unauthenticated generic signing endpoint.

The adapter captures the selected identity and methods at construction. Returned
signatures must verify against that identity. It snapshots the original requests
before invoking an asynchronous signer, gives the signer separate owned copies,
and verifies the result against the retained originals. Caller or port mutation
during the wait cannot redirect the signature check. Signer failures propagate;
the adapter does not retry, replace an operation or broadcast a transaction.

## Transaction and genesis composition

First verify the selected listing's history and current operation policy, then
approve the economic plan and funded snapshot described in the
[spending guide](./revenue-listing-spends.md). Call the authority's
`signTransaction(request)` for each request returned by the prepared spend.
Choose the authority independently from the requested identity. It checks the
exact profile's preimage length, `data = SHA256(preimage)`, role, listing input
index and `ALL|FORKID` scope. A signing implementation that hashes once signs
`request.data`; a digest-signing implementation signs `SHA256(request.data)`.
Return lowercase hex containing strict DER, low-S and the final `41` byte.

The adapter checks the returned signature independently. Pass it to
`prepared.complete(...)` in the existing seller/recipient order, including both
seller signatures for a merge and every old recipient for an amendment. Complete
wallet finalization, final-layout binding, full transaction verification and
durable submission separately. A syntactically valid signing request is not proof
that a plan was approved, that a predecessor is genuine or unspent, or that a
private service will deliver. Those decisions must precede the signing call.

For genesis, call `authority.signGenesis(descriptor, genesisOutpoint)` after
approving and validating the genesis transaction. The adapter requires the selected
seller, matching chain and output zero, derives the exact listing ID, and checks
the returned BRC-77 signature over the complete `sale-genesis` body. Persist the
packet with the exact transaction and descriptor. The method authorizes a
reference; it does not inspect that transaction, establish asset rights, verify
its mining or prove its anchor. The
[history verifier](./revenue-listing-lineage.md) remains necessary for those
transaction and ancestry checks it explicitly supports.

No existing wallet method, root export, wire encoding or stored journal changes.
The independent local wallet recovery adapter is documented in the
[action recovery guide](./local-action-recovery.md); its six-route BRC-100 test
uses independently derived Script authorities and does not claim that those
wallet roots also authorize genesis. The dedicated-authority tests separately
reproduce the frozen purchase, split, merge, payout, unanimous amendment and
retirement transactions, execute the listing inputs and verify genesis under the
same seller key. These public synthetic fixtures do not demonstrate production
mining, funded live purchases or complete private fulfillment.
