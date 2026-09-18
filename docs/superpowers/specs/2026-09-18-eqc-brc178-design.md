---
id: eqc-brc178-design
title: Economic Query Client (EQC) and BRC-178 Host Router — Design
kind: spec
domain: overlays
version: 1.0.0
last_updated: '2026-09-18'
last_verified: '2026-09-18'
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

**Status:** Approved design, not yet implemented

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
   discards the identity key; the EQC keeps it.

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
    fibonacci.ts           weights, payouts
    payment.ts             BRC-29 prefix/suffix encoding, payout scripts, envelope
    errors.ts              error codes
  client/
    EQC.ts                 orchestration
    race.ts                pure ranking, injected clock
    transport.ts           AuthFetch transport with per-host deadline
    settlement.ts          createAction, output index re-check
    reputation.ts          ReputationStore + in-memory default
    discovery.ts           free SLAP bootstrap, identity keys, overrides, cache
  host/
    handlers.ts            params, query, collect
    pendingStore.ts        bounded TTL store
    paymentVerifier.ts     locate own output, check amount, internalize
    providers/
      overlayLookup.ts
      messageList.ts
      bytes.ts             relay-lookup, message-body
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
`hostTimeoutMs` (5 000), `hostsTtlMs` (300 000), `paramsTtlMs` (300 000),
`reputation`, `transport`, `originator`, `clock`. `topK` must be at least
`threshold` unless `threshold` is 1.

`query()` resolves to `queryId`, `contentHash`, `payload`, `supplement`,
`ranking` (host, arrival offset, rank, payout), `txid`, `attestations`,
`consistency` (BRC-136, overlay lookups only), and `rejected` (per-host
reasons).

## Host discovery

Every query begins with discovery, and discovery is never paid for separately.

1. For `overlay-lookup`, the client asks the SLAP trackers
   `{ service: 'ls_slap', query: { service } }` over the existing free BRC-24
   `/lookup` route, through `LookupResolver`. It decodes each returned output
   with `OverlayAdminTokenTemplate.decode`, keeps tokens whose protocol is
   `SLAP` and whose service matches, and records `{ domain, identityKey }`.
2. For `message-list`, the client resolves the recipient's message box hosts
   with a free `ls_messagebox` lookup, as `@bsv/message-box-client` does today.
3. `hostOverrides[key]` replaces discovery; `additionalHosts[key]` extends it.
   Classes without a standard discovery path (`relay-lookup`, `message-body`)
   require one of the two.
4. Only `https` hosts are accepted unless `networkPreset` is `local`.
5. Results are cached for `hostsTtlMs`.
6. The client then reads `GET /economic/params` from each host and keeps those
   that implement the market, support the query class, and advertise a floor no
   higher than `maxFeeSats`.

**Pricing rule.** The fee committed in the target query is understood to cover
the discovery that preceded it, because the two are almost always paired.
Hosts that take part in the market keep answering `ls_slap` on the free
`/lookup` route; trackers receive no separate output. When `ls_slap` is itself
the target of an economic query, for example
`eqc.lookup({ service: 'ls_slap', ... })`, it is raced and paid like any other
lookup.

Discovery also strengthens identity binding. When a host was found through a
SLAP token, the advertised identity key must equal the BRC-103 session key and
the attestation signer. A domain answering under a different key than it
advertised on-chain is discarded as `identity-mismatch`. Discovered identity
keys populate `hostSetHint`.

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
as `ECONOMIC_PATHS` and shared by client and host. `floorFeeSats` defaults to
1 000 and may be a function of payload size. A provider is:

