---
release:
  "@bsv/wallet-toolbox": minor
  "@bsv/overlay-express": minor
  "@bsv/overlay-discovery-services": patch
---
Arcade was renamed to BSV Broadcaster (https://github.com/bsv-blockchain/broadcaster).
wallet-toolbox adds `BsvBroadcaster` (import path `services/providers/BsvBroadcaster`),
`TaskBsvBroadcasterSSE`, `BSV_BROADCASTER_POST_BEEF_CONCURRENCY` and
`validateBsvBroadcasterTxData`. overlay-express adds `BsvBroadcasterProvider`,
`BsvBroadcasterProviderConfig`, `BsvBroadcasterMerkleProof` and
`OverlayExpress.configureBsvBroadcaster`. Every old Arcade name, and the
`services/providers/Arcade` and `ArcadeProvider.ts` import paths, remains as a deprecated
alias of the new one, so existing code compiles and behaves identically. Every alias site
is tagged `remove-arcade-alias`.

Nothing on the wire or in storage changes: the `arcadeUrl`, `arcadeApiKey` and
`arcadeConfig` options, the `arcade*` OverlayExpress fields, the `*_ARCADE_URL`
environment variables, the public `arcade-*` hostnames, HTTP paths and headers, the
`arcade` and `Arcade` provider names, history-note `what` values and the `ArcadeSSE`
monitor task name stay as they were. overlay-discovery-services changes only in README
wording.

## Migration

No consumer migration is required. Code may move from the deprecated Arcade names to the
`BsvBroadcaster` names at any time; both refer to the same class and values.
