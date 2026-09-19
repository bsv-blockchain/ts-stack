# @bsv/eqc

Economic Query Client for [BRC-178](https://bsv.brc.dev/overlays/0178) race-settled collection
markets. Independent overlay nodes and message box servers answer the same query. The client
ranks them by the time their answers actually arrive and pays the fastest hosts that agree on
the answer, so propagating data to peers is how a host becomes eligible to be paid.

## Install

```bash
npm install @bsv/eqc @bsv/sdk
```

`@bsv/sdk` is a peer dependency. The package has no other runtime dependency.

## Usage

### Client

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet)

const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
const messages = await eqc.listMessages({ messageBox: 'payment_inbox' })

const result = await eqc.query({
  type: 'overlay-lookup',
  params: { service: 'ls_example', query: { key: 'value' } }
})
console.log(result.ranking, result.txid, result.consistency)
```

The client takes no host list. Like `LookupResolver`, it bootstraps from `DEFAULT_SLAP_TRACKERS`
and accepts the same network options: `networkPreset`, `slapTrackers`, `hostOverrides`, and
`additionalHosts`. Every query begins with an `ls_slap` lookup on the free BRC-24 `/lookup`
route; the fee of the query that follows covers it. An `ls_slap` lookup issued as the target of
`eqc.lookup` is raced and paid like any other.

| Option            | Default | Meaning                                                                           |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `threshold`       | 3       | Distinct host identity keys that must attest one content hash before any payment. |
| `topK`            | 5       | Fastest agreeing hosts that share the fee; hosts advertising less are skipped.    |
| `raceMs`          | 400     | Window after the first valid attestation.                                         |
| `floorFeeSats`    | 1000    | Minimum total fee.                                                                |
| `maxFeeSats`      | 2000    | Budget per query; hosts with a higher floor are skipped.                          |
| `feeSats`         | —       | Optional fee above the floor, capped by `maxFeeSats`.                             |
| `hostTimeoutMs`   | 5000    | Deadline for each authenticated call to a host.                                   |
| `paramsTimeoutMs` | 2000    | Deadline for each `/economic/params` probe.                                       |
| `maxHosts`        | 16      | Hosts contacted per query, best reputation first, ties in random order.           |

At the defaults, five hosts receive 418, 250, 166, 83, and 83 satoshis from one transaction. A
ranked host whose share is below the `minPayoutSats` it advertises gets no output and no collect
request, because it would refuse the output; it appears in `result.rejected` with
`share below host minPayoutSats`, and `result.feeSats` is the total actually paid.

A host's `/economic/params` is cached for five minutes, and so is a 4xx answer, which means the
host runs no market. A timeout, a network or parse failure, or a 5xx answer is remembered for at
most 15 seconds, so a host that stalls its probe costs one `paramsTimeoutMs` wait per interval
rather than one per query.

Reputation is local to the client. A host that serves wrong bytes, signs with the wrong key, or
fails a collect (every collect follows a dispatched payout) is excluded for ten minutes. Timeouts,
late or minority answers, and a session key that no SLAP advertisement names only lower its rank.

`query()` resolves as soon as one paid host delivers bytes whose `SHA-256` equals the attested
content hash. Collects to the other paid hosts continue in the background; `result.completion`
resolves when they finish, and `result.rejected` lists every host that failed and why.

Failures are `EQCError` with a `code`: `ERR_EQC_NO_HOSTS`, `ERR_EQC_BUDGET`,
`ERR_EQC_NO_ATTESTATION`, `ERR_EQC_THRESHOLD` (nothing was paid), `ERR_EQC_PAYMENT`, and
`ERR_EQC_UNDELIVERED` (carries the payout `txid`).

Query parameters are hashed as canonical JSON, which allows integers but not fractional numbers.

### Host

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

const host = createEconomicQueryHost({
  wallet,
  providers: [overlayLookupProvider({ engine, anchorTopics: { ls_example: ['tm_example'] } })]
})
host.mount(router) // GET /economic/params, POST /economic/query, POST /economic/collect
```

The handlers are typed structurally, so an express `Router` or `Application` satisfies them and
this package does not depend on express. Mount them behind `express.json()` and
`@bsv/auth-express-middleware`.

`wallet` signs attestations and deliveries and internalizes payouts, so it must have a storage
provider. Its identity key must be the key the server authenticates with over BRC-103 and the key
its SLAP token advertises.

With `@bsv/overlay-express`, do not pass the `wallet` the router factory receives. That wallet is
the BRC-103 authentication wallet: it has no storage provider and cannot create or internalize
actions, so the host would attest, the client would pay, and every collect would fail. Build a
storage-backed wallet from the same root key as the node instead:

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

