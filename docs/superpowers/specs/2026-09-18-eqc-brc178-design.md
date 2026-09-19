---
id: eqc-brc178-design
title: Economic Query Client (EQC) and BRC-178 Host Router — Design
kind: spec
domain: overlays
version: 1.0.0
last_updated: '2026-09-19'
last_verified: '2026-09-19'
status: experimental
tags:
  - brc-178
  - brc-136
  - eqc
  - overlays
  - message-box
  - payments
---

# Economic Query Client (EQC) and BRC-178 Host Router — Design

**Date:** 2026-09-18

**Status:** Implemented in phase 1 (package and overlay-express hook); phases 2 and 3 pending

**Scope:** A new published package `@bsv/eqc` (client, protocol core, host
handlers) and one additive hook in `@bsv/overlay-express`. Infrastructure
wiring, collection grants, and host gossip are later phases described at the
end of this document.

**Specifications implemented:**
[BRC-178](https://bsv.brc.dev/overlays/0178) (Race-Settled Collection Markets)
and, as a consistency signal for overlay lookups,
[BRC-136](https://bsv.brc.dev/overlays/0136) (Block-Anchored Overlay
Synchronization).

**Starting point:** commit `1a1b156932ca10d888bcdca561db1a2235ff2114`, the tip
of the open overlay admission stack that introduces BRC-136 anchors to
`@bsv/overlay` and `@bsv/overlay-express`. This design assumes that stack
merges.

## Goal

Let a set of independent overlay nodes and message box servers compete to
answer the same query, and let the client pay the fastest hosts that agree on
the answer. The client is the judge of arrival time. Hosts earn only when at
least `t` distinct hosts attest the same content hash, so propagating data to
peers is the path to being paid rather than an act of charity.

`new EQC(wallet)` is the client. A host adds three routes by mounting the
handlers from `@bsv/eqc/host`.

## Findings that constrain the design

These were established against the code at the starting point and drive several
decisions below.

1. **BRC-77 can be produced with a `WalletInterface` alone.**
   `SignedMessage.sign` requires a raw `PrivateKey`, but its derivation is
   `invoiceNumber = "2-message signing-<base64 keyID>"` over the "anyone"
   counterparty, signing `SHA-256(message)`. `wallet.createSignature` with
   `protocolID: [2, 'message signing']`, `keyID: base64(random 32 bytes)`, and
   `counterparty: 'anyone'` yields the same signature. Framing it as
   `42423301 ‖ signerPub(33) ‖ 00 ‖ keyID(32) ‖ DER` is byte-compatible with
   `SignedMessage.verify`. Hosts sign through their wallet; clients verify
   without any wallet call.
2. **`@bsv/payment-express-middleware` cannot verify a BRC-178 collect.** It
   requires `derivationPrefix` to be a server-minted nonce
   (`verifyNonce`), hardcodes `outputIndex: 0`, and claims replay protection
   on the whole txid. `wallet.internalizeAction` itself accepts any
   `outputIndex`, so a dedicated verifier is sufficient.
3. **`internalizeAction` requires standard base64** for `derivationPrefix` and
   `derivationSuffix` (hex and base64url are rejected by
   `validateBase64String`).
4. **An honest host broadcasts the payout itself.** wallet-toolbox
   `internalizeAction` broadcasts a transaction it has not seen. After a
   collect request is dispatched the client no longer controls whether the
   payout confirms.
5. **Overlay `output-list` answers are not byte-deterministic across honest
   hosts.** Output order is whatever the lookup service returns, and BEEF bytes
   depend on proof state, ancestor sets, and merge order.
6. **`OverlayExpress` exposes no route hook.** Routes added before `start()`
   miss CORS, body parsing, size limits, and the BRC-103 middleware; routes
   added after `start()` sit behind the catch-all 404.
7. **`infra/message-box-server` is outside the pnpm workspace** and consumes
   published `@bsv/*` packages. It cannot depend on `@bsv/eqc` until the first
   npm release.
8. **Fibonacci floors to zero at the BRC-178 recommended floor.** With `R = 2`
   and `K = 5` the payouts are `[2, 0, 0, 0, 0]`. Every one of `k` ranked hosts
   receives at least one satoshi only when `R ≥ Σ weights(k)` (12 for `k = 5`).
   The 1000-satoshi default floor chosen below removes the problem for any
   `K` up to 14.
9. **SLAP advertisements carry the host identity key.**
   `OverlayAdminTokenTemplate.decode` returns the advertiser's `identityKey`
   alongside `protocol`, `domain`, and `topicOrService`. `LookupResolver`
   discards the identity key; the EQC keeps every key advertised for a URL.
10. **`AuthFetch` pays any well-formed HTTP 402.** Its 402 branch calls
    `wallet.createAction` for whatever amount the server names, with no cap and
    no option to disable it. The EQC talks to permissionlessly advertised
    hosts, so an unguarded transport would let one malicious host drain the
    wallet. The same `Peer` answers a server's BRC-103 certificate request
    from `wallet.listCertificates` and `wallet.proveCertificate`, so an
    unguarded transport would also hand any advertised host the user's
    identity certificates.
11. **The `@bsv/overlay-express` server wallet cannot take payment.**
    `initServerWallet` builds a wallet-toolbox `Wallet` over a
    `WalletStorageManager` with no storage provider. It signs, so BRC-103,
    attestations, and deliveries work, but `internalizeAction` throws
    `Must add active storage provider to wallet`. A host needs a
    storage-backed wallet built from the same root key.

## Package

| Field             | Value                                                         |
| ----------------- | ------------------------------------------------------------- |
| Path              | `packages/overlays/eqc`                                       |
| Name              | `@bsv/eqc`                                                    |
| Version           | `0.1.0`                                                       |
| Governed profile  | `browser-library`, `tier-1`, `npm-oidc`                       |
| Consumer profiles | `browser-bundler`, `browser-esm`, `node-cjs`, `node-esm`      |
| Peer dependency   | `@bsv/sdk` only                                               |
| Build             | `tsdown`, dual CJS and ESM, modelled on `@bsv/402-pay`        |
| Tests             | vitest, fast-check property suite, registered mutation target |

Entry points:

- `@bsv/eqc` — protocol core and the `EQC` client. Browser-safe.
- `@bsv/eqc/host` — host handlers, pending-query store, payment verifier, and
  providers. Node.

The host entry does not import `express`. Handlers are typed structurally
against the small surface they use (`req.body`, `req.headers`,
`req.auth.identityKey`, `res.status().json()`, `res.set()`), so an express
`Request` and `Response` satisfy them and the package carries no `express` or
`@types/express` peer. The overlay provider is likewise typed against
`{ lookup, provideTopicAnchorTip? }` rather than importing `@bsv/overlay`.

### Source layout

```
src/
  index.ts                 client + protocol exports
  host.ts                  host exports
  protocol/
    canonicalJson.ts       RFC 8785 subset
    query.ts               EconomicQuery, validation, computeQueryId
    payloads.ts            canonical bytes per query class, contentHash
    brc77.ts               wallet-based sign, SignedMessage-based verify
    attestation.ts         attestation + delivery preimages, sign, verify
    fibonacci.ts           weights, payouts, required share
    payment.ts             BRC-29 prefix/suffix encoding, payout scripts, envelope
    params.ts              HostParams shared by client and host
    encoding.ts            canonical base64 guard
    errors.ts              error codes
  client/
    EQC.ts                 orchestration
    race.ts                race window timing and pure ranking
    consistency.ts         BRC-136 anchor assessment
    transport.ts           AuthFetch transport, per-host deadline, allowlist wallet
    settlement.ts          createAction, output re-check
    reputation.ts          ReputationStore, in-memory default, tie shuffle
    discovery.ts           free SLAP bootstrap, identity keys, overrides, cache
  host/
    handlers.ts            params, query, collect
    pendingStore.ts        bounded TTL store
    paymentVerifier.ts     locate own output, check amount, internalize
    providers.ts           overlay-lookup, message-list, and byte providers
```

Each unit has one purpose and is testable alone: `race.ts` takes attestation
arrivals and a clock and returns a ranking; `fibonacci.ts` is arithmetic;
`paymentVerifier.ts` takes a transaction, a rank, and a wallet.

## Client API

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet) // mainnet, DEFAULT_SLAP_TRACKERS

