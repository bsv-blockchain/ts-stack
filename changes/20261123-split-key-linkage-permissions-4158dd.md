---
release:
  "@bsv/wallet-toolbox": minor
---
Wallets can gate revealCounterpartyKeyLinkage and revealSpecificKeyLinkage independently. The new optional seekPermissionsForCounterpartyKeyLinkageRevelation and seekPermissionsForSpecificKeyLinkageRevelation flags each follow seekPermissionsForKeyLinkageRevelation when unset, which remains the legacy combined default (true). Counterparty linkage reveals the root ECDH shared secret for a counterparty; specific linkage reveals one per-invoice HMAC. Permission prompts for the two calls use counterpartyLinkageRevelation and specificLinkageRevelation; ensureProtocolPermission still accepts the legacy linkageRevelation usage. Client and mobile builds move in lockstep.

## Migration

No BRC-100 wire or stored-permission migration is required. Existing configs keep today's behavior.