`buildStorageBackedWallet` is yours to supply: it returns a wallet with an active storage
provider, built from the private key the overlay server was configured with.

If the wallet throws while internalizing, the host logs the query ID, rank, client key, and payout
`txid` through `logger.error` and answers 500, never 402: the payout is already on the network and
the log line is what lets the operator claim it later.

| Option            | Default | Meaning                                                                  |
| ----------------- | ------- | ------------------------------------------------------------------------ |
| `threshold`       | 3       | Advertised default threshold.                                            |
| `topK`            | 5       | Advertised, and the largest `topK` accepted; more is answered 400.       |
| `floorFeeSats`    | 1000    | Minimum total fee, a number or a function of the canonical payload size. |
| `minPayoutSats`   | 1       | Smallest output a collect is served for.                                 |
| `maxQueryTtlMs`   | 60000   | Furthest `expires` accepted.                                             |
| `maxPayloadBytes` | 2 MiB   | Largest estimated encoded delivery attested.                             |

`floorFeeSats` is a floor on the fee of a query, not on what this host earns from a delivery. The
host is held to the fee it quoted in its signed attestation: at rank `i` of `k` it requires
`floor(quotedFeeSats × weight(i) / S)`, without the rounding remainder rank 1 is paid, so any fee
at or above the quote is served at every rank. The client chooses `k` up to the host's `topK`, so
the enforceable minimum per delivery is `max(minPayoutSats, share at rank K of K)`: 83 satoshis at
the defaults. Raise `minPayoutSats` or lower `topK` to raise it; clients skip a host whose
`topK` is too small for them and send no output below its `minPayoutSats`.

`maxPayloadBytes` is compared against the estimated size of the collect response: base64 of the
payload and of the supplement plus 1024 bytes of envelope. Keep it below the response limit of
the server the routes are mounted on, because a larger delivery is replaced by a 413 only after
the payment was internalized. The 2 MiB default fits the smallest `@bsv/overlay-express` response
profile (`MAX_RESPONSE_BYTES` is 4 MiB on `small`, 8 MiB on `standard`).

The pending store holds each attested answer until it is collected or expires. Its byte budget
counts the cached payload and the stored query, and an unsettled record gives up its bytes and its
per-client slot the moment it expires.

Providers: `overlayLookupProvider` (BRC-24 lookups, with BRC-136 topic anchors),
`messageListProvider` (BRC-33 listings, served only to the authenticated recipient), and
`bytesProvider` for any read that returns a byte string.

## Security notes

- Arrival time is measured by the client. Host-supplied timestamps are never read.
- The attestation signer and the BRC-103 session identity must be the same key, and that key must
  be one a SLAP token advertises for the host's URL. SLAP is permissionless, so every key
  advertised for a URL is kept: a third party's token cannot evict an honest host.
- The threshold counts identity keys, not operators. Identity keys are free: a tracker, or anyone
  who publishes SLAP tokens, can mint `threshold` keys and domains that agree on a fabricated
  answer. Loss stays bounded by `maxFeeSats` per query and overlay outputs remain SPV-checkable,
  but omissions and stale answers are not detectable. For reads that carry value, pin the hosts
  you trust with `hostOverrides`.
- The client creates outputs only for hosts that attested the winning hash, and makes no wallet
  call when the threshold is not met.
- Hosts are untrusted, and `AuthFetch` would pay any well-formed HTTP 402 challenge and answer a
  BRC-103 certificate request. The transport therefore gives it a wallet facade that forwards only
  `getPublicKey`, `createSignature`, `verifySignature`, `createHmac`, and `verifyHmac`. It lists
  no certificates and rejects every other call. Only the payout transaction spends.
- `/economic/params` is read with a 64 KiB cap that stops the download. Authenticated responses
  are different: `AuthFetch` buffers the whole response before this package sees it and offers no
  way to cancel, so the 16 MiB response cap rejects an oversized answer only after it was read.
  This is an `@bsv/sdk` limitation. `maxHosts` and `hostTimeoutMs` bound the exposure.
- An overlay lookup's content hash covers the sorted outpoint list. BEEF travels beside it and
  must be verified by SPV like any other BEEF.

## Specification

BRC-178 leaves several encodings open. The choices made here, including the `/economic/*`
paths and the 1000-satoshi default floor, are recorded in
[the design document](../../../docs/superpowers/specs/2026-09-18-eqc-brc178-design.md).

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
