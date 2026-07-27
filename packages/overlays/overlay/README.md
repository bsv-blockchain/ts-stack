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

Open BSV License. See [LICENSE.txt](./LICENSE.txt).
