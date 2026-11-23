---
release:
  "@bsv/sdk": patch
---
HTTPWalletJSON keeps typed isError envelopes, including WERR_REVIEW_ACTIONS, WERR_INVALID_PARAMETER and WERR_INSUFFICIENT_FUNDS. An HTTP 400 JSON object without isError and with a string message of at most 4096 UTF-8 bytes now throws an Error whose message includes that text and HTTP status 400. A string name and code of at most 128 characters are copied onto the error. Blank, non-string or oversized messages, non-400 statuses and isError envelopes keep their existing errors.

## Migration

No wire or call migration is required.