const result = await eqc.query({
  type: 'overlay-lookup',
  params: { service: 'ls_example', query: { key: 'value' } }
})

const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
const messages = await eqc.listMessages({ messageBox: 'payment_inbox' })
```

The client takes no host list. Like `LookupResolver`, it bootstraps from SLAP
trackers and its network options carry the same names and meaning as
`LookupResolverConfig`:

| Option            | Default                                 | Meaning                                                       |
| ----------------- | --------------------------------------- | ------------------------------------------------------------- |
| `networkPreset`   | `'mainnet'`                             | `mainnet`, `testnet`, `teratestnet`, or `local`.              |
| `slapTrackers`    | `DEFAULT_SLAP_TRACKERS` from `@bsv/sdk` | Trackers asked which hosts serve a lookup service.            |
| `hostOverrides`   | `{}`                                    | Per market key, hosts used in place of discovery.             |
| `additionalHosts` | `{}`                                    | Per market key, hosts used in addition to discovery.          |
| `resolver`        | a `LookupResolver` built from the above | Injection point for the free discovery lookups, used in tests |

The market key is the lookup service name for `overlay-lookup` and the query
class name for every other class. The testnet and TeraTestNet presets select
`DEFAULT_TESTNET_SLAP_TRACKERS` and `DEFAULT_TTN_SLAP_TRACKERS`.

Market options: `threshold` (3), `topK` (5), `raceMs` (400), `floorFeeSats`
(1 000), `maxFeeSats` (2 000), `feeSats`, `queryTtlMs` (30 000),
`hostTimeoutMs` (5 000), `paramsTimeoutMs` (2 000), `hostsTtlMs` (300 000),
`paramsTtlMs` (300 000), `maxHosts` (16), `reputation`, `transport`,
`originator`, `clock`, `now`. `topK` must be at least `threshold` unless
`threshold` is 1. `maxHosts` bounds the fan-out, best reputation first; hosts
of equal reputation are shuffled (Fisher-Yates over the SDK `Random`) before
the cut, so discovery order never decides who is contacted. `hostTimeoutMs`
bounds each authenticated call and `paramsTimeoutMs` each params probe.
`clock` is a monotonic millisecond source for arrival stamps; `now` is
wall-clock time for expiry, caches, and reputation.

`query()` resolves to `queryId`, `contentHash`, `payload`, `supplement`,
`ranking` (host, arrival offset, rank, payout), `txid`, `feeSats` (the total
actually paid), `attestations`, `consistency` (BRC-136, overlay lookups
only), `rejected` (per-host reasons), and `completion`.

## Host discovery

Every query begins with discovery, and discovery is never paid for separately.

1. For `overlay-lookup`, the client asks the SLAP trackers
   `{ service: 'ls_slap', query: { service } }` over the existing free BRC-24
   `/lookup` route, through `LookupResolver`. It decodes each returned output
   with `OverlayAdminTokenTemplate.decode`, keeps tokens whose protocol is
   `SLAP` and whose service matches, and records, per normalized URL, every
   distinct advertised identity key (`DiscoveredHost.identityKeys`). SLAP is
   permissionless, so the first token for a URL must not win: a third party
   advertising an honest host's URL under its own key would otherwise bind
   that URL to the wrong key, and the result would depend on tracker order.
2. For `message-list`, the client resolves the recipient's message box hosts
   with a free `ls_messagebox` lookup, as `@bsv/message-box-client` does today.
3. `hostOverrides[key]` replaces discovery; `additionalHosts[key]` extends it.
   Classes without a standard discovery path (`relay-lookup`, `message-body`)
   require one of the two.
4. Only `https` hosts are accepted unless `networkPreset` is `local`.
5. Results are cached for `hostsTtlMs`.
6. The client then reads `GET /economic/params` from each host, under
   `paramsTimeoutMs`, and keeps those that implement the market, support the
   query class, advertise a floor no higher than `maxFeeSats`, and advertise a
   `topK` no lower than the client's `topK`.

**Params caching.** A host's params are cached for `paramsTtlMs`. A 4xx answer
is the host stating it runs no market: it is cached for `paramsTtlMs` too and
is no reputation event. A timeout, a network or parse failure, and a 5xx
answer may pass, so they are negative-cached only for
`min(paramsTtlMs, 15 000)` ms, and a fresh one is a soft reputation event.
Hosts are advertised permissionlessly and every query waits for every probe,
so without the short negative cache one host that accepts the connection and
never answers would add its full probe deadline to every query; with it, the
cost is one `paramsTimeoutMs` wait per interval, and the host sorts last.

**Pricing rule.** The fee committed in the target query is understood to cover
the discovery that preceded it, because the two are almost always paired.
Hosts that take part in the market keep answering `ls_slap` on the free
`/lookup` route; trackers receive no separate output. When `ls_slap` is itself
the target of an economic query, for example
`eqc.lookup({ service: 'ls_slap', ... })`, it is raced and paid like any other
lookup.

Discovery also strengthens identity binding. When a host was found through
SLAP tokens, the BRC-103 session key, which is also the attestation signer,
must be one of the identity keys advertised for its URL. A domain answering
under a key no token names is discarded for that query as
`identity-mismatch`. Because the advertisements are third-party data, that
mismatch is a soft reputation event: it never cools down the URL. A signer
that differs from the session key is the host's own doing and stays a hard
event. Every advertised identity key populates `hostSetHint`.

## Host API

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

const host = createEconomicQueryHost({
  wallet,
  providers: [overlayLookupProvider({ engine, anchorTopics: { ls_example: ['tm_example'] } })],
  floorFeeSats: 1000
})

router.get('/economic/params', host.params)
router.post('/economic/query', host.query)
router.post('/economic/collect', host.collect)
```

