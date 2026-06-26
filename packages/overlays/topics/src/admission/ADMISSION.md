# Token overlay admission — trust model

The token topic managers (`tm_stas`, `tm_bsv21`, `tm_dstas`) decide which outputs
to index. This note states precisely what they verify, what they delegate to
Bitcoin Script, and what is left to the overlay operator. It applies to all
three; DSTAS is the one that matters most, because it has no third-party indexer
and so the overlay is its only discovery surface.

## What Bitcoin Script already guarantees (not re-checked)

The overlay only ever sees **SPV-valid** transactions — every admitted output
comes from a transaction with a merkle proof, i.e. one that miners accepted
under consensus. The STAS/DSTAS covenant and the BSV-21 rules are enforced *in
Script* at spend time (STAS protocol study §6: "transfer correctness is verified
by miners running the standard BSV consensus rules, not by an off-chain
indexer"). So the overlay does **not** re-verify, because it can never observe a
violation:

- **Owner authorisation** — a transfer is signed by the owner key (or MPKH).
- **Transfer conservation** — `tokens in == tokens out` per asset.
- **Freeze rule** — a frozen UTXO cannot be spent under a normal owner transfer
  (§3, §6). An illegitimate frozen-spend never confirms, so it never reaches the
  overlay.
- **Confiscation / redemption rules** — likewise enforced by the covenant.

## What the overlay verifies structurally

- **Template validity** — each output must decode against the token template;
  non-token outputs are ignored.
- **Anti-inflation** — a transaction whose outputs exceed its inputs for a
  tokenId *that has inputs* is rejected in full. This is conservation applied to
  what the overlay can see; consensus enforces the authoritative version.

## What Script does NOT constrain — and the overlay's controls

**Issuance is permissionless.** Minting is just creating an output that claims a
`tokenId` / `protoID`; Script does not bind that claim to any identity. Token
*authority* is established **off-chain**, via the issuer's published
`TokenScheme` (§4: "indexers reconstruct a token's identity by combining the
on-chain locking script with the off-chain TokenScheme"). An overlay cannot
derive authority from the chain alone.

The control is `TokenIssuerPolicy` (`./issuerPolicy.ts`), passed to a topic
manager's constructor. Its `allowIssuance(tokenId)` hook is consulted **only for
issuance outputs** — a tokenId appearing in a transaction's outputs with no input
of the same tokenId (a mint, not a transfer). Transfers are never gated; they are
governed by conservation, which Script already enforces.

```ts
import { DstasTopicManager, allowlistIssuerPolicy } from '@bsv/overlay-topics'

// Permissionless (default): index every issuance.
new DstasTopicManager()

// Restricted: index only issuances of known protoIDs.
new DstasTopicManager(allowlistIssuerPolicy([protoIdA, protoIdB]))

// Custom: any predicate (e.g. look up a registry / TokenScheme cache).
new DstasTopicManager({ allowIssuance: (tokenId) => registry.isKnown(tokenId) })
```

For BSV-21 a mint's tokenId is its own outpoint (`<txid>_<vout>`), so the value
passed to `allowIssuance` is that outpoint, not a stable protoID.

## Compliance state is indexed, not enforced

Frozen DSTAS UTXOs are real on-chain state and remain **discoverable** — the
lookup service stores the `frozen` flag and `ls_dstas` accepts a `frozen` filter
(`{ ownerHash160, frozen: false }` for spendable holdings only, `true` for frozen
ones). The overlay surfaces freeze state for consumers; it does not re-enforce
the freeze rule, because Script already does (above).
