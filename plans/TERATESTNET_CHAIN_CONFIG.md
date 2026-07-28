# Teratestnet (TTN) Chain Config

> **Unapproved proposal.** This document is not an instruction to rename a
> public chain identifier. Implementation requires a current issue, inventory
> against the latest code and deployed consumers, backward-compatibility and
> migration design, conformance fixtures, release notes, and maintainer
> approval.

Goal: make the TeraTestNet network work across the stack. The canonical chain identifier is
**`ttn`** (renamed from the current `'teratest'` — see rename section). TeraTestNet is the full
display name. Most code paths fall back to testnet behavior.

Naming convention: use **`ttn`** everywhere `main`/`test` appear — both the `Chain` type value
and service hostnames (Arcade, ChainTracks). WhatsOnChain is the one exception: it reuses the
literal `test` network in its API *path* (see WoC detail below), even though the host is `woc-ttn`.

## Identifier rename: `teratest` → `ttn`

Replace the chain identifier `'teratest'` with `'ttn'` at all 14 occurrences (9 files, no test
files reference it). Coherent because `Services.ts:72` passes `this.chain` straight into the WoC
provider — the `Chain` type and the WoC `network` union must move together or the call site
type-breaks.

| File:line | Change |
|-----------|--------|
| `sdk/types.ts:17` | `Chain` union member `'teratest'` → `'ttn'` |
| `services/providers/SdkWhatsOnChain.ts:22` | ctor `network` union `'…\|teratest'` → `'…\|ttn'` |
| `services/createDefaultWalletServicesOptions.ts:84` | `case 'teratest':` → `case 'ttn':` (+ URL, edit #1) |
| `services/Services.ts:67` | WERR message string `'…or 'teratest'.'` → `'…or 'ttn'.'` |
| `utility/utilityHelpers.ts:16` | `case 'teratest':` → `case 'ttn':` (toWalletNetwork) |
| `utility/utilityHelpers.ts:32` | `case 'teratest':` → `case 'ttn':` (toLookupNetworkPreset) |
| `chaintracker/.../util/blockHeaderUtilities.ts:493` | `case 'teratest':` → `case 'ttn':` |
| `chaintracker/.../Ingest/WhatsOnChainIngestorWs.ts:57,283` | `case 'teratest':` → `case 'ttn':` |
| `chaintracker/.../Storage/ChaintracksStorageNoDb.ts:49,52` | `case 'teratest':` → `case 'ttn':` + WERR string |
| `infra/wallet-infra/src/index.ts:87,88` | comment + `allowedChains` literal `'teratest'` → `'ttn'` — **DEFERRED** (see below) |

**Breaking changes** (decide acceptable before shipping):
- `Chain` is exported from the published `wallet-toolbox` package — renaming a union member
  breaks any external consumer passing `'teratest'`.
- `BSV_NETWORK` env value: `infra/index.ts:88` allowlist gates the deployment env var. After the
  rename the env value must be `ttn`; any deployment/compose/secret set to `teratest` must update.

**Infra change deferred to a follow-up.** `infra/wallet-infra` is NOT in the pnpm workspace
(`pnpm-workspace.yaml` covers `packages/**`, not `infra/**`); it consumes the *published*
`@bsv/wallet-toolbox` (`^2.2.0`) from the registry. It cannot compile against `'ttn'` until
2.3.0 is published and its dep bumped to `^2.3.0`. So the infra edit ships in the separate
wallet-infra release (Docker build/test locally first), not in this wallet-toolbox PR.

## What TTN supports

Only a subset of ecosystem services run on TTN:

- **Arcade** — ARC-like broadcast API with SSE support. This is the broadcast happy path.
- **ChainTracks** — hosted from the same Arcade instance at a `/chaintracks` path offset.
- **WhatsOnChain** — a separate explorer API we run ourselves (tx/utxo/proof/header lookups).

No socket/WS server runs for TTN. The broadcast fallbacks that exist on main/test (GorillaPool
ARC, Bitails) are **not available on TTN at all** — kept nominally supported in code but no
fallback is ever expected to fire.

## Confirmed TTN values

| Config | TTN value |
|--------|-----------|
| ARC / Arcade broadcaster | `https://arcade-v2-ttn-us-1.bsvblockchain.tech/` |
| Chaintracks service URL | `https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/` |
| WhatsOnChain API base | `https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test` (front end is `https://woc-ttn.bsvblockchain.tech`; API is the `api.` subdomain; network path segment is `test`, NOT `ttn`/`teratest`) |
| WhatsOnChain WS / socket-v2 | none — no socket server for TTN |
| Address / WIF version bytes | testnet bytes for all non-mainnet chains — already correct, no change |
| GorillaPool ARC | unavailable (mainnet only); leave `undefined` |
| Bitails | not supported on TTN; current throw is fine, no change |

### WhatsOnChain URL detail

Front end: `https://woc-ttn.bsvblockchain.tech`
API root: `https://api.woc-ttn.bsvblockchain.tech`

The API reuses `test` as the network path segment, so it mirrors the standard WoC v1 layout.
Example block-by-height:

```
https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test/block/height/123
```

So the base to build is `https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test` and all the
provider's appended v1 paths (`/tx/{txid}/hex`, `/script/{hash}/unspent/all`, `/chain/info`,
`/block/{h}/header`, `/exchangerate`, `/txs/status`, …) work unchanged. This resolves the prior
open question about path compatibility — woc-ttn is API-compatible with WoC v1 because it serves
the same `/v1/bsv/test/*` surface.

