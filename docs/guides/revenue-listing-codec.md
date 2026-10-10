---
id: revenue-listing-codec
title: 'Historical Revenue Listing Script Codec'
kind: guide
version: '1.0.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: experimental
tags: [utxo, sdk, scripts, revenue]
---

# Historical Revenue Listing Script Codec

This guide covers the retained earlier codec and executable family. It does not
describe the current BRC-197 programs, immutable schedule or expiry rules.
New installations use the [immutable two-stage profile](./revenue-listing-profile.md);
the earlier codec remains available only for explicitly selected compatibility.

The historical SDK interface provides the locking-script and revenue-state
codec at `@bsv/sdk/script/templates/RevenueListing`. It uses portable byte arrays,
BigInt and the SDK's existing cryptographic primitives. The module is a separate
entry point; importing the ordinary SDK does not add this codec or an executable
program artifact to the browser bundle.

```typescript
import {
  RevenueListing,
  parseRevenueListingDescriptor,
  revenueListingId
} from '@bsv/sdk/script/templates/RevenueListing'

// Load the pinned program from the application's reviewed local artifact store.
// This library performs no implicit download or compilation.
function recognize(program: Uint8Array, script: Uint8Array, descriptorInput: unknown) {
  const family = new RevenueListing(program)
  const descriptor = parseRevenueListingDescriptor(descriptorInput)
  return { listingId: revenueListingId(descriptor), state: family.decode(script, descriptor) }
}
```

The constructor requires exactly 39,580 bytes with the registered SHA-256
`ae47a6cc9bdc955d6aa73cdc459bbd6bbe493419dcf3ed3fc952a95c8c510716`.
It takes an owned copy. Obtain those bytes from the [frozen earlier-draft artifact](https://github.com/bsv-blockchain/BRCs/blob/9dade70dd17d48efb087a2c5da56bb53c164383e/tokens/media/0197/program.hex)
by decoding its hex, and pin the source in the application build. A compiler
version, matching source text or recognizable `ROSL` prefix is insufficient.
The exact program remains outside the core SDK bundle and has no automatic
upgrade path under this immutable family identifier.

`lock(descriptor)` encodes the initial revenue schedule. Supplying a second
argument encodes an explicit current schedule. `decode(scriptBytes, descriptor)`
requires the full 40,008-byte script, including the exact executable, descriptor
commitments and canonical metadata. It returns an owned current schedule.
`encodeRevenueListingState` and `decodeRevenueListingState` handle its exact
305-byte representation independently.

A schedule has one through eight valid compressed keys in byte order. Positive
integer weights define a payout quantum, with a total no greater than 10,000.
The codec preserves weights exactly: 2:2 and 1:1 have different quanta. It rejects
duplicates, invalid points, zero weights, excessive totals and nonzero unused
slots. Revisions retain the full unsigned 64-bit range without passing through
a JavaScript number. The immutable descriptor's initial revision is zero;
an explicit current schedule may have a later revision.

The descriptor binds its anchor to the same chain, selects the exact registered
family, and limits positive purchase price and reserve to the BRC-100
SatoshiValue maximum. Its hash continues to identify the listing after an
authorized schedule amendment. The codec does not infer authorization from
an increased revision or from supplied recipient keys.

Recognition is only one step. Callers still need transaction and Script
verification, seller-authorized genesis, both histories through every merge,
the installed domain policy and currentness evidence. A copied valid script
does not establish any of those facts. Similarly, encoding a changed schedule
does not prove the old recipients consented, and identifying a listing does
not establish a purchase or permit private fulfillment.

The separate [spend guide](./revenue-listing-spends.md) covers six-route planning,
funded transaction binding and raw transaction signatures. Full lineage validation,
BRC-100 wallet integration, private fulfillment and application demonstrations
remain separate tracked parts of the implementation checkpoint.

The tests compare exact bytes against the frozen BRC genesis artifact and cover
descriptor binding, changed executable bytes, state boundaries and owned buffers.
The property suite independently checks revision, recipient, weight and padding
offsets across at least 300 schedules. Existing SDK exports and storage formats
are unchanged; consumers opt into the new entry point explicitly.

The separate packed entry measures 153,909 raw bytes with Vite and 117,219
with esbuild. Its ceilings are 170,000 and 130,000 raw bytes respectively,
with independent gzip/Brotli ceilings. The exact-tarball browser check passes
for this entry and the existing root and UMD entries, whose ceilings are unchanged.
These checks qualify bundle composition and exports; native application execution
remains part of the separate integration qualification.