```ts
interface QueryProvider {
  type: string
  execute(
    query: EconomicQuery,
    context: { clientIdentityKey: string }
  ): Promise<{
    payload: number[]
    supplement?: number[]
    extensions?: Record<string, unknown>
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

Usage on an overlay node:

```ts
server.registerRouter('/', ({ engine, wallet }) => {
  if (wallet === undefined) throw new Error('BRC-178 requires a server wallet')
  const router = express.Router()
  createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
  return router
})
```

`host.mount` registers the full `/economic/*` paths, so the router is mounted
at `/`.

## Protocol flow

```
client                                      SLAP trackers, then hosts h1..hn
POST /lookup { ls_slap, { service } } (free, LookupResolver, cached)
                                         <- SLAP tokens -> { domain, identityKey }
  apply hostOverrides / additionalHosts, drop hosts in reputation cooldown
GET /economic/params (plain fetch, cached) -> floor, t, K, classes
  drop hosts that lack the market, the class, or whose floor exceeds maxFeeSats
build query; queryId = SHA-256(canonical JSON)
POST /economic/query x n (AuthFetch, parallel)
                                         -> validate, recompute queryId
                                            provider.execute -> canonical bytes
                                            contentHash, store pending, sign
                                         <- attestation (+ anchors extension)
stamp local arrival, then verify:
  BRC-77 signature, signer == host == BRC-103 session key == SLAP key, queryId
race window = raceMs after first valid attestation
  ends early when every host answered or failed, or K hosts share one hash
winner = hash with most distinct hosts; tie -> earliest first attestation
  fewer than t hosts -> ERR_EQC_THRESHOLD, no wallet call, no payment
rank winners by arrival; k = min(K, winners)
R = max(floorFeeSats, feeSats, sum of weights(k)), capped by maxFeeSats
Fibonacci payouts; zero-satoshi ranks dropped
one createAction: output i pays host i under BRC-29
  prefix = base64(queryId), suffix = base64(u16be(rank)), randomizeOutputs false
  re-parse AtomicBEEF and confirm each output index
POST /economic/collect x paid hosts (payment envelope in body)
                                         -> caller == query.client, hash matches
                                            own key at ranking[rank-1]
                                            find own output by locking script
                                            satoshis >= required share
                                            mark settling, internalizeAction
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
| 6   | Zero-satoshi shares              | Dropped. Because payouts are non-increasing, paid ranks are always a prefix `1..m`. A host requires `max(minPayoutSats, its Fibonacci share at its own floor)`; `minPayoutSats` defaults to 1.                                                                                                                                                                                                                                                                                                                              |
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

| Status     | Meaning                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agreed`   | Same height and same TAC. `t` independent hosts agree on the answer and on the topic's complete confirmed history through that height. |
| `lagging`  | A host reports a lower tip height.                                                                                                     |
| `diverged` | Same height, different TAC.                                                                                                            |
| `unknown`  | Host sent no anchors.                                                                                                                  |

Consistency feeds reputation. A minority-hash host that is `lagging` takes a
soft penalty. A host with the same height and TAC as the winners but a
different content hash takes a hard penalty, because its admission state
matches and only its lookup answer differs.

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

Attestation is free and runs a lookup, so the pending store is bounded by entry
count, total bytes, a per-client pending cap, and a TTL no longer than
`maxQueryTtlMs` (60 s). The host sets the settling flag before calling
`internalizeAction` and clears it on failure, so two concurrent collects cannot
both deliver.

Reputation is a `ReputationStore` interface with an in-memory default. Hard
events (`hash-mismatch`, `bad-signature`, `identity-mismatch`, same TAC with a
different hash) exclude a host for a cooldown of ten minutes. Soft events
(`timeout`, `late`, `lagging`) affect ordering only. The client never treats
another party's reputation data as authoritative.

## Security

- The client is the only judge of arrival. No host-supplied time, rank, or
  ordering claim is read.
- `attestation.host`, the BRC-77 signer, and the BRC-103 session identity must
  be the same key, and must equal the SLAP-advertised identity key when the
  host was discovered through SLAP.
- SLAP trackers are trusted only to name candidates. A tracker that returns
  false hosts can waste a fan-out slot but cannot cause a payment, because
  payment still requires `t` valid attestations of one hash.
- Outputs are created only for hosts that attested the winning hash.
- A host locates its output by deriving its own locking script rather than
  trusting a client-supplied index.
- `message-list` is served only to the authenticated recipient.
- The client caps every response read, applies a per-host deadline, and never
  lets one host's failure fail the query.
- Host error bodies never include internal messages or stack traces.
- Lookup parameters are held only in the pending record for the life of the
  query and are not logged.

## Testing

- **Unit and property (fast-check):** payouts sum to `R`, are non-increasing,
  assign the remainder to rank 1, and reproduce both BRC-178 worked examples;
  canonical JSON is invariant under key order; canonical payloads are invariant
  under input order; BRC-77 signatures interoperate with `SignedMessage` in
  both directions.
- **Discovery:** a local stub tracker serving real SLAP tokens on `/lookup`;
  tokens for another service or protocol are ignored; `hostOverrides` replaces
  and `additionalHosts` extends the result; non-`https` hosts are dropped
  outside the `local` preset; hosts returning 404 for `/economic/params` are
  dropped; a host whose session key differs from its SLAP key is discarded;
  results are cached for `hostsTtlMs`; discovery makes no wallet call.
- **Race logic with a fake clock:** a backdated `attestedAt` gains nothing;
  ties; minority hash excluded; below threshold makes no wallet call.
- **Host handlers:** authentication, recipient check, replay, settlement under
  concurrent collects, payment verification against a wallet double that
  performs the real BRC-29 script check at a non-zero output index,
  underpayment returns 402, a suffix for the wrong rank is rejected.
- **End to end:** several real express servers on ephemeral ports with the real
  `createAuthMiddleware` and the real `AuthFetch`, discovered through the stub
  tracker by an injected `resolver` under the `local` preset (the SDK's `local`
  preset pins discovery to port 8080, which ephemeral ports cannot use).
  Scenarios: five honest
  hosts; a stale host goes unpaid; a hoarder (one of five holds the message,
  `t = 3`) results in no payment to anyone; a liar attests and serves wrong
  bytes, another host delivers, and the liar enters cooldown; a slow host
  misses the window; an identity spoof is discarded.
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
