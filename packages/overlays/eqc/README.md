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

| Option          | Default | Meaning                                                              |
| --------------- | ------- | -------------------------------------------------------------------- |
| `threshold`     | 3       | Distinct hosts that must attest one content hash before any payment. |
| `topK`          | 5       | Fastest agreeing hosts that share the fee.                           |
| `raceMs`        | 400     | Window after the first valid attestation.                            |
| `floorFeeSats`  | 1000    | Minimum total fee.                                                   |
| `maxFeeSats`    | 2000    | Budget per query; hosts with a higher floor are skipped.             |
| `feeSats`       | —       | Optional fee above the floor, capped by `maxFeeSats`.                |
| `hostTimeoutMs` | 5000    | Deadline for each host.                                              |
| `maxHosts`      | 16      | Hosts contacted per query, best reputation first.                    |

At the defaults, five hosts receive 418, 250, 166, 83, and 83 satoshis from one transaction.

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
`@bsv/auth-express-middleware`. With `@bsv/overlay-express`:

```ts
server.registerRouter('/', ({ engine, wallet }) => {
  if (wallet === undefined) throw new Error('BRC-178 requires a server wallet')
  const router = express.Router()
  createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
  return router
})
```

Providers: `overlayLookupProvider` (BRC-24 lookups, with BRC-136 topic anchors),
`messageListProvider` (BRC-33 listings, served only to the authenticated recipient), and
`bytesProvider` for any read that returns a byte string.

## Security notes

- Arrival time is measured by the client. Host-supplied timestamps are never read.
- The attestation signer, the BRC-103 session identity, and the SLAP-advertised identity must be
  the same key.
- The client creates outputs only for hosts that attested the winning hash, and makes no wallet
  call when the threshold is not met.
- `AuthFetch` pays any well-formed HTTP 402 challenge, so the transport gives it a wallet facade
  that cannot create actions. Only the payout transaction spends.
- An overlay lookup's content hash covers the sorted outpoint list. BEEF travels beside it and
  must be verified by SPV like any other BEEF.

## Specification

BRC-178 leaves several encodings open. The choices made here, including the `/economic/*`
paths and the 1000-satoshi default floor, are recorded in
[the design document](../../../docs/superpowers/specs/2026-09-18-eqc-brc178-design.md).

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