`host.mount(router)` registers the same three routes. The paths are exported
as `ECONOMIC_PATHS` and shared by client and host.

`wallet` signs attestations and deliveries and internalizes payouts, so it
needs a storage provider, and its identity key must be the BRC-103 session key
of the server and the SLAP-advertised key.

| Option            | Default   | Meaning                                                                                                   |
| ----------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `threshold`       | 3         | Advertised default.                                                                                       |
| `topK`            | 5         | Advertised, and enforced: a query whose `topK` exceeds it is answered 400 `ERR_INVALID_QUERY`.            |
| `floorFeeSats`    | 1 000     | Minimum total fee; a number or a function of canonical payload size. Quoted in the signed attestation.    |
| `minPayoutSats`   | 1         | Smallest output a collect is served for.                                                                  |
| `maxQueryTtlMs`   | 60 000    | Furthest `expires` accepted.                                                                              |
| `maxPayloadBytes` | 2 097 152 | Largest estimated encoded delivery: `4⌈p/3⌉ + 4⌈s/3⌉ + 1024` for payload `p` and supplement `s` in bytes. |
| `store`           | in-memory | `PendingStore`; see Error handling for its bounds.                                                        |
| `logger`          | `console` | Receives unexpected failures and wallet errors during collect.                                            |

`maxPayloadBytes` bounds the collect response rather than the raw answer,
because the delivery is base64 inside JSON and the server a host is mounted on
limits response size. A delivery over that limit would be replaced by a 413
only after the payment was internalized. The 2 MiB default fits the smallest
`@bsv/overlay-express` response profile (4 MiB).

