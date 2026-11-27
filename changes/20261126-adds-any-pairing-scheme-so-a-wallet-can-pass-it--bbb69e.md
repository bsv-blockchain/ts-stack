---
release:
  "@bsv/wallet-relay": minor
---
Adds ANY_PAIRING_SCHEME so a wallet can pass it to parsePairingUri and pair with QR codes built for other wallets' deep-link schemes; web and executable schemes stay rejected.

## Migration

No consumer migration is required. The parsePairingUri default and explicit acceptedSchemas allowlists are unchanged; wallets opt in by passing ANY_PAIRING_SCHEME.
