---
release:
  "@bsv/sdk": minor
---
Adds SignedMessage.signWithWallet, which produces a BRC-77 signature through a WalletInterface
(byte-compatible with SignedMessage.sign), and an optional expectedSigner option on SignedMessage.verify so a
caller can require a particular signer. Existing calls and signatures are unchanged.

## Migration

SignedMessage: no consumer migration is required. signWithWallet and the expectedSigner option are additive,
and three-argument verify calls behave as before. A caller that passes expectedSigner gets false, not a
thrown error, for a designated-verifier signature by another key even when the recipient key is missing or
wrong.
