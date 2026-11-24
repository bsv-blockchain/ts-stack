---
release:
  "@bsv/sdk": minor
---
LivePolicy accepts an optional second constructor argument { policyUrl, httpClient } so the fee rate can be read
from any ARC-compatible /v1/policy endpoint through an injected HttpClient. The default endpoint, client
resolution, caching, fallback and LivePolicy.getInstance() are unchanged.

## Migration

LivePolicy endpoint: no consumer migration is required; both options are optional and the default endpoint,
client, cache and fallback rate are unchanged. To use another network, pass a configured LivePolicy to
Transaction.fee() instead of relying on the default.