A provider is:

```ts
interface QueryProvider {
  type: string
  execute(
    query: EconomicQuery,
    context: { clientIdentityKey: string }
  ): Promise<{
    payload: number[]
    supplement?: number[]
    extensions?: { anchors?: TopicAnchor[] }
  }>
}
```

Providers shipped in phase 1: `overlayLookupProvider`, `messageListProvider`
(over a `listMessages(recipient, messageBox)` source), and `bytesProvider` for
`relay-lookup` and `message-body`.

`messageListProvider` rejects any query whose `params.recipient` differs from
the authenticated caller. Only the recipient can race its own inbox.

## `@bsv/overlay-express` change

One additive method:

```ts
registerRouter(path: string, factory: (context: {
  engine: Engine
  wallet: WalletInterface | undefined
}) => express.RequestHandler | Promise<express.RequestHandler>): this
```

Factories run inside `start()` immediately after the BRC-103 middleware is
mounted and before the admin routes and the 404 handler. Registered routers
therefore inherit CORS, body parsing, response size limits, and the shared
BRC-103 session, and see `req.auth.identityKey`. Calling `registerRouter`
after `start()` throws. The hook is generic; `@bsv/overlay-express` gains no
dependency on `@bsv/eqc`. Version `2.7.1` → `2.8.0`.

The `wallet` in the context is the BRC-103 authentication wallet. It has no
storage provider and cannot create or internalize actions (finding 11), so it
must not be passed to `createEconomicQueryHost`: the host would attest, the
client would pay, and every collect would fail.

Usage on an overlay node:

```ts
const hostWallet = await buildStorageBackedWallet(serverPrivateKey)

server.registerRouter('/', ({ engine }) => {
  const router = express.Router()
  createEconomicQueryHost({
    wallet: hostWallet,
    providers: [overlayLookupProvider({ engine })]
  }).mount(router)
  return router
})
```

`buildStorageBackedWallet` is supplied by the operator. It returns a wallet
with an active storage provider built from the same root key as the node, so
its identity equals the BRC-103 session key and the SLAP-advertised key.

`host.mount` registers the full `/economic/*` paths, so the router is mounted
at `/`.

## Protocol flow

```
client                                      SLAP trackers, then hosts h1..hn
POST /lookup { ls_slap, { service } } (free, LookupResolver, cached)
                                         <- SLAP tokens -> { domain, identityKeys[] }
  apply hostOverrides / additionalHosts, drop hosts in reputation cooldown
  order by reputation, shuffle ties, keep maxHosts
GET /economic/params (plain fetch, paramsTimeoutMs, cached) -> floor, t, K, classes
  drop hosts that lack the market, the class, whose floor exceeds maxFeeSats,
  or whose advertised topK is below the client's
build query; queryId = SHA-256(canonical JSON)
POST /economic/query x n (AuthFetch, parallel)
                                         -> validate, recompute queryId
                                            topK <= advertised topK
                                            provider.execute -> canonical bytes
                                            encoded delivery <= maxPayloadBytes
                                            contentHash, store pending, sign
                                         <- attestation (+ anchors extension)
stamp local arrival, then verify:
  BRC-77 signature, signer == host == BRC-103 session key, queryId
  session key is one of the SLAP keys advertised for the URL
race window = raceMs after first valid attestation
  ends early when every host answered or failed, or K hosts share one hash
winner = hash with most distinct hosts; tie -> earliest first attestation
  fewer than t hosts -> ERR_EQC_THRESHOLD, no wallet call, no payment
rank winners by arrival; k = min(K, winners)
R = max(floorFeeSats, feeSats, sum of weights(k), winners' quotedFeeSats that
    fit maxFeeSats), capped by maxFeeSats
Fibonacci payouts; zero-satoshi ranks dropped
  a rank below its host's advertised minPayoutSats gets no output and no collect
one createAction: output i pays host i under BRC-29
  prefix = base64(queryId), suffix = base64(u16be(rank)), randomizeOutputs false
  re-parse AtomicBEEF and confirm each output index
POST /economic/collect x paid hosts (payment envelope in body)
                                         -> caller == query.client, hash matches
                                            own key at ranking[rank-1]
                                            find own output by locking script
                                            satoshis >= max(minPayoutSats,
                                              floor(quotedFeeSats * weight / S))
                                            mark settling, internalizeAction
                                            wallet throws -> log, 500, release
                                         <- payload, supplement, delivery signature
first payload whose SHA-256 equals contentHash resolves the query
remaining collects finish in the background and update reputation
```

Collect goes to every paid host because a host can only claim its output once
it has received the transaction and its derivation suffix.

## Protocol decisions

Each row resolves an ambiguity or a practical conflict in BRC-178 and should be
fed back into the specification.

