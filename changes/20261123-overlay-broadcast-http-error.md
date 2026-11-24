---
release:
  "@bsv/sdk": minor
---
HTTPSOverlayBroadcastFacilitator.send now rejects a non-2xx answer with OverlayBroadcastHTTPError, which keeps the HTTP status and the first 8 KiB of the response body while the message stays 'Failed to facilitate broadcast'. The body is untrusted, server-controlled text: do not render it as HTML or log it unescaped. validateSTEAK is now exported.

## Migration

No consumer migration is required.
