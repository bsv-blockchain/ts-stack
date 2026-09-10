# @bsv/overlay

The core engine and storage contracts for BSV Overlay Services. The engine admits
transactions through topic managers, maintains UTXO state, serves lookup
services, and supports SHIP, SLAP, GASP, and BASM synchronization.

Use [`@bsv/overlay-express`](../overlay-express/README.md) when you want the
standard HTTP server, operational endpoints, edge policy, and health checks.
Use this package directly when you are embedding the engine in another runtime
or implementing a custom transport.

## Requirements

- Node.js 22 or newer
- `@bsv/sdk` installed as a peer dependency
- A `Storage` implementation
- A `ChainTracker`, or the explicit `'scripts only'` validation mode

## Install

```bash
npm install @bsv/overlay @bsv/sdk
```

## Create an engine

```ts
import { Engine, KnexStorage } from '@bsv/overlay'
import type { LookupService, TopicManager } from '@bsv/overlay'
import knex from 'knex'

const database = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL
})

const topicManagers: Record<string, TopicManager> = {
  tm_example: exampleTopicManager
}

const lookupServices: Record<string, LookupService> = {
  ls_example: exampleLookupService
}

const engine = new Engine(
  topicManagers,
  lookupServices,
  new KnexStorage(database),
  chainTracker,
  'https://overlay.example'
)

await engine.submit({
  beef: transaction.toBEEF(),
  topics: ['tm_example']
})

const answer = await engine.lookup({
  service: 'ls_example',
  query: { txid }
})
```

The constructor also accepts SHIP/SLAP trackers, broadcasters, an advertiser,
sync configuration, a logger, a topic-anchor header resolver, and BASM/unproven
state controls. Type declarations document the complete configuration surface.

## Public API

The root entry point exports:

- `Engine`
- `KnexStorage` and `KnexStorageMigrations`
- the topic-manager, lookup-service, storage, advertisement, and sync contracts
- BASM utilities and types
- safe structured-log serializers

`@bsv/overlay/storage` exports the `Storage` contract. Existing supported deep
imports remain available through the documented package export map, but new
applications should prefer the root entry point wherever possible.

## Runtime and package formats

The package supports both module systems:

```ts
import { Engine } from '@bsv/overlay'
```

```js
const { Engine } = require('@bsv/overlay')
```

ES modules load from `dist/esm`; CommonJS loads from `dist/cjs`. Each condition
has matching declarations. Published artifacts contain compiled output, the
README, and the license only—tests, compiler caches, workspace source, and lock
files are excluded.

## Security and operations

The engine is transport-neutral. Authentication, CORS, CSP, body limits,
timeouts, rate or concurrency controls, and administrative authorization belong
at the HTTP or application boundary.

Overlay endpoints are commonly public protocol services used by browsers,
mobile wallets, WUI, and applications on previously unknown origins. A wrapper
should therefore remain public-by-default unless an operator deliberately
configures an exact-origin allowlist. CORS is not an authentication mechanism,
and CSP for a hosted UI should be configured independently.

For production deployments:

- validate all untrusted request data before invoking the engine;
- use a durable storage implementation and tested database migrations;
- configure transaction broadcast and proof providers;
- protect administrative and callback routes with explicit credentials;
- avoid logging raw secrets, authorization headers, or unbounded payloads;
- monitor readiness, proof acquisition, synchronization, and unproven state.

`@bsv/overlay-express` supplies these standard HTTP controls while preserving
public protocol access by default.

### BASM peer validation and current recovery limits

BASM uses the current BRC-136 ordered admitted subset and block-anchored TAC.
The five existing JSON POST routes remain compatible; empty tips remain
`{ topic, blockHeight: -1, tac: <zero hash> }`. Unsupported storage capabilities
are errors, not empty histories. The remote client validates response shape,
topic/height/hash binding, ordered unique admitted positions, contiguous
returned ranges, and complete proof/raw response ID sets before use.

`BASMRemote` retains its injectable third `fetch` argument and accepts optional
limits as a fourth argument. Defaults are 64 MiB per decoded response, 8 MiB
per proof, 32 MiB per raw transaction, 100,000 admitted entries, 1,000 requested
txids, 1,024 requested anchor heights, and 30 seconds per request including its
body. Aggregate response limits also apply to hex-encoded transactions. These
are configurable local acceptance limits, not consensus rules. Standard fetch
bodies are bounded while streaming; legacy injected `text()` implementations
are checked after buffering. Classified errors expose `code`, including
`BASM_UNSUPPORTED`, `BASM_RESOURCE_LIMIT`, and `BASM_TIMEOUT`.

Reconciliation requires a canonical header resolver as well as a ChainTracker.
An optional `TopicAnchorHeader.blockTransactionCount` must come independently
from the trusted canonical provider and refer to that exact `blockHash`.
It enables full-block count/index bounds and odd-duplication checks. The sync
report's `positionValidation` is `canonical-count` only when that evidence was
available for every checked proof; legacy providers yield `encoded-offset-only`.
A Merkle root plus an encoded offset alone cannot disambiguate Bitcoin's
duplicate-last-leaf position ambiguity. No provider is required to add the
field, and the engine does not download full blocks to infer it.

Forward sync pages now contain at most 1,000 anchors to fit the standard HTTP
server. Proof height, requested original index, canonical hash/root, raw byte
identity, TAC continuity, and repeated peer anchors are checked before historical
submission. Claimed admitted-list indices are bound to the compound path whenever
a remote list is used as evidence, including when every remote txid is already
local. Inclusion uses the chain tracker root/height check rather than
`MerklePath.verify`, which also enforces coinbase 100-block spendability.
Historical mode still applies the local TopicManager and suppresses broadcast
and propagation. Automatic BASM sync remains disabled by default.

This is bounded protocol hardening, not durable recovery. An empty local node
whose topic genesis precedes the recent bootstrap window now refuses the
untrusted TAC prefix; this intentionally replaces the old unchecked tail
behavior. A block above 1,000 admitted entries reaches a request-limit error
until proof/raw chunking is implemented. Equal-height/local-ahead divergence,
whole-target bootstrap, durable cursors/leases, atomic revision fencing, and
truthful per-topic agreement status remain required follow-up work. A successful
legacy report does not establish global completeness, current unspentness, or
durable recovery completion. See [BASM details](./docs/BRC-136-BASM.md).

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay format:check
pnpm --filter @bsv/overlay lint
pnpm --filter @bsv/overlay typecheck
pnpm --filter @bsv/overlay test
pnpm --filter @bsv/overlay test:coverage
pnpm --filter @bsv/overlay pack:check
```

`pack:check` verifies the actual npm tarball with publint, strict type
resolution, and clean ESM/CommonJS consumer projects.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).