| #   | Topic                            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `queryId` canonical JSON         | RFC 8785 subset: recursive key sort, no whitespace, integers only (floats and unsafe integers rejected), arrays keep order, absent optional fields omitted. The host recomputes `queryId` from the parsed body and ignores any client-supplied value.                                                                                                                                                                                                                                                                       |
| 2   | Delivery signature preimage      | `BRC-178 payload\n<queryId>\n<host>\n<contentHash>\n<payloadSize decimal>`. Domain-separated so an attestation signature cannot be replayed as a delivery signature.                                                                                                                                                                                                                                                                                                                                                        |
| 3   | Derivation encoding              | `derivationPrefix = base64(32-byte queryId)`, `derivationSuffix = base64(u16be(rank))`; rank 1 is `AAE=`. Required by `internalizeAction`.                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Payment transport                | `payment: { derivationPrefix, derivationSuffix, transaction }` in the collect body, avoiding the Node 16 KiB header limit. Hosts also accept the `x-bsv-payment` header. A 402 carries `x-bsv-payment-version` and `x-bsv-payment-satoshis-required`.                                                                                                                                                                                                                                                                       |
| 5   | Broadcast timing                 | The client uses a normal `createAction`; its wallet broadcasts. BRC-178 client rule 4 asks for broadcast only after a matching payload arrives. That ordering is not enforceable: the host's `internalizeAction` broadcasts on receipt, aborting a `noSend` action after dispatch can leave the client wallet believing spent inputs are free, and a crash between `noSend` and `sendWith` strands change. Loss is bounded by `maxFeeSats` per query; hosts that take payment and fail delivery are excluded by reputation. |
| 6   | Zero-satoshi shares              | Dropped. Because payouts are non-increasing, paid ranks are always a prefix `1..m`. A host at rank `i` of `k` requires `max(minPayoutSats, floor(quotedFeeSats × weight(i) / S))`: its share of the fee it quoted, without the rank 1 remainder and never re-evaluated at collect. `minPayoutSats` defaults to 1. See the note below the table.                                                                                                                                                                             |
| 7   | Effective floor                  | `floorFeeSats = max(client option, advertised floors of candidate hosts)`, never below 1. Hosts advertising a floor above `maxFeeSats` (default 2 000) are dropped before fan-out so one host cannot inflate the fee.                                                                                                                                                                                                                                                                                                       |
| 8   | Early race end                   | The window ends `raceMs` after the first valid attestation, or sooner when every host has answered or failed, or when `K` hosts share one hash.                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | `message-list` ordering          | `messageId` compared by Unicode code point. Keys in the order `messageId`, `sender`, `body`; no whitespace; the empty list hashes `[]`.                                                                                                                                                                                                                                                                                                                                                                                     |
| 10  | `overlay-lookup` canonical bytes | `varint n ‖ [txid(32) ‖ varint outputIndex ‖ varint contextLength ‖ context]*`, entries sorted by txid hex, then output index, then context bytes, with exact duplicates removed. BEEF is returned as `supplement` outside the hash. `payload ‖ supplement` is a valid BRC-24 `application/octet-stream` body. The client confirms every listed outpoint resolves inside the BEEF. Freeform answers return 422.                                                                                                             |
| 11  | Phase 1 payload attachment       | Not implemented. Attaching the payload to an attestation releases the bytes before payment.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 12  | Replay                           | A repeated `queryId` while pending returns the stored attestation. After settlement both `query` and `collect` return 409 until expiry plus a grace period.                                                                                                                                                                                                                                                                                                                                                                 |
| 13  | Arrival time                     | Stamped from a monotonic clock when the transport promise resolves, before signature verification, so verification cost does not reorder hosts. `attestedAt` is never read for ranking.                                                                                                                                                                                                                                                                                                                                     |
| 14  | HTTP paths                       | `GET /economic/params`, `POST /economic/query`, `POST /economic/collect`, replacing the `/brc178/*` binding in the specification with a descriptive prefix. Signature domain tags such as `BRC-178 attestation` are unchanged.                                                                                                                                                                                                                                                                                              |
| 15  | Default floor                    | `floorFeeSats` defaults to 1 000 satoshis on client and host, replacing the recommended 2. At `K = 5` the split is 418, 250, 166, 83, 83, and no share floors to zero for any `K` up to 14. Operators and clients may still configure any floor of at least 1.                                                                                                                                                                                                                                                              |
| 16  | Discovery pricing                | The `ls_slap` lookup that precedes a query is answered on the free BRC-24 `/lookup` route and is covered by the target query's fee. `ls_slap` as the target of an economic query is raced and paid normally.                                                                                                                                                                                                                                                                                                                |

Decision 5 rests on reputation: `collect-failed` is a hard event, because every
collect follows a dispatched payout, so a failed collect is always a paid
non-delivery.

Decision 6 does not let a host demand its full Fibonacci payout at its own
floor. `computePayouts` gives rank 1 the rounding remainder, and the remainder
is not monotone in the fee: `computePayouts(1007, 5)[0]` is 423 but
`computePayouts(1008, 5)[0]` is 420, so a rank 1 host with a floor of 1007
would refuse a client that paid 1008 because another host's floor was one
satoshi higher. `requiredShare(feeSats, k, rank)` is the remainder-free share
`floor(feeSats × weight(rank) / S)`. It is monotone in the fee at every rank,
so every payment `R ≥ quotedFeeSats` covers it. The host takes `feeSats` from
the `quotedFeeSats` it signed and does not re-evaluate `floorFeeSats` at
collect, so a floor that moved after attestation cannot refuse a payment that
is already on the network. On the client side, a ranked host whose share is
below the `minPayoutSats` it advertises gets no output and no collect, since
it would refuse the output; the ranking the other hosts see is unchanged.

