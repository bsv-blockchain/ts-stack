---
release:
  "@bsv/sdk": patch
---
Wallet result validation, WalletClient discovery, HTTPWalletJSON and the wallet wire now accept BRC-205
getVersion strings: the base before the first semicolon stays 7-30 bytes and the whole string may be up to
2048 bytes, so toolbox wallets that append capability attributes are no longer refused.

## Migration

BRC-205 getVersion: no consumer migration is required. Base-only version strings get the same result and
error as before. Callers that relied on getVersion refusing strings longer than 30 bytes now receive the full
BRC-205 string and should read the base before the first ';'. The VersionString7To30Bytes type name is
unchanged.