## Architecture note

Default wallet wiring uses `ChaintracksServiceClient` (remote) — the wallet queries a remote
chaintracks service over HTTP and runs no ingestors itself. So the absence of a socket-v2 WS
endpoint for TTN is a non-issue on the default path: the remote arcade chaintracks box handles
ingestion. The client-side WoC base URL is still used for tx/utxo/proof/header lookups.

`WhatsOnChain` / `WhatsOnChainNoServices` extend `SdkWhatsOnChain`; all of them use the single
`this.URL` built in the `SdkWhatsOnChain` constructor — one place to redirect the client-side
WoC base. The constructor receives the raw `Chain` value (`Services.ts:72` passes `this.chain`
directly), so after the rename it sees `'ttn'` and must special-case it.

## Edits (default wallet-client path)

### 1. ARC default → arcade
`packages/wallet/wallet-toolbox/src/services/createDefaultWalletServicesOptions.ts:84-85`
Replace the placeholder `arc-teratest.taal.com`:
```ts
case 'ttn':
  return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech/'
```

### 2. Chaintracks URL → arcade
`packages/wallet/wallet-toolbox/src/services/createDefaultWalletServicesOptions.ts:24`
```ts
const chaintracksUrl = chain === 'ttn'
  ? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/'
  : `https://${chain}net-chaintracks.babbage.systems`
```

### 3. WoC HTTP base → woc-ttn
`packages/wallet/wallet-toolbox/src/services/providers/SdkWhatsOnChain.ts:25`
```ts
this.URL = network === 'ttn'
  ? 'https://api.woc-ttn.bsvblockchain.tech/v1/bsv/test'
  : `https://api.whatsonchain.com/v1/bsv/${network}`
```
Note the path stays `/v1/bsv/test` (TTN reuses the `test` network segment), not `/v1/bsv/ttn`.
Without the special-case, `network === 'ttn'` would build the broken `.../v1/bsv/ttn`.

## Scope: local chaintracks for TTN (not the default path)

The default path uses the remote arcade chaintracks, so the chaintracks-service-internal WoC
builders are not executed client-side. If running a *local* chaintracks for teratestnet is ever
needed, those ingestors also build WoC URLs and would need the same `ttn → woc-ttn` redirect:
- `packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Ingest/WhatsOnChainServices.ts:111,122`
- `packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Ingest/LiveIngestorWhatsOnChainPoll.ts`
- `packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Ingest/BulkIngestorWhatsOnChainCdn.ts`

No socket-v2 WS for TTN → a local chaintracks must use the HTTP poll/CDN ingestors, NOT the WS
ingestors (`LiveIngestorWhatsOnChainWs` / `BulkIngestorWhatsOnChainWs` / `WhatsOnChainIngestorWs`).

## Full inventory of chain-dependent values (reference)

Post-rename, `ttn` is the value at every site below.

- **Chain type** — `sdk/types.ts:17` — `'main' | 'test' | 'ttn' | 'mock'` (rename)
- **WoC network union** — `providers/SdkWhatsOnChain.ts:22` — `'main' | 'test' | 'stn' | 'ttn'` (rename)
- **ARC broadcaster** — `createDefaultWalletServicesOptions.ts:78` (arcDefaultUrl) — edit #1 (`case 'ttn'`)
- **Chaintracks URL** — `createDefaultWalletServicesOptions.ts:24` — edit #2 (`chain === 'ttn'`)
- **GorillaPool ARC** — `createDefaultWalletServicesOptions.ts:91` — mainnet only, returns `undefined`; no change
- **WoC HTTP base** — `providers/SdkWhatsOnChain.ts:25` — edit #3 (`network === 'ttn'`)
- **WoC WS (live/bulk)** — `Ingest/WhatsOnChainIngestorWs.ts:57,283` — testnet endpoints; none for TTN, do not use (rename case label only)
- **Genesis block params** — `chaintracks/util/blockHeaderUtilities.ts:493` — ttn uses test genesis (rename case label)
- **In-mem storage** — `chaintracks/Storage/ChaintracksStorageNoDb.ts:49` — ttn shares testData (rename case label + WERR string at :52)
- **Bitails** — `providers/Bitails.ts:27` — throws for non-main/test; correct (no TTN support)
- **SDK WalletNetwork mapping** — `utility/utilityHelpers.ts:16` — ttn → testnet (rename case label)
- **Lookup network preset** — `utility/utilityHelpers.ts:32` — ttn → `local` (rename case label)
- **LookupResolver preset (infra)** — `infra/wallet-infra/src/index.ts:157` — switch with `default → 'local'`; `ttn` hits the default automatically, **no edit needed**
- **Address/WIF version bytes** — `packages/sdk` PublicKey.ts:188 / PrivateKey.ts:285 — main/test split only; testnet bytes for all non-mainnet (keeps mainnet coins off any testnet-style address)
- **Monitor unprovenAttemptsLimit** — `monitor/Monitor.ts` — test/ttn=100, main=144
- **Infra default chain + allowlist** — `infra/wallet-infra/src/index.ts:87,88` — default `'test'`; allowlist `['main','test','ttn','mock']` (rename) — `BSV_NETWORK=ttn`