Decision 10 departs from the BRC-178 table, which hashes the full BRC-24
encoding. The BEEF section is self-authenticating: every listed txid is
committed by the hash and each transaction is verifiable by SPV, so excluding
it loses no integrity and makes agreement between honest hosts possible.

## BRC-136 in the market

For `overlay-lookup`, `overlayLookupProvider` reads
`engine.provideTopicAnchorTip(topic)` for the topics configured for the
service and returns them as an `anchors` extension on the attestation:
`[{ topic, blockHeight, blockHash, tac }]`. The extension rides inside the
BRC-103-signed response and outside the BRC-77 preimage, which BRC-178 fixes.

The client reports per-topic `consistency` for the winning group:

`blockHeight` is untrusted host input, so the reference tip for a topic is the
highest height reported by at least two distinct winners. One winner's claim,
however high, never becomes the reference; otherwise a single dishonest winner
could mark every honest host `lagging` and publish a fabricated tip. When no
height is corroborated there is no reference. The published `tac` is set only
when every winner at the reference height reports the same TAC.

| Status     | Meaning for a host                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agreed`   | At the reference height, and every winner at that height reports one TAC: those hosts agree on the topic's whole confirmed history. |
| `lagging`  | Below the reference height.                                                                                                         |
| `diverged` | At the reference height, where the winners report more than one TAC.                                                                |
| `unknown`  | Sent no anchor for the topic, claims a height above the reference, or no height was corroborated by two distinct winners.           |

A topic is `unknown` without a reference, else `diverged` if any host is,
else `lagging` if any host is, else `agreed`. A query with `threshold` 1, or
one where a single winner sends anchors, therefore always reports `unknown`.

Consistency feeds reputation, softly. A minority-hash host that is below the
reference is recorded as `lagging`. One at the reference height and TAC with a
different content hash is recorded as `diverged-answer`. Both only lower its
rank: the reference rests on anchors the winners report about themselves, so a
winning group that copies the public tip could otherwise have every honest
minority host excluded. A minority anchor that neither lags nor matches the
reference is never excused; the host is recorded as plain `minority-hash`.

BASM synchronization is the overlay counterpart of message propagation. A node
that does not reconcile falls out of the threshold set and earns nothing, which
gives operators a direct reason to enable `enableBASMSync`.

A matching TAC proves agreement on admission, not on lookup results. Bans and
janitor removals are node-local policy and can still change an answer.

## Error handling

Client errors are `EQCError` with a `code`:

| Code                     | Condition                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ERR_EQC_NO_HOSTS`       | Discovery, overrides, and the params check leave fewer market-capable hosts than `threshold`.                     |
| `ERR_EQC_BUDGET`         | The client's own `floorFeeSats` exceeds `maxFeeSats`.                                                             |
| `ERR_EQC_NO_ATTESTATION` | No valid attestation before `hostTimeoutMs`.                                                                      |
| `ERR_EQC_THRESHOLD`      | Winning hash has fewer than `threshold` hosts. Carries hash groups and consistency. No wallet call has been made. |
| `ERR_EQC_PAYMENT`        | `createAction` failed. No collect was sent.                                                                       |
| `ERR_EQC_UNDELIVERED`    | Payment dispatched and no host delivered matching bytes. Carries the txid and per-host failures.                  |

A single host's failure never throws. It is recorded in `result.rejected` with
one of `timeout`, `http`, `malformed`, `bad-signature`, `identity-mismatch`,
`wrong-query`, `minority-hash`, `late`, `collect-failed`, `hash-mismatch`.

Host responses use the repository's `{ status: 'error', code, description }`
shape:

| Status | Code                                                       |
| ------ | ---------------------------------------------------------- |
| 400    | `ERR_INVALID_QUERY`, `ERR_INVALID_COLLECT`                 |
| 401    | `ERR_AUTH_REQUIRED`                                        |
| 402    | `ERR_PAYMENT_REQUIRED`                                     |
| 403    | `ERR_FORBIDDEN_RECIPIENT`                                  |
| 404    | `ERR_QUERY_UNKNOWN`                                        |
| 409    | `ERR_QUERY_SETTLED`, `ERR_HASH_MISMATCH`, `ERR_NOT_RANKED` |
| 410    | `ERR_QUERY_EXPIRED`                                        |
| 413    | `ERR_PAYLOAD_TOO_LARGE`                                    |
| 422    | `ERR_UNSUPPORTED_CLASS`                                    |
| 429    | `ERR_TOO_MANY_PENDING`                                     |
| 500    | `ERR_INTERNAL`, with no internal detail                    |

A wallet that throws during `internalizeAction` is not a 402. The payout may
be valid and is already broadcast, so the verifier reports `wallet-error`, the
handler logs the query ID, rank, client key, payout txid, and the wallet's
message through `logger.error`, answers 500 `ERR_INTERNAL`, and releases the
settle claim so a retry can succeed. Only a wallet that answers
`accepted !== true` is a 402.

Attestation is free and runs a lookup, so the pending store is bounded by entry
count (10 000), estimated heap bytes (256 MiB), a per-client pending cap (32),
and a TTL no longer than `maxQueryTtlMs` (60 s). The byte budget counts eight
bytes per cached payload and supplement element, because a `number[]` element
is a 64-bit slot, plus two bytes per character of the stored query's canonical
JSON, so padded `params` cannot ride the free path. A full store refuses new
queries rather than evicting live ones, and never overwrites a `queryId` it
holds. An unsettled record whose `expiresAt` has passed gives up its payload
and supplement and stops counting toward the per-client cap at once, lazily on
the next `get`, `put`, or `beginSettle`; `beginSettle` refuses it. The emptied
record stays through a 60 s grace period, still counting toward the entry cap,
so a late collect is answered 410 and a settled one 409. The host sets the
settling flag before calling `internalizeAction` and clears it on failure, so
two concurrent collects cannot both deliver, and it holds the payload before
settling, so a record released mid-settlement still delivers the paid bytes.

Reputation is a `ReputationStore` interface with an in-memory default. Hard
events exclude a host for a cooldown of ten minutes and cost ten points. They
are the failures only the host itself can cause: `hash-mismatch`,
`bad-signature`, `identity-mismatch` where the signer or the collect session
differs from the session key, and `collect-failed`, which is always a paid
non-delivery. Every other event costs one point and affects ordering only:
`timeout`, `http`, `malformed`, `wrong-query`, `late`, `minority-hash`,
`lagging`, `diverged-answer`, a failed params probe, and an
`identity-mismatch` that rests on SLAP advertisements. A host that is ranked
but sent no output, because its share is below its advertised `minPayoutSats`,
appears in `rejected` as `collect-failed` with the detail
`share below host minPayoutSats` and is no reputation event. The client never
treats another party's reputation data as authoritative.

## Security

- The client is the only judge of arrival. No host-supplied time, rank, or
  ordering claim is read.
- `attestation.host`, the BRC-77 signer, and the BRC-103 session identity must
  be the same key, and that key must be one of the identity keys SLAP tokens
  advertise for the URL when the host was discovered through SLAP. Every
  advertised key is kept, so a third party's token cannot evict an honest host.
- **The threshold counts identity keys, not operators.** Identity keys and
  domains are free. A tracker, or anyone who publishes SLAP tokens, can mint
  `t` keys that attest one fabricated hash, and those are `t` valid
  attestations: the client pays them. Fabricating hosts do no lookup, so they
  are also the fastest, and the race ends as soon as `K` hosts share a hash.
  What bounds the damage: loss per query is at most `maxFeeSats`; outputs in
  an overlay answer remain SPV-checkable, so a fabricated answer can omit or
  be stale but cannot forge a transaction; a minority is never excluded on the
  winners' word (`diverged-answer` is soft); and reputation ties are shuffled,
  so a newcomer group cannot hold the `maxHosts` slots by tracker order. None
  of that makes the answer trustworthy. **For reads that carry value, pin the
  hosts with `hostOverrides`.** Anything stronger (stake, operator identity,
  host history) is a later-phase question.
- Outputs are created only for hosts that attested the winning hash.
- The transport never pays and never reveals. `AuthFetch` receives a wallet
  facade that is an allowlist: only `getPublicKey`, `createSignature`,
  `verifySignature`, `createHmac`, and `verifyHmac` reach the real wallet.
  `listCertificates` answers an empty list, so a host's BRC-103 certificate
  request is answered with nothing instead of failing the session, and every
  other method, `createAction` and `proveCertificate` included, rejects. An
  HTTP 402 challenge cannot spend and a certificate request cannot harvest
  identity certificates. Only the payout settlement calls the real
  `createAction`.
- `floorFeeSats` is a floor on a query's fee, not on a delivery. The client
  chooses the ranking length up to the host's advertised `topK`, which the
  host enforces, so the enforceable minimum per delivery is
  `max(minPayoutSats, share at rank K of K)`: 83 satoshis at the defaults.
  Operators raise it with `minPayoutSats` or a smaller `topK`.
- A host locates its output by deriving its own locking script rather than
  trusting a client-supplied index.
- `message-list` is served only to the authenticated recipient.
- The client applies a deadline to every host call (`paramsTimeoutMs` for
  params, `hostTimeoutMs` for authenticated calls) and never lets one host's
  failure fail the query. `/economic/params` is read as a stream under a
  64 KiB cap that cancels the download. Authenticated responses cannot be
  capped that way: `AuthFetch` buffers the whole BRC-104 response before the
  caller sees it and exposes no `AbortSignal`, so the 16 MiB check rejects an
  oversized answer only after it was read, and the deadline rejects the call
  without cancelling the transfer. This is an `@bsv/sdk` limitation;
  `maxHosts` and `hostTimeoutMs` bound the exposure until the SDK offers a
  byte cap or a signal.
- A host never takes payment for a delivery its server cannot send:
  `maxPayloadBytes` bounds the encoded collect response, and defaults below the
  smallest `@bsv/overlay-express` response limit.
- Host error bodies never include internal messages or stack traces.
- Lookup parameters are held only in the pending record for the life of the
  query and are not logged.

## Testing

- **Unit and property (fast-check):** payouts sum to `R`, are non-increasing,
  assign the remainder to rank 1, and reproduce both BRC-178 worked examples;
  every payout at a fee `R` covers the required share at any quote `F ≤ R`;
  canonical JSON is invariant under key order; canonical payloads are invariant
  under input order; BRC-77 signatures interoperate with `SignedMessage` in
  both directions.
- **Discovery:** a stub resolver returning real SLAP advertisement tokens;
  tokens for another service or protocol are ignored; `hostOverrides` replaces
  and `additionalHosts` extends the result; non-`https` hosts are dropped
  outside the `local` preset; hosts returning 404 for `/economic/params` are
  dropped; every key advertised for one URL is kept, in either tracker order;
  a host whose session key no SLAP token names is discarded without a
  cooldown; results are cached for `hostsTtlMs`; discovery makes no wallet
  call.
- **Race logic with a fake clock:** a backdated `attestedAt` gains nothing;
  ties; minority hash excluded; below threshold makes no wallet call.
- **Host handlers:** authentication, recipient check, replay, settlement under
  concurrent collects, payment verification against a wallet double that
  performs the real BRC-29 script check at a non-zero output index,
  underpayment returns 402, a suffix for the wrong rank is rejected; rank 1 is
  served a fee one satoshi above its floor; a wallet that throws the
  storage-less error yields a logged 500 and a released claim; a `topK` above
  the advertised one is refused; the payload cap applies to the encoded
  delivery; the store budgets the stored query and releases expired records.
- **Client scenarios through real host handlers, in process:** five honest
  hosts paid 418, 250, 166, 83, 83 by arrival order; a stale host goes unpaid;
  a hoarder, the only one of five holding the data, is the minority and earns
  nothing; below the threshold nobody is paid and no wallet call is made; a
  liar attests and serves wrong bytes, another host delivers, and the liar
  enters cooldown; a slow host misses the window; an identity spoof is
  discarded; a greedy floor is skipped; a wallet failure sends no collect; a
  host that fails its collect enters cooldown; a delivery whose supplement
  lacks a listed transaction is rejected and another host's delivery wins; a
  host that never answers is dropped at the per-host deadline in both phases;
  a tarpit params endpoint is waited on once per interval.
- **End to end over HTTP:** real express servers on ephemeral ports with the
  real `createAuthMiddleware` and the real `AuthFetch`, discovered through an
  injected `resolver` under the `local` preset (the SDK's `local` preset pins
  discovery to port 8080, which ephemeral ports cannot use). Scenarios: five
  honest hosts; a host answering with a complete HTTP 402 challenge receives
  nothing and the wallet is asked for exactly one action; a host whose live
  identity differs from its SLAP advertisement is discarded without a
  cooldown; a host whose URL a third party also advertised is kept; an
  authenticated call to a server that never answers is bounded by the
  deadline; an express
  `Router` and `Application` satisfy the structural router type at compile
  time.
- **`@bsv/overlay-express`:** a registered router is reachable, sees
  `req.auth`, precedes the 404 handler, and registration after `start()`
  throws.
- **Mutation:** a registered target over the protocol core.

## Governance and release

The new package requires entries in `governance/repository-health/projects.json`,
`baselines.json` (counts and version), `governance/package-release-notes.json`
(`0.0.0` → `0.1.0`, minor), `governance/npm-package-supply-chain.json`,
`governance/test-quality/policy.json`, `governance/mutation-testing/policy.json`
and `targets.mjs`, `governance/browser-artifact-policy.json` with a
`browser-budget.json`, a page under `docs/packages/overlays/`, the package
indexes, `docs-site/src/lib/nav.ts`, `scripts/configure-ts-stack-npm-trust.sh`,
the hardcoded counts in `scripts/*.test.mjs`, and the lockfile. Generated files
come from `pnpm contributor-policy:sync`, `pnpm license:sync`,
`pnpm docs:packages`, and `pnpm docs:facts`.

`@bsv/overlay-express` takes a minor version, a changelog entry, README and
package documentation updates, a release-note entry, and a baseline version
update. Migration for both packages: none required; both changes are additive.

Validation runs from a worktree outside the repository directory, with a full
build before typecheck. Nothing is published, tagged, pushed, or deployed
without explicit operator authorization.

## Later phases

**Phase 2, after the first npm release of `@bsv/eqc`.** Mount the routes in
`infra/message-box-server` and `infra/overlay-server`. Add a `collectionGrant`
column, migration, OpenAPI entries, and regenerated types to the message box
server. Give `@bsv/message-box-client` multi-host anointing and send fan-out.
Known obstacles in the current server:

- A forwarded message is stored with `sender` set to the forwarding host, so
  canonical lists can never agree.
- `messageId` is globally unique with no idempotent insert.
- `anointHost` spends the previous advertisement, limiting an identity to one
  host.
- Acknowledgement and retention are per host and drift apart.
- The server wraps per-host payment outputs into the stored `body`, so the same
  paid message hashes differently on each host. One shared payment envelope
  across hosts is needed.

**Phase 3.** Collection grants end to end (sender attaches, host stores and
releases to the authenticated recipient, recipient spends the grant into the
Fibonacci outputs, so a recipient with no BSV can collect). Sender-signed
gossip envelopes between hosts. Optional query deposits.
