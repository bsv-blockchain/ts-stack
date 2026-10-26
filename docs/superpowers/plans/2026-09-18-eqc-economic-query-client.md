---
id: eqc-economic-query-client-plan
title: Economic Query Client (EQC) — Implementation Plan
kind: spec
domain: overlays
version: "n/a"
last_updated: "2026-09-19"
last_verified: "2026-09-19"
status: experimental
tags: [brc-178, eqc, overlay, message-box, payments, plan]
---

# Economic Query Client (EQC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@bsv/eqc` — a BRC-178 client (`new EQC(wallet)`), protocol core, and host handlers — plus an additive `registerRouter` hook in `@bsv/overlay-express`, so independent hosts can race to answer a query and be paid by arrival order.

**Architecture:** One package with two entry points. `@bsv/eqc` holds the protocol core (canonical hashing, BRC-77 attestations, Fibonacci payouts, BRC-29 derivation) and the `EQC` client (SLAP discovery, fan-out, client-judged race, one payout transaction, collect, verify). `@bsv/eqc/host` holds framework-agnostic handlers typed structurally so express satisfies them without being imported. `@bsv/overlay-express` gains a generic `registerRouter` hook that mounts extra routers after its BRC-103 middleware.

**Tech Stack:** TypeScript (NodeNext, strict), `@bsv/sdk` (peer), tsdown (dual CJS/ESM), vitest + fast-check, express 5 and `@bsv/auth-express-middleware` (dev only, for end-to-end tests), jest (existing `@bsv/overlay-express` suite).

**Spec:** `docs/superpowers/specs/2026-09-18-eqc-brc178-design.md` — read it before starting any task.

## Global Constraints

- Work only in the worktree root `/Users/personal/git/ts-stack/.claude/worktrees/eqc-economic-query-client-9f9bde`. Run every command from that root. Do not `cd` inside compound commands; use `pnpm --filter` or absolute paths.
- Branch `claude/eqc-economic-query-client-9f9bde`, based on `1a1b156932ca10d888bcdca561db1a2235ff2114`. Never push, publish, tag, or deploy.
- Read `AGENTS.md` and `CONTRIBUTING.md` at the root before editing.
- Tooling: Node `>=24.11`, `pnpm@10.33.2`. Published package manifests declare `"engines": { "node": ">=22" }` exactly.
- Formatting is the root Prettier config: no semicolons, single quotes, `printWidth` 100, no trailing commas, `arrowParens: avoid`. Lint is root oxlint with `--deny-warnings`. No package-local lint or format config.
- Relative imports end in `.js` (NodeNext).
- `@bsv/sdk` is a `peerDependency` (`^2.4.1`) and a `devDependency` (`workspace:^`). It must never appear in `dependencies`.
- `packages/overlays/eqc/src/**` (non-test files) must not import `express`, `@bsv/overlay`, or any `node:` module. `src/protocol/**` and `src/client/**` must stay browser-safe.
- HTTP paths are exactly `/economic/params`, `/economic/query`, `/economic/collect`.
- Defaults are exactly: `threshold` 3, `topK` 5, `raceMs` 400, `floorFeeSats` 1000, `maxFeeSats` 2000, `queryTtlMs` 30000, `hostTimeoutMs` 5000, `hostsTtlMs` 300000, `paramsTtlMs` 300000, `maxHosts` 16, host `minPayoutSats` 1, host `maxQueryTtlMs` 60000, reputation cooldown 600000.
- Signature domain tags are exactly `BRC-178 attestation` and `BRC-178 payload`. BRC-77 signatures use protocol `[2, 'message signing']` to counterparty `'anyone'`.
- BRC-29 protocol ID is `[2, '3241645161d8']`. `derivationPrefix = base64(32 raw queryId bytes)`. `derivationSuffix = base64(u16be(rank))`; rank 1 is `AAE=`. Key ID is `` `${derivationPrefix} ${derivationSuffix}` ``.
- The client never lets `AuthFetch` pay: the transport gives `AuthFetch` a wallet facade whose `createAction` and `signAction` throw.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Before the first test run in a fresh checkout: `pnpm install` then `pnpm --filter "@bsv/eqc..." build` (builds `@bsv/sdk` and `@bsv/auth-express-middleware`, which resolve through `dist/`).

## File Structure

```
packages/overlays/eqc/
  package.json  tsconfig.json  tsconfig.build.json  tsconfig.typecheck.json
  vitest.config.ts  .gitignore  README.md  browser-budget.json
  LICENSE.txt  AGENTS.md                      (generated in Task 18)
  src/
    index.ts                 client + protocol exports (browser-safe)
    host.ts                  host exports
    protocol/
      canonicalJson.ts       RFC 8785 subset serializer
      query.ts               EconomicQuery, DEFAULTS, ECONOMIC_PATHS, validateQuery, computeQueryId
      fibonacci.ts           fibonacciWeights, sumOfWeights, computePayouts
      payloads.ts            canonical bytes per class, contentHash, rebuildLookupAnswer
      brc77.ts               signBRC77 (wallet), verifyBRC77 (SignedMessage)
      attestation.ts         Attestation, Delivery, preimages, sign, parse, verify
      payment.ts             derivationPrefix/Suffix, PaymentEnvelope, payoutLockingScript
      errors.ts              EQCError, HostError
      protocol.property.test.ts   fast-check suite (registered with governance)
    client/
      race.ts                runRace (timing), decideRace (pure ranking)
      consistency.ts         BRC-136 anchor assessment
      reputation.ts          ReputationStore, InMemoryReputationStore
      discovery.ts           HostDiscovery (free SLAP bootstrap)
      transport.ts           HostTransport, AuthFetchTransport, nonPayingWallet
      settlement.ts          planPayouts, settle
      EQC.ts                 orchestration
    host/
      pendingStore.ts        PendingStore, InMemoryPendingStore
      paymentVerifier.ts     verifyAndInternalizePayment
      providers.ts           QueryProvider + overlayLookup, messageList, bytes providers
      handlers.ts            createEconomicQueryHost
  test/
    support/wallets.ts       PayerWallet, HostWallet test doubles
    e2e/harness.ts           real express hosts + SLAP-token resolver stub
    e2e/market.test.ts       end-to-end scenarios
packages/overlays/overlay-express/src/OverlayExpress.ts     registerRouter hook
```

Unit tests sit beside their source as `*.test.ts`. The design's three provider files are one `providers.ts` because each provider is under forty lines and they share validation helpers.

---

### Task 1: Package scaffold, canonical JSON, and query identity

**Files:**

- Create: `packages/overlays/eqc/package.json`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.typecheck.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `packages/overlays/eqc/src/index.ts`, `src/host.ts`
- Create: `packages/overlays/eqc/src/protocol/canonicalJson.ts`, `src/protocol/query.ts`
- Test: `packages/overlays/eqc/src/protocol/canonicalJson.test.ts`, `src/protocol/query.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `canonicalJson(value: unknown): string`
  - `interface EconomicQuery { type: string; client: string; hostSetHint?: string[]; strictHosts?: boolean; params: Record<string, unknown>; maxFeeSats: number; floorFeeSats: number; threshold: number; topK: number; raceMs: number; expires: string; nonce: string }`
  - `DEFAULTS`, `ECONOMIC_PATHS`, `MAX_RANKED_HOSTS` (64)
  - `isPublicKeyHex(v: unknown): v is string`, `isHashHex(v: unknown): v is string`, `isPlainObject(v: unknown): v is Record<string, unknown>`
  - `validateQuery(value: unknown): EconomicQuery` (throws `TypeError`)
  - `computeQueryId(query: EconomicQuery): string` (64 lowercase hex)

- [ ] **Step 1: Create the manifest**

`packages/overlays/eqc/package.json`:

```json
{
  "name": "@bsv/eqc",
  "version": "0.1.0",
  "sideEffects": false,
  "engines": {
    "node": ">=22"
  },
  "publishConfig": {
    "access": "public"
  },
  "description": "Economic Query Client (EQC) and host handlers for BRC-178 race-settled collection markets over BSV overlay lookups and message boxes",
  "type": "commonjs",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./host": {
      "import": {
        "types": "./dist/host.d.mts",
        "default": "./dist/host.mjs"
      },
      "require": {
        "types": "./dist/host.d.cts",
        "default": "./dist/host.cjs"
      }
    }
  },
  "typesVersions": {
    "*": {
      "host": ["dist/host.d.cts"]
    }
  },
  "files": ["dist", "README.md", "LICENSE.txt"],
  "scripts": {
    "build": "tsdown src/index.ts src/host.ts --format cjs,esm --dts --sourcemap --clean --out-dir dist --tsconfig tsconfig.build.json",
    "format:check": "pnpm --workspace-root exec prettier --check \"packages/overlays/eqc/src/**/*.ts\" \"packages/overlays/eqc/test/**/*.ts\" \"packages/overlays/eqc/*.{json,ts,md}\"",
    "lint": "oxlint src test vitest.config.ts --deny-warnings",
    "pack:check": "node ../../../scripts/check-package-artifact.mjs . --exports EQC,EQCError,ECONOMIC_PATHS,DEFAULTS,computeQueryId,computePayouts,canonicalJson --entry-exports \"./host=createEconomicQueryHost|overlayLookupProvider|messageListProvider|bytesProvider\"",
    "test": "vitest run",
    "test:browser": "pnpm build && node ../../../scripts/check-browser-package.mjs .",
    "test:property": "vitest run src/protocol/protocol.property.test.ts",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
    "prepublishOnly": "npm run build",
    "typecheck": "tsc --project tsconfig.typecheck.json"
  },
  "keywords": ["bsv", "brc-178", "overlay", "message-box", "micropayments", "eqc"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/bsv-blockchain/ts-stack.git",
    "directory": "packages/overlays/eqc"
  },
  "author": "BSV Association",
  "license": "SEE LICENSE IN LICENSE.txt",
  "peerDependencies": {
    "@bsv/sdk": "^2.4.1"
  },
  "devDependencies": {
    "@bsv/auth-express-middleware": "workspace:^",
    "@bsv/sdk": "workspace:^",
    "@types/express": "^5.0.6",
    "@types/node": "^26.1.2",
    "@typescript/native": "npm:typescript@7.0.2",
    "@vitest/coverage-v8": "4.1.11",
    "express": "^5.2.1",
    "fast-check": "^4.9.0",
    "oxlint": "^1.76.0",
    "tsdown": "0.22.14",
    "typescript": "npm:@typescript/typescript6@6.0.2",
    "vitest": "^4.1.11"
  },
  "bugs": {
    "url": "https://github.com/bsv-blockchain/ts-stack/issues"
  },
  "homepage": "https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc#readme",
  "peerDependenciesMeta": {
    "@bsv/sdk": {
      "optional": false
    }
  }
}
```

- [ ] **Step 2: Create the TypeScript, vitest, and ignore files**

`packages/overlays/eqc/tsconfig.json`:

```json
{
  "extends": "../../../config/typescript/node-library.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`packages/overlays/eqc/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "incremental": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

`packages/overlays/eqc/tsconfig.typecheck.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "incremental": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

`packages/overlays/eqc/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'lcov']
    }
  }
})
```

`packages/overlays/eqc/.gitignore`:

```
node_modules
dist
coverage
```

- [ ] **Step 3: Create the README**

`packages/overlays/eqc/README.md`:

````markdown
# @bsv/eqc

Economic Query Client for [BRC-178](https://bsv.brc.dev/overlays/0178) race-settled collection
markets. Independent overlay nodes and message box servers answer the same query; the client
ranks them by the time their answers arrive and pays the fastest hosts that agree on the answer.

## Install

```bash
npm install @bsv/eqc @bsv/sdk
```

## Usage

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet)
const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
```

Hosts add the market routes with `@bsv/eqc/host`:

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
```

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
````

- [ ] **Step 4: Write the failing canonical JSON test**

`packages/overlays/eqc/src/protocol/canonicalJson.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { canonicalJson } from './canonicalJson.js'

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}'
    )
  })

  it('omits undefined object members and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}')
  })

  it('escapes strings exactly as JSON.stringify does', () => {
    const value = 'quote " newline \n separator  '
    expect(canonicalJson(value)).toBe(JSON.stringify(value))
  })

  it('normalizes negative zero', () => {
    expect(canonicalJson(-0)).toBe('0')
  })

  it('rejects numbers that are not safe integers', () => {
    expect(() => canonicalJson(1.5)).toThrow(TypeError)
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
  })

  it('rejects values JSON cannot carry', () => {
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
    expect(() => canonicalJson(10n)).toThrow(TypeError)
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError)
  })

  it('rejects nesting deeper than 32 levels', () => {
    let value: unknown = 1
    for (let depth = 0; depth < 40; depth++) value = [value]
    expect(() => canonicalJson(value)).toThrow(RangeError)
  })
})
```

- [ ] **Step 5: Install and run the test to verify it fails**

Run: `pnpm install && pnpm --filter "@bsv/eqc..." build; pnpm --filter @bsv/eqc exec vitest run src/protocol/canonicalJson.test.ts`
Expected: install succeeds and adds an `packages/overlays/eqc` importer to `pnpm-lock.yaml`; the `@bsv/eqc` build step fails because `src/index.ts` does not exist yet (its dependencies still build); vitest FAILS with `Cannot find module './canonicalJson.js'`.

- [ ] **Step 6: Implement canonical JSON**

`packages/overlays/eqc/src/protocol/canonicalJson.ts`:

```ts
const MAX_DEPTH = 32

/**
 * Serializes a JSON value deterministically: object keys sorted by UTF-16 code unit, no
 * whitespace, integers only. This is the RFC 8785 subset BRC-178 query identifiers hash.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError('Canonical JSON nesting exceeds 32 levels')
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError('Canonical JSON numbers must be safe integers')
      }
      return String(value === 0 ? 0 : value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      return Array.isArray(value) ? serializeArray(value, depth) : serializeObject(value, depth)
    default:
      throw new TypeError(`Canonical JSON cannot encode a ${typeof value}`)
  }
}

function serializeArray(items: unknown[], depth: number): string {
  const parts: string[] = []
  for (const item of items) {
    if (item === undefined) throw new TypeError('Canonical JSON arrays cannot contain undefined')
    parts.push(serialize(item, depth + 1))
  }
  return `[${parts.join(',')}]`
}

function serializeObject(value: object, depth: number): string {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON objects must be plain objects')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const parts: string[] = []
  for (const key of keys) {
    const item = record[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${serialize(item, depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/canonicalJson.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Write the failing query test**

`packages/overlays/eqc/src/protocol/query.test.ts`:

```ts
import { Hash, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  DEFAULTS,
  ECONOMIC_PATHS,
  computeQueryId,
  validateQuery,
  type EconomicQuery
} from './query.js'

const client = `02${'ab'.repeat(32)}`
const nonce = '11'.repeat(32)

function baseQuery(): EconomicQuery {
  return {
    type: 'overlay-lookup',
    client,
    params: { service: 'ls_example', query: { key: 'value' } },
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: '2026-09-18T19:05:00.000Z',
    nonce
  }
}

describe('constants', () => {
  it('pins the approved paths and defaults', () => {
    expect(ECONOMIC_PATHS).toEqual({
      params: '/economic/params',
      query: '/economic/query',
      collect: '/economic/collect'
    })
    expect(DEFAULTS).toMatchObject({
      threshold: 3,
      topK: 5,
      raceMs: 400,
      floorFeeSats: 1000,
      maxFeeSats: 2000,
      queryTtlMs: 30_000,
      hostTimeoutMs: 5000,
      hostsTtlMs: 300_000,
      paramsTtlMs: 300_000,
      maxHosts: 16
    })
  })
})

describe('computeQueryId', () => {
  it('hashes the canonical JSON of the query', () => {
    const canonical =
      `{"client":"${client}","expires":"2026-09-18T19:05:00.000Z","floorFeeSats":1000,` +
      `"maxFeeSats":2000,"nonce":"${nonce}","params":{"query":{"key":"value"},` +
      `"service":"ls_example"},"raceMs":400,"threshold":3,"topK":5,"type":"overlay-lookup"}`
    expect(computeQueryId(baseQuery())).toBe(
      Utils.toHex(Hash.sha256(Utils.toArray(canonical, 'utf8')))
    )
  })

  it('ignores key order and reacts to the nonce', () => {
    const reordered = Object.fromEntries(Object.entries(baseQuery()).reverse()) as EconomicQuery
    expect(computeQueryId(reordered)).toBe(computeQueryId(baseQuery()))
    expect(computeQueryId({ ...baseQuery(), nonce: '22'.repeat(32) })).not.toBe(
      computeQueryId(baseQuery())
    )
  })
})

describe('validateQuery', () => {
  it('returns a normalized copy of a valid query', () => {
    const input = { ...baseQuery(), hostSetHint: [client], strictHosts: false }
    const result = validateQuery(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })

  it.each([
    ['unknown field', { ...baseQuery(), extra: 1 }],
    ['bad client key', { ...baseQuery(), client: 'ab' }],
    ['array params', { ...baseQuery(), params: [] }],
    ['float in params', { ...baseQuery(), params: { price: 1.5 } }],
    ['zero floor', { ...baseQuery(), floorFeeSats: 0 }],
    ['max below floor', { ...baseQuery(), maxFeeSats: 999 }],
    ['topK below threshold', { ...baseQuery(), topK: 2 }],
    ['negative raceMs', { ...baseQuery(), raceMs: -1 }],
    ['non-canonical expires', { ...baseQuery(), expires: '2026-09-18 19:05' }],
    ['short nonce', { ...baseQuery(), nonce: 'ff' }],
    ['bad host hint', { ...baseQuery(), hostSetHint: ['zz'] }],
    ['non-boolean strictHosts', { ...baseQuery(), strictHosts: 'yes' }],
    ['not an object', 'query']
  ])('rejects %s', (_label, value) => {
    expect(() => validateQuery(value)).toThrow(TypeError)
  })

  it('allows topK below threshold only in single-host mode', () => {
    expect(validateQuery({ ...baseQuery(), threshold: 1, topK: 1 }).topK).toBe(1)
  })

  it('rejects params larger than 65536 characters', () => {
    expect(() => validateQuery({ ...baseQuery(), params: { blob: 'x'.repeat(70_000) } })).toThrow(
      TypeError
    )
  })
})
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/query.test.ts`
Expected: FAIL with `Cannot find module './query.js'`.

- [ ] **Step 10: Implement the query module**

`packages/overlays/eqc/src/protocol/query.ts`:

```ts
import { Hash, Utils } from '@bsv/sdk'

import { canonicalJson } from './canonicalJson.js'

/** HTTP binding shared by client and host. */
export const ECONOMIC_PATHS = {
  params: '/economic/params',
  query: '/economic/query',
  collect: '/economic/collect'
} as const

export const DEFAULTS = {
  threshold: 3,
  topK: 5,
  raceMs: 400,
  floorFeeSats: 1000,
  maxFeeSats: 2000,
  queryTtlMs: 30_000,
  hostTimeoutMs: 5000,
  hostsTtlMs: 300_000,
  paramsTtlMs: 300_000,
  maxHosts: 16
} as const

/** Upper bound on `threshold`, `topK`, and the length of a collect ranking. */
export const MAX_RANKED_HOSTS = 64

const MAX_PARAMS_CHARS = 65_536
const MAX_HOST_HINTS = 64
const PUBLIC_KEY_HEX = /^0[23][0-9a-f]{64}$/
const HASH_HEX = /^[0-9a-f]{64}$/
const QUERY_TYPE = /^[a-z][a-z0-9-]{0,63}$/
const QUERY_KEYS = new Set([
  'type',
  'client',
  'hostSetHint',
  'strictHosts',
  'params',
  'maxFeeSats',
  'floorFeeSats',
  'threshold',
  'topK',
  'raceMs',
  'expires',
  'nonce'
])

export interface EconomicQuery {
  type: string
  client: string
  hostSetHint?: string[]
  strictHosts?: boolean
  params: Record<string, unknown>
  maxFeeSats: number
  floorFeeSats: number
  threshold: number
  topK: number
  raceMs: number
  expires: string
  nonce: string
}

export function isPublicKeyHex(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_HEX.test(value)
}

export function isHashHex(value: unknown): value is string {
  return typeof value === 'string' && HASH_HEX.test(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function integerInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

/** Validates an untrusted query body and returns a copy holding only known fields. */
export function validateQuery(value: unknown): EconomicQuery {
  if (!isPlainObject(value)) throw new TypeError('Query must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!QUERY_KEYS.has(key)) throw new TypeError(`Unknown query field ${key}`)
  }
  if (typeof value.type !== 'string' || !QUERY_TYPE.test(value.type)) {
    throw new TypeError('type must be a lowercase query class name')
  }
  if (!isPublicKeyHex(value.client)) {
    throw new TypeError('client must be a compressed public key in hex')
  }
  if (!isPlainObject(value.params)) throw new TypeError('params must be a JSON object')
  if (canonicalJson(value.params).length > MAX_PARAMS_CHARS) {
    throw new TypeError('params exceed 65536 characters')
  }
  const floorFeeSats = integerInRange(
    value.floorFeeSats,
    'floorFeeSats',
    1,
    Number.MAX_SAFE_INTEGER
  )
  const maxFeeSats = integerInRange(
    value.maxFeeSats,
    'maxFeeSats',
    floorFeeSats,
    Number.MAX_SAFE_INTEGER
  )
  const threshold = integerInRange(value.threshold, 'threshold', 1, MAX_RANKED_HOSTS)
  const topK = integerInRange(value.topK, 'topK', 1, MAX_RANKED_HOSTS)
  if (threshold > 1 && topK < threshold) {
    throw new TypeError('topK must be at least threshold unless threshold is 1')
  }
  const raceMs = integerInRange(value.raceMs, 'raceMs', 0, 60_000)
  if (typeof value.expires !== 'string' || !isCanonicalTimestamp(value.expires)) {
    throw new TypeError('expires must be an ISO 8601 UTC timestamp')
  }
  if (!isHashHex(value.nonce)) throw new TypeError('nonce must be 32 bytes of lowercase hex')

  const query: EconomicQuery = {
    type: value.type,
    client: value.client,
    params: value.params,
    maxFeeSats,
    floorFeeSats,
    threshold,
    topK,
    raceMs,
    expires: value.expires,
    nonce: value.nonce
  }
  if (value.hostSetHint !== undefined) {
    const hint = value.hostSetHint
    if (!Array.isArray(hint) || hint.length > MAX_HOST_HINTS || !hint.every(isPublicKeyHex)) {
      throw new TypeError('hostSetHint must list at most 64 compressed public keys')
    }
    query.hostSetHint = [...hint]
  }
  if (value.strictHosts !== undefined) {
    if (typeof value.strictHosts !== 'boolean') throw new TypeError('strictHosts must be a boolean')
    query.strictHosts = value.strictHosts
  }
  return query
}

/** `SHA-256` of the canonical JSON of the query, as lowercase hex. */
export function computeQueryId(query: EconomicQuery): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(canonicalJson(query), 'utf8')))
}
```

- [ ] **Step 11: Create the entry points**

`packages/overlays/eqc/src/index.ts`:

```ts
export { canonicalJson } from './protocol/canonicalJson.js'
export {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  validateQuery,
  type EconomicQuery
} from './protocol/query.js'
```

`packages/overlays/eqc/src/host.ts`:

```ts
export { ECONOMIC_PATHS } from './protocol/query.js'
```

- [ ] **Step 12: Run the package checks**

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc build && pnpm --filter @bsv/eqc format:check`
Expected: all tests PASS; typecheck, lint, build, and format produce no errors. If `format:check` reports a file, run `pnpm exec prettier --write` on that file and re-run.

- [ ] **Step 13: Commit**

```bash
git add packages/overlays/eqc pnpm-lock.yaml
git commit -m "feat(eqc): scaffold package with canonical JSON and query identity" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Fibonacci payouts and the property suite

**Files:**

- Create: `packages/overlays/eqc/src/protocol/fibonacci.ts`
- Test: `packages/overlays/eqc/src/protocol/fibonacci.test.ts`
- Create: `packages/overlays/eqc/src/protocol/protocol.property.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `MAX_RANKED_HOSTS` and `canonicalJson` from Task 1.
- Produces:
  - `fibonacciWeights(k: number): number[]` — weights for ranks `1..k`, largest first
  - `sumOfWeights(k: number): number`
  - `computePayouts(totalSats: number, k: number): number[]` — length `k`, non-increasing, may end in zeros

- [ ] **Step 1: Write the failing unit test**

`packages/overlays/eqc/src/protocol/fibonacci.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { computePayouts, fibonacciWeights, sumOfWeights } from './fibonacci.js'

describe('fibonacciWeights', () => {
  it('lists F_k down to F_1', () => {
    expect(fibonacciWeights(1)).toEqual([1])
    expect(fibonacciWeights(5)).toEqual([5, 3, 2, 1, 1])
    expect(sumOfWeights(5)).toBe(12)
    expect(sumOfWeights(14)).toBe(986)
  })

  it('rejects k outside 1..64', () => {
    expect(() => fibonacciWeights(0)).toThrow(RangeError)
    expect(() => fibonacciWeights(65)).toThrow(RangeError)
    expect(() => fibonacciWeights(2.5)).toThrow(RangeError)
  })
})

describe('computePayouts', () => {
  it('reproduces the BRC-178 worked examples', () => {
    expect(computePayouts(12, 5)).toEqual([5, 3, 2, 1, 1])
    expect(computePayouts(20, 3)).toEqual([10, 5, 5])
  })

  it('gives the remainder to rank 1', () => {
    expect(computePayouts(1000, 5)).toEqual([418, 250, 166, 83, 83])
  })

  it('floors small fees to zero for slow ranks', () => {
    expect(computePayouts(2, 5)).toEqual([2, 0, 0, 0, 0])
  })

  it('stays exact for fees beyond 2^53 / weight', () => {
    const total = 2_100_000_000_000_000
    const payouts = computePayouts(total, 64)
    expect(payouts.reduce((sum, value) => sum + value, 0)).toBe(total)
  })

  it('rejects invalid totals', () => {
    expect(() => computePayouts(0, 3)).toThrow(RangeError)
    expect(() => computePayouts(1.5, 3)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/fibonacci.test.ts`
Expected: FAIL with `Cannot find module './fibonacci.js'`.

- [ ] **Step 3: Implement the payout arithmetic**

`packages/overlays/eqc/src/protocol/fibonacci.ts`:

```ts
import { MAX_RANKED_HOSTS } from './query.js'

function assertRankCount(k: number): void {
  if (!Number.isSafeInteger(k) || k < 1 || k > MAX_RANKED_HOSTS) {
    throw new RangeError(`k must be an integer from 1 to ${MAX_RANKED_HOSTS}`)
  }
}

/** Weights for ranks `1..k`: `weight(i) = F_(k - i + 1)` with `F_1 = F_2 = 1`. */
export function fibonacciWeights(k: number): number[] {
  assertRankCount(k)
  const ascending: number[] = []
  for (let n = 0; n < k; n++) {
    ascending.push(n < 2 ? 1 : ascending[n - 1] + ascending[n - 2])
  }
  return ascending.reverse()
}

export function sumOfWeights(k: number): number {
  return fibonacciWeights(k).reduce((sum, weight) => sum + weight, 0)
}

/**
 * Splits `totalSats` across `k` ranks: `floor(R * weight / S)` each, remainder to rank 1.
 * BigInt keeps the product exact for any fee up to the BSV supply.
 */
export function computePayouts(totalSats: number, k: number): number[] {
  if (!Number.isSafeInteger(totalSats) || totalSats < 1) {
    throw new RangeError('totalSats must be a positive safe integer')
  }
  const weights = fibonacciWeights(k)
  const total = BigInt(totalSats)
  const sum = BigInt(weights.reduce((accumulator, weight) => accumulator + weight, 0))
  const payouts = weights.map(weight => Number((total * BigInt(weight)) / sum))
  const distributed = payouts.reduce((accumulator, payout) => accumulator + payout, 0)
  payouts[0] += totalSats - distributed
  return payouts
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/fibonacci.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the property suite**

`packages/overlays/eqc/src/protocol/protocol.property.test.ts`:

```ts
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { canonicalJson } from './canonicalJson.js'
import { computePayouts, fibonacciWeights } from './fibonacci.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const jsonValue = fc.letrec<{ value: unknown }>(tie => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.string(),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('value'), { maxKeys: 4 })
  )
})).value

function shuffleKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map(item => shuffleKeys(item, seed))
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).map(
    ([key, item]) => [key, shuffleKeys(item, seed)] as const
  )
  const rotation = entries.length === 0 ? 0 : seed % entries.length
  return Object.fromEntries([...entries.slice(rotation), ...entries.slice(0, rotation)].reverse())
}

describe('BRC-178 protocol invariants', () => {
  test('payouts conserve the fee, never increase with rank, and favour rank 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 2_100_000_000_000_000 }),
        (k, total) => {
          const payouts = computePayouts(total, k)
          expect(payouts).toHaveLength(k)
          expect(payouts.reduce((sum, value) => sum + value, 0)).toBe(total)
          for (let rank = 1; rank < k; rank++) {
            expect(payouts[rank]).toBeLessThanOrEqual(payouts[rank - 1])
            expect(payouts[rank]).toBeGreaterThanOrEqual(0)
          }
          const weights = fibonacciWeights(k)
          const sum = weights.reduce((accumulator, weight) => accumulator + weight, 0)
          for (let rank = 1; rank < k; rank++) {
            expect(payouts[rank]).toBe(
              Number((BigInt(total) * BigInt(weights[rank])) / BigInt(sum))
            )
          }
        }
      )
    )
  })

  test('canonical JSON is independent of object key order and round-trips', () => {
    fc.assert(
      fc.property(jsonValue, fc.nat(), (value, seed) => {
        const canonical = canonicalJson(value)
        expect(canonicalJson(shuffleKeys(value, seed))).toBe(canonical)
        expect(canonicalJson(JSON.parse(canonical))).toBe(canonical)
      })
    )
  })
})
```

- [ ] **Step 6: Run the property suite**

Run: `pnpm --filter @bsv/eqc test:property`
Expected: PASS, 2 tests.

- [ ] **Step 7: Export from the package entry**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export { computePayouts, fibonacciWeights, sumOfWeights } from './protocol/fibonacci.js'
```

- [ ] **Step 8: Run the package checks and commit**

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add Fibonacci payout split with property suite" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Canonical payloads and content hashes

**Files:**

- Create: `packages/overlays/eqc/src/protocol/payloads.ts`
- Test: `packages/overlays/eqc/src/protocol/payloads.test.ts`
- Modify: `packages/overlays/eqc/src/protocol/protocol.property.test.ts`, `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `isHashHex` from Task 1.
- Produces:
  - `interface CanonicalMessage { messageId: string; sender: string; body: string }`
  - `interface LookupOutpoint { txid: string; outputIndex: number; context?: number[] }`
  - `contentHash(payload: number[]): string`
  - `compareCodePoints(a: string, b: string): number`
  - `encodeMessageList(messages: CanonicalMessage[]): number[]`, `decodeMessageList(payload: number[]): CanonicalMessage[]`
  - `encodeOutpointList(entries: LookupOutpoint[]): number[]`, `decodeOutpointList(payload: number[]): LookupOutpoint[]`
  - `canonicalizeLookupAnswer(answer: LookupAnswer): { payload: number[]; supplement: number[] }`
  - `rebuildLookupAnswer(payload: number[], supplement: number[]): LookupAnswer`

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/protocol/payloads.test.ts`:

```ts
import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  canonicalizeLookupAnswer,
  compareCodePoints,
  contentHash,
  decodeMessageList,
  decodeOutpointList,
  encodeMessageList,
  encodeOutpointList,
  rebuildLookupAnswer
} from './payloads.js'

function sampleBeef(satoshis: number): { beef: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({
    lockingScript: new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()),
    satoshis
  })
  const txid = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return { beef: beef.toBinary(), txid }
}

describe('contentHash', () => {
  it('is the SHA-256 of the payload bytes in hex', () => {
    expect(contentHash(Utils.toArray('[]', 'utf8'))).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
    )
  })
})

describe('message-list', () => {
  it('hashes the empty list as []', () => {
    expect(Utils.toUTF8(encodeMessageList([]))).toBe('[]')
  })

  it('sorts by messageId code point and fixes the key order', () => {
    const payload = encodeMessageList([
      { body: 'second', sender: 'b', messageId: 'b' },
      { sender: 'a', messageId: 'a', body: 'first "quoted"' }
    ])
    expect(Utils.toUTF8(payload)).toBe(
      '[{"messageId":"a","sender":"a","body":"first \\"quoted\\""},' +
        '{"messageId":"b","sender":"b","body":"second"}]'
    )
    expect(decodeMessageList(payload)).toEqual([
      { messageId: 'a', sender: 'a', body: 'first "quoted"' },
      { messageId: 'b', sender: 'b', body: 'second' }
    ])
  })

  it('orders astral characters after the BMP, unlike UTF-16 comparison', () => {
    expect(compareCodePoints('\u{1F600}', '�')).toBeGreaterThan(0)
    expect('\u{1F600}' < '�').toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(() => decodeMessageList(Utils.toArray('{"a":1}', 'utf8'))).toThrow(TypeError)
    expect(() => decodeMessageList(Utils.toArray('[{"messageId":1}]', 'utf8'))).toThrow(TypeError)
  })
})

describe('overlay-lookup', () => {
  const a = 'aa'.repeat(32)
  const b = 'bb'.repeat(32)

  it('sorts by txid, output index, then context and drops exact duplicates', () => {
    const payload = encodeOutpointList([
      { txid: b, outputIndex: 0 },
      { txid: a, outputIndex: 2, context: [9] },
      { txid: a, outputIndex: 2, context: [1] },
      { txid: a, outputIndex: 1 },
      { txid: b, outputIndex: 0 }
    ])
    expect(decodeOutpointList(payload)).toEqual([
      { txid: a, outputIndex: 1 },
      { txid: a, outputIndex: 2, context: [1] },
      { txid: a, outputIndex: 2, context: [9] },
      { txid: b, outputIndex: 0 }
    ])
  })

  it('treats an empty context as absent', () => {
    expect(encodeOutpointList([{ txid: a, outputIndex: 0, context: [] }])).toEqual(
      encodeOutpointList([{ txid: a, outputIndex: 0 }])
    )
  })

  it('rejects truncated input and trailing bytes', () => {
    const payload = encodeOutpointList([{ txid: a, outputIndex: 0 }])
    expect(() => decodeOutpointList(payload.slice(0, -1))).toThrow(TypeError)
    expect(() => decodeOutpointList([...payload, 0])).toThrow(TypeError)
  })

  it('hashes the same for any output order and rebuilds a usable answer', () => {
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const forward: LookupAnswer = {
      type: 'output-list',
      outputs: [
        { beef: first.beef, outputIndex: 0 },
        { beef: second.beef, outputIndex: 0, context: [7] }
      ]
    }
    const backward: LookupAnswer = { type: 'output-list', outputs: [...forward.outputs].reverse() }
    const canonical = canonicalizeLookupAnswer(forward)
    expect(canonicalizeLookupAnswer(backward).payload).toEqual(canonical.payload)

    const rebuilt = rebuildLookupAnswer(canonical.payload, canonical.supplement)
    expect(rebuilt.type).toBe('output-list')
    const txids = rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex'))
    expect(txids).toEqual([first.txid, second.txid].sort())
    expect(rebuilt.outputs.find(output => output.context !== undefined)?.context).toEqual([7])
  })

  it('refuses to rebuild when the BEEF lacks a listed transaction', () => {
    const first = sampleBeef(1)
    const payload = encodeOutpointList([{ txid: 'cc'.repeat(32), outputIndex: 0 }])
    expect(() => rebuildLookupAnswer(payload, first.beef)).toThrow(TypeError)
  })

  it('refuses to rebuild when the output index does not exist', () => {
    const first = sampleBeef(1)
    const payload = encodeOutpointList([{ txid: first.txid, outputIndex: 5 }])
    expect(() => rebuildLookupAnswer(payload, first.beef)).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/payloads.test.ts`
Expected: FAIL with `Cannot find module './payloads.js'`.

- [ ] **Step 3: Implement the payload encoders**

`packages/overlays/eqc/src/protocol/payloads.ts`:

```ts
import { Beef, Hash, Transaction, Utils, type LookupAnswer } from '@bsv/sdk'

import { isHashHex, isPlainObject } from './query.js'

const MAX_OUTPOINTS = 100_000

export interface CanonicalMessage {
  messageId: string
  sender: string
  body: string
}

export interface LookupOutpoint {
  txid: string
  outputIndex: number
  context?: number[]
}

/** `SHA-256` of the canonical payload, as lowercase hex. */
export function contentHash(payload: number[]): string {
  return Utils.toHex(Hash.sha256(payload))
}

/** Orders strings by Unicode code point, which differs from UTF-16 order for astral characters. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    const difference = (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function compareBytes(a: number[], b: number[]): number {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function assertMessage(value: unknown): asserts value is CanonicalMessage {
  if (
    !isPlainObject(value) ||
    typeof value.messageId !== 'string' ||
    typeof value.sender !== 'string' ||
    typeof value.body !== 'string'
  ) {
    throw new TypeError('A message needs string messageId, sender, and body fields')
  }
}

/** Canonical `message-list` payload: UTF-8 JSON, sorted by `messageId`, fixed key order. */
export function encodeMessageList(messages: CanonicalMessage[]): number[] {
  const sorted = [...messages]
  sorted.forEach(assertMessage)
  sorted.sort(
    (left, right) =>
      compareCodePoints(left.messageId, right.messageId) ||
      compareCodePoints(left.sender, right.sender) ||
      compareCodePoints(left.body, right.body)
  )
  const items = sorted.map(
    message =>
      `{"messageId":${JSON.stringify(message.messageId)},` +
      `"sender":${JSON.stringify(message.sender)},"body":${JSON.stringify(message.body)}}`
  )
  return Utils.toArray(`[${items.join(',')}]`, 'utf8')
}

export function decodeMessageList(payload: number[]): CanonicalMessage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(Utils.toUTF8(payload))
  } catch {
    throw new TypeError('message-list payload is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new TypeError('message-list payload must be a JSON array')
  return parsed.map(item => {
    assertMessage(item)
    return { messageId: item.messageId, sender: item.sender, body: item.body }
  })
}

function normalizeOutpoint(entry: LookupOutpoint): Required<LookupOutpoint> {
  if (!isHashHex(entry.txid)) throw new TypeError('txid must be 32 bytes of lowercase hex')
  if (!Number.isSafeInteger(entry.outputIndex) || entry.outputIndex < 0) {
    throw new TypeError('outputIndex must be a non-negative integer')
  }
  const context = entry.context ?? []
  if (!context.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new TypeError('context must be a byte array')
  }
  return { txid: entry.txid, outputIndex: entry.outputIndex, context }
}

/**
 * Canonical `overlay-lookup` payload: the outpoint section of the BRC-24 binary answer,
 * `varint n ‖ [txid(32) ‖ varint outputIndex ‖ varint contextLength ‖ context]*`, sorted and
 * de-duplicated so every honest host produces the same bytes.
 */
export function encodeOutpointList(entries: LookupOutpoint[]): number[] {
  const sorted = entries
    .map(normalizeOutpoint)
    .sort(
      (left, right) =>
        (left.txid < right.txid ? -1 : left.txid > right.txid ? 1 : 0) ||
        left.outputIndex - right.outputIndex ||
        compareBytes(left.context, right.context)
    )
  const unique = sorted.filter((entry, index) => {
    if (index === 0) return true
    const previous = sorted[index - 1]
    return (
      previous.txid !== entry.txid ||
      previous.outputIndex !== entry.outputIndex ||
      compareBytes(previous.context, entry.context) !== 0
    )
  })
  if (unique.length > MAX_OUTPOINTS) throw new RangeError('Too many outpoints')
  const writer = new Utils.Writer()
  writer.writeVarIntNum(unique.length)
  for (const entry of unique) {
    writer.write(Utils.toArray(entry.txid, 'hex'))
    writer.writeVarIntNum(entry.outputIndex)
    writer.writeVarIntNum(entry.context.length)
    writer.write(entry.context)
  }
  return writer.toArray()
}

export function decodeOutpointList(payload: number[]): LookupOutpoint[] {
  const reader = new Utils.Reader(payload)
  const count = reader.readVarIntNum()
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_OUTPOINTS) {
    throw new TypeError('Outpoint count is out of range')
  }
  const entries: LookupOutpoint[] = []
  for (let index = 0; index < count; index++) {
    const txidBytes = reader.read(32)
    if (txidBytes.length !== 32) throw new TypeError('Outpoint list is truncated')
    const outputIndex = reader.readVarIntNum()
    const contextLength = reader.readVarIntNum()
    if (
      !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0 ||
      !Number.isSafeInteger(contextLength) ||
      contextLength < 0
    ) {
      throw new TypeError('Outpoint list is malformed')
    }
    const context = contextLength > 0 ? reader.read(contextLength) : []
    if (context.length !== contextLength) throw new TypeError('Outpoint list is truncated')
    entries.push(
      contextLength > 0
        ? { txid: Utils.toHex(txidBytes), outputIndex, context }
        : { txid: Utils.toHex(txidBytes), outputIndex }
    )
  }
  if (!reader.eof()) throw new TypeError('Outpoint list has trailing bytes')
  return entries
}

/** Splits an `output-list` into the hashed outpoint section and the self-authenticating BEEF. */
export function canonicalizeLookupAnswer(answer: LookupAnswer): {
  payload: number[]
  supplement: number[]
} {
  const beef = new Beef()
  const entries: LookupOutpoint[] = []
  for (const output of answer.outputs) {
    const transaction = Transaction.fromBEEF(output.beef)
    beef.mergeBeef(output.beef)
    entries.push({
      txid: transaction.id('hex'),
      outputIndex: output.outputIndex,
      context: output.context
    })
  }
  return { payload: encodeOutpointList(entries), supplement: beef.toBinary() }
}

/** Rebuilds a `LookupAnswer`, requiring every hashed outpoint to resolve inside the BEEF. */
export function rebuildLookupAnswer(payload: number[], supplement: number[]): LookupAnswer {
  const entries = decodeOutpointList(payload)
  if (entries.length === 0) return { type: 'output-list', outputs: [] }
  let beef: Beef
  try {
    beef = Beef.fromBinary(supplement)
  } catch {
    throw new TypeError('Lookup supplement is not valid BEEF')
  }
  const atomicByTxid = new Map<string, number[]>()
  const outputs: LookupAnswer['outputs'] = []
  for (const entry of entries) {
    const transaction = beef.findTxid(entry.txid)?.tx
    if (transaction === undefined || transaction.outputs[entry.outputIndex] === undefined) {
      throw new TypeError(`Lookup supplement lacks outpoint ${entry.txid}.${entry.outputIndex}`)
    }
    let atomic = atomicByTxid.get(entry.txid)
    if (atomic === undefined) {
      atomic = beef.toBinaryAtomic(entry.txid)
      atomicByTxid.set(entry.txid, atomic)
    }
    outputs.push(
      entry.context === undefined
        ? { beef: atomic, outputIndex: entry.outputIndex }
        : { beef: atomic, outputIndex: entry.outputIndex, context: entry.context }
    )
  }
  return { type: 'output-list', outputs }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/payloads.test.ts`
Expected: PASS, 12 tests. If the `contentHash` vector fails, recompute it with `node -e "console.log(require('node:crypto').createHash('sha256').update('[]').digest('hex'))"` and use that value; the implementation is `SHA-256` and must not change.

- [ ] **Step 5: Extend the property suite with order invariance**

In `packages/overlays/eqc/src/protocol/protocol.property.test.ts`, add this import below the existing imports:

```ts
import { decodeOutpointList, encodeMessageList, encodeOutpointList } from './payloads.js'
```

and add these tests inside the `describe` block:

```ts
test('message-list bytes do not depend on input order', () => {
  const message = fc.record({ messageId: fc.string(), sender: fc.string(), body: fc.string() })
  fc.assert(
    fc.property(fc.array(message, { maxLength: 8 }), messages => {
      expect(encodeMessageList([...messages].reverse())).toEqual(encodeMessageList(messages))
    })
  )
})

test('outpoint bytes do not depend on input order and decode to a sorted unique list', () => {
  const outpoint = fc.record({
    txid: fc.stringMatching(/^[0-9a-f]{64}$/),
    outputIndex: fc.nat({ max: 1000 }),
    context: fc.array(fc.nat({ max: 255 }), { maxLength: 4 })
  })
  fc.assert(
    fc.property(fc.array(outpoint, { maxLength: 8 }), entries => {
      const payload = encodeOutpointList(entries)
      expect(encodeOutpointList([...entries].reverse())).toEqual(payload)
      expect(encodeOutpointList(decodeOutpointList(payload))).toEqual(payload)
    })
  )
})
```

- [ ] **Step 6: Run the property suite**

Run: `pnpm --filter @bsv/eqc test:property`
Expected: PASS, 4 tests.

- [ ] **Step 7: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  canonicalizeLookupAnswer,
  compareCodePoints,
  contentHash,
  decodeMessageList,
  decodeOutpointList,
  encodeMessageList,
  encodeOutpointList,
  rebuildLookupAnswer,
  type CanonicalMessage,
  type LookupOutpoint
} from './protocol/payloads.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add canonical payload encoders and content hashing" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Errors, BRC-77 over a wallet, attestations, and deliveries

**Files:**

- Create: `packages/overlays/eqc/src/protocol/errors.ts`, `src/protocol/encoding.ts`, `src/protocol/brc77.ts`, `src/protocol/attestation.ts`
- Test: `packages/overlays/eqc/src/protocol/brc77.test.ts`, `src/protocol/attestation.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`, `src/host.ts`

**Interfaces:**

- Consumes: `isHashHex`, `isPlainObject`, `isPublicKeyHex` (Task 1); `contentHash` (Task 3).
- Produces:
  - `class EQCError extends Error { code: EQCErrorCode; details: Record<string, unknown> }`
  - `class HostError extends Error { status: number; code: HostErrorCode; headers: Record<string, string> }`
  - `isCanonicalBase64(value: unknown): value is string`
  - `signBRC77(wallet: WalletInterface, message: number[], originator?: string): Promise<number[]>`
  - `verifyBRC77(message: number[], signature: number[]): { valid: boolean; signer?: string }`
  - `interface TopicAnchor { topic: string; blockHeight: number; blockHash?: string; tac: string }`
  - `interface SignedFields { queryId: string; host: string; contentHash: string; payloadSize: number }`
  - `interface Attestation extends SignedFields { type: 'attest'; quotedFeeSats: number; attestedAt: string; signature: string; anchors?: TopicAnchor[] }`
  - `interface Delivery extends SignedFields { type: 'payload'; payload: string; supplement?: string; signature: string }`
  - `type Verdict = 'ok' | 'wrong-query' | 'identity-mismatch' | 'bad-signature' | 'hash-mismatch'`
  - `attestationPreimage(f: SignedFields): number[]`, `deliveryPreimage(f: SignedFields): number[]`
  - `signAttestation(wallet, fields: SignedFields & { quotedFeeSats: number; attestedAt: string; anchors?: TopicAnchor[] }, originator?): Promise<Attestation>`
  - `signDelivery(wallet, fields: { queryId: string; host: string; payload: number[]; supplement?: number[] }, originator?): Promise<Delivery>`
  - `parseAttestation(value: unknown): Attestation`, `parseDelivery(value: unknown): Delivery` (throw `TypeError`)
  - `verifyAttestation(a: Attestation, expected: { queryId: string; host: string }): Verdict`
  - `verifyDelivery(d: Delivery, expected: { queryId: string; host: string; contentHash: string }): { verdict: 'ok'; payload: number[]; supplement: number[] } | { verdict: Exclude<Verdict, 'ok'> }`

- [ ] **Step 1: Create the error classes and the base64 guard**

`packages/overlays/eqc/src/protocol/errors.ts`:

```ts
export type EQCErrorCode =
  | 'ERR_EQC_NO_HOSTS'
  | 'ERR_EQC_BUDGET'
  | 'ERR_EQC_NO_ATTESTATION'
  | 'ERR_EQC_THRESHOLD'
  | 'ERR_EQC_PAYMENT'
  | 'ERR_EQC_UNDELIVERED'

/** Thrown by the client when a query cannot complete. `details` carries diagnostics. */
export class EQCError extends Error {
  readonly code: EQCErrorCode
  readonly details: Record<string, unknown>

  constructor(code: EQCErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'EQCError'
    this.code = code
    this.details = details
  }
}

export type HostErrorCode =
  | 'ERR_INVALID_QUERY'
  | 'ERR_INVALID_COLLECT'
  | 'ERR_AUTH_REQUIRED'
  | 'ERR_PAYMENT_REQUIRED'
  | 'ERR_FORBIDDEN_RECIPIENT'
  | 'ERR_QUERY_UNKNOWN'
  | 'ERR_QUERY_SETTLED'
  | 'ERR_HASH_MISMATCH'
  | 'ERR_NOT_RANKED'
  | 'ERR_QUERY_EXPIRED'
  | 'ERR_PAYLOAD_TOO_LARGE'
  | 'ERR_UNSUPPORTED_CLASS'
  | 'ERR_TOO_MANY_PENDING'
  | 'ERR_INTERNAL'

/** Thrown inside host handlers and providers; mapped to `{ status: 'error', code, description }`. */
export class HostError extends Error {
  readonly status: number
  readonly code: HostErrorCode
  readonly headers: Record<string, string>

  constructor(
    status: number,
    code: HostErrorCode,
    description: string,
    headers: Record<string, string> = {}
  ) {
    super(description)
    this.name = 'HostError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}
```

`packages/overlays/eqc/src/protocol/encoding.ts`:

```ts
import { Utils } from '@bsv/sdk'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** True for standard (not URL-safe) base64 that re-encodes to itself. */
export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) return false
  return Utils.toBase64(Utils.toArray(value, 'base64')) === value
}
```

- [ ] **Step 2: Write the failing BRC-77 test**

`packages/overlays/eqc/src/protocol/brc77.test.ts`:

```ts
import { CompletedProtoWallet, PrivateKey, SignedMessage, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { signBRC77, verifyBRC77 } from './brc77.js'

const key = PrivateKey.fromRandom()
const wallet = new CompletedProtoWallet(key)
const signer = key.toPublicKey().toString()
const message = Utils.toArray('BRC-178 attestation\nexample', 'utf8')

describe('BRC-77 over a wallet', () => {
  it('produces signatures SignedMessage.verify accepts', async () => {
    const signature = await signBRC77(wallet, message)
    expect(SignedMessage.verify(message, signature)).toBe(true)
    expect(verifyBRC77(message, signature)).toEqual({ valid: true, signer })
  })

  it('accepts signatures made by SignedMessage.sign with a raw key', () => {
    expect(verifyBRC77(message, SignedMessage.sign(message, key))).toEqual({ valid: true, signer })
  })

  it('uses a fresh key ID for every signature', async () => {
    expect(await signBRC77(wallet, message)).not.toEqual(await signBRC77(wallet, message))
  })

  it('rejects a tampered message', async () => {
    const signature = await signBRC77(wallet, message)
    expect(verifyBRC77([...message, 0], signature).valid).toBe(false)
  })

  it('rejects recipient-bound signatures, wrong versions, and truncated input', async () => {
    const recipient = PrivateKey.fromRandom().toPublicKey()
    expect(verifyBRC77(message, SignedMessage.sign(message, key, recipient)).valid).toBe(false)
    const signature = await signBRC77(wallet, message)
    expect(verifyBRC77(message, [0, ...signature.slice(1)]).valid).toBe(false)
    expect(verifyBRC77(message, signature.slice(0, 40)).valid).toBe(false)
    expect(verifyBRC77(message, []).valid).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/brc77.test.ts`
Expected: FAIL with `Cannot find module './brc77.js'`.

- [ ] **Step 4: Implement wallet-based BRC-77**

`packages/overlays/eqc/src/protocol/brc77.ts`:

```ts
import { PublicKey, Random, SignedMessage, Utils, type WalletInterface } from '@bsv/sdk'

const VERSION = [0x42, 0x42, 0x33, 0x01]
const SIGNER_END = VERSION.length + 33
const MINIMUM_LENGTH = SIGNER_END + 1 + 32 + 8

/**
 * Signs `message` under BRC-77 for verification by anyone, using only a `WalletInterface`.
 * `SignedMessage.sign` needs a raw private key; its derivation is BRC-42 with invoice
 * `2-message signing-<base64 keyID>` toward the "anyone" key, which `createSignature` reproduces.
 */
export async function signBRC77(
  wallet: WalletInterface,
  message: number[],
  originator?: string
): Promise<number[]> {
  const keyID = Random(32)
  const [{ signature }, { publicKey }] = await Promise.all([
    wallet.createSignature(
      {
        data: message,
        protocolID: [2, 'message signing'],
        keyID: Utils.toBase64(keyID),
        counterparty: 'anyone'
      },
      originator
    ),
    wallet.getPublicKey({ identityKey: true }, originator)
  ])
  return [...VERSION, ...Utils.toArray(publicKey, 'hex'), 0, ...keyID, ...signature]
}

/** Verifies an anyone-verifiable BRC-77 signature and reports the signer it names. */
export function verifyBRC77(
  message: number[],
  signature: number[]
): { valid: boolean; signer?: string } {
  if (signature.length < MINIMUM_LENGTH) return { valid: false }
  if (VERSION.some((byte, index) => signature[index] !== byte)) return { valid: false }
  const signer = Utils.toHex(signature.slice(VERSION.length, SIGNER_END))
  if (signature[SIGNER_END] !== 0) return { valid: false, signer }
  try {
    PublicKey.fromString(signer)
    return { valid: SignedMessage.verify(message, signature) === true, signer }
  } catch {
    return { valid: false, signer }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/brc77.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing attestation test**

`packages/overlays/eqc/src/protocol/attestation.test.ts`:

```ts
import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  attestationPreimage,
  deliveryPreimage,
  parseAttestation,
  parseDelivery,
  signAttestation,
  signDelivery,
  verifyAttestation,
  verifyDelivery
} from './attestation.js'
import { contentHash } from './payloads.js'

const hostKey = PrivateKey.fromRandom()
const hostWallet = new CompletedProtoWallet(hostKey)
const host = hostKey.toPublicKey().toString()
const queryId = 'a4'.repeat(32)
const payload = Utils.toArray('[]', 'utf8')
const hash = contentHash(payload)

function fields(): {
  queryId: string
  host: string
  contentHash: string
  payloadSize: number
  quotedFeeSats: number
  attestedAt: string
} {
  return {
    queryId,
    host,
    contentHash: hash,
    payloadSize: payload.length,
    quotedFeeSats: 1000,
    attestedAt: '2026-09-18T18:59:01.233Z'
  }
}

describe('preimages', () => {
  it('match the BRC-178 text layout and are domain separated', () => {
    expect(Utils.toUTF8(attestationPreimage(fields()))).toBe(
      `BRC-178 attestation\n${queryId}\n${host}\n${hash}\n2`
    )
    expect(Utils.toUTF8(deliveryPreimage(fields()))).toBe(
      `BRC-178 payload\n${queryId}\n${host}\n${hash}\n2`
    )
  })
})

describe('attestations', () => {
  it('sign, survive a JSON round trip, and verify', async () => {
    const attestation = await signAttestation(hostWallet, {
      ...fields(),
      anchors: [{ topic: 'tm_example', blockHeight: 850_000, tac: 'cd'.repeat(32) }]
    })
    const parsed = parseAttestation(JSON.parse(JSON.stringify(attestation)))
    expect(parsed).toEqual(attestation)
    expect(verifyAttestation(parsed, { queryId, host })).toBe('ok')
  })

  it('report the specific failure', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(verifyAttestation(attestation, { queryId: 'b5'.repeat(32), host })).toBe('wrong-query')
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    expect(verifyAttestation(attestation, { queryId, host: other })).toBe('identity-mismatch')
    expect(verifyAttestation({ ...attestation, payloadSize: 3 }, { queryId, host })).toBe(
      'bad-signature'
    )
  })

  it('reject a signature made by a different key than the named host', async () => {
    const impostor = new CompletedProtoWallet(PrivateKey.fromRandom())
    const forged = await signAttestation(impostor, fields())
    expect(verifyAttestation(forged, { queryId, host })).toBe('identity-mismatch')
  })

  it('ignore a backdated attestedAt, which is not signed', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(
      verifyAttestation(
        { ...attestation, attestedAt: '1999-01-01T00:00:00.000Z' },
        { queryId, host }
      )
    ).toBe('ok')
  })

  it('parse strictly but drop malformed anchors', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    expect(() => parseAttestation({ ...attestation, type: 'other' })).toThrow(TypeError)
    expect(() => parseAttestation({ ...attestation, payloadSize: -1 })).toThrow(TypeError)
    expect(() => parseAttestation({ ...attestation, signature: 'zz' })).toThrow(TypeError)
    expect(parseAttestation({ ...attestation, anchors: [{ topic: 5 }] }).anchors).toBeUndefined()
  })
})

describe('deliveries', () => {
  it('sign, parse, and return the verified bytes', async () => {
    const delivery = await signDelivery(hostWallet, { queryId, host, payload, supplement: [1, 2] })
    const parsed = parseDelivery(JSON.parse(JSON.stringify(delivery)))
    expect(verifyDelivery(parsed, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'ok',
      payload,
      supplement: [1, 2]
    })
  })

  it('detect bytes that do not match the committed hash', async () => {
    const wrong = await signDelivery(hostWallet, { queryId, host, payload: [1, 2, 3] })
    expect(verifyDelivery(wrong, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'hash-mismatch'
    })
  })

  it('refuse an attestation signature replayed as a delivery signature', async () => {
    const attestation = await signAttestation(hostWallet, fields())
    const delivery = await signDelivery(hostWallet, { queryId, host, payload })
    const replayed = { ...delivery, signature: attestation.signature }
    expect(verifyDelivery(replayed, { queryId, host, contentHash: hash })).toEqual({
      verdict: 'bad-signature'
    })
  })

  it('reject non-canonical base64', async () => {
    const delivery = await signDelivery(hostWallet, { queryId, host, payload })
    expect(() => parseDelivery({ ...delivery, payload: 'W10' })).toThrow(TypeError)
  })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/attestation.test.ts`
Expected: FAIL with `Cannot find module './attestation.js'`.

- [ ] **Step 8: Implement attestations and deliveries**

`packages/overlays/eqc/src/protocol/attestation.ts`:

```ts
import { Utils, type WalletInterface } from '@bsv/sdk'

import { signBRC77, verifyBRC77 } from './brc77.js'
import { isCanonicalBase64 } from './encoding.js'
import { contentHash } from './payloads.js'
import { isHashHex, isPlainObject, isPublicKeyHex } from './query.js'

const ATTESTATION_TAG = 'BRC-178 attestation'
const DELIVERY_TAG = 'BRC-178 payload'
const SIGNATURE_HEX = /^(?:[0-9a-f]{2}){1,256}$/
const MAX_ANCHORS = 32

export interface TopicAnchor {
  topic: string
  blockHeight: number
  blockHash?: string
  tac: string
}

export interface SignedFields {
  queryId: string
  host: string
  contentHash: string
  payloadSize: number
}

export interface Attestation extends SignedFields {
  type: 'attest'
  quotedFeeSats: number
  attestedAt: string
  signature: string
  anchors?: TopicAnchor[]
}

export interface Delivery extends SignedFields {
  type: 'payload'
  payload: string
  supplement?: string
  signature: string
}

export type Verdict = 'ok' | 'wrong-query' | 'identity-mismatch' | 'bad-signature' | 'hash-mismatch'

function preimage(tag: string, fields: SignedFields): number[] {
  return Utils.toArray(
    [tag, fields.queryId, fields.host, fields.contentHash, String(fields.payloadSize)].join('\n'),
    'utf8'
  )
}

export function attestationPreimage(fields: SignedFields): number[] {
  return preimage(ATTESTATION_TAG, fields)
}

export function deliveryPreimage(fields: SignedFields): number[] {
  return preimage(DELIVERY_TAG, fields)
}

export async function signAttestation(
  wallet: WalletInterface,
  fields: SignedFields & { quotedFeeSats: number; attestedAt: string; anchors?: TopicAnchor[] },
  originator?: string
): Promise<Attestation> {
  const signature = await signBRC77(wallet, attestationPreimage(fields), originator)
  const attestation: Attestation = {
    type: 'attest',
    queryId: fields.queryId,
    host: fields.host,
    contentHash: fields.contentHash,
    payloadSize: fields.payloadSize,
    quotedFeeSats: fields.quotedFeeSats,
    attestedAt: fields.attestedAt,
    signature: Utils.toHex(signature)
  }
  if (fields.anchors !== undefined && fields.anchors.length > 0) {
    attestation.anchors = fields.anchors
  }
  return attestation
}

export async function signDelivery(
  wallet: WalletInterface,
  fields: { queryId: string; host: string; payload: number[]; supplement?: number[] },
  originator?: string
): Promise<Delivery> {
  const signed: SignedFields = {
    queryId: fields.queryId,
    host: fields.host,
    contentHash: contentHash(fields.payload),
    payloadSize: fields.payload.length
  }
  const signature = await signBRC77(wallet, deliveryPreimage(signed), originator)
  const delivery: Delivery = {
    type: 'payload',
    ...signed,
    payload: Utils.toBase64(fields.payload),
    signature: Utils.toHex(signature)
  }
  if (fields.supplement !== undefined && fields.supplement.length > 0) {
    delivery.supplement = Utils.toBase64(fields.supplement)
  }
  return delivery
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseSignedFields(value: Record<string, unknown>): SignedFields & { signature: string } {
  if (!isHashHex(value.queryId)) throw new TypeError('queryId must be 32 bytes of hex')
  if (!isPublicKeyHex(value.host)) throw new TypeError('host must be a compressed public key')
  if (!isHashHex(value.contentHash)) throw new TypeError('contentHash must be 32 bytes of hex')
  if (!nonNegativeInteger(value.payloadSize)) {
    throw new TypeError('payloadSize must be a non-negative integer')
  }
  if (typeof value.signature !== 'string' || !SIGNATURE_HEX.test(value.signature)) {
    throw new TypeError('signature must be lowercase hex')
  }
  return {
    queryId: value.queryId,
    host: value.host,
    contentHash: value.contentHash,
    payloadSize: value.payloadSize,
    signature: value.signature
  }
}

function parseAnchors(value: unknown): TopicAnchor[] | undefined {
  if (!Array.isArray(value)) return undefined
  const anchors: TopicAnchor[] = []
  for (const item of value.slice(0, MAX_ANCHORS)) {
    if (
      !isPlainObject(item) ||
      typeof item.topic !== 'string' ||
      item.topic.length === 0 ||
      item.topic.length > 256 ||
      typeof item.blockHeight !== 'number' ||
      !Number.isSafeInteger(item.blockHeight) ||
      item.blockHeight < -1 ||
      !isHashHex(item.tac)
    ) {
      continue
    }
    const anchor: TopicAnchor = { topic: item.topic, blockHeight: item.blockHeight, tac: item.tac }
    if (isHashHex(item.blockHash)) anchor.blockHash = item.blockHash
    anchors.push(anchor)
  }
  return anchors.length > 0 ? anchors : undefined
}

/** Validates an untrusted attestation. Anchors are an extension, so bad anchors are dropped. */
export function parseAttestation(value: unknown): Attestation {
  if (!isPlainObject(value) || value.type !== 'attest') {
    throw new TypeError('Attestation must be an object of type attest')
  }
  const signed = parseSignedFields(value)
  if (!nonNegativeInteger(value.quotedFeeSats)) {
    throw new TypeError('quotedFeeSats must be a non-negative integer')
  }
  if (typeof value.attestedAt !== 'string' || value.attestedAt.length > 64) {
    throw new TypeError('attestedAt must be a short string')
  }
  const attestation: Attestation = {
    type: 'attest',
    queryId: signed.queryId,
    host: signed.host,
    contentHash: signed.contentHash,
    payloadSize: signed.payloadSize,
    quotedFeeSats: value.quotedFeeSats,
    attestedAt: value.attestedAt,
    signature: signed.signature
  }
  const anchors = parseAnchors(value.anchors)
  if (anchors !== undefined) attestation.anchors = anchors
  return attestation
}

export function parseDelivery(value: unknown): Delivery {
  if (!isPlainObject(value) || value.type !== 'payload') {
    throw new TypeError('Delivery must be an object of type payload')
  }
  const signed = parseSignedFields(value)
  if (!isCanonicalBase64(value.payload)) throw new TypeError('payload must be canonical base64')
  const delivery: Delivery = {
    type: 'payload',
    queryId: signed.queryId,
    host: signed.host,
    contentHash: signed.contentHash,
    payloadSize: signed.payloadSize,
    payload: value.payload,
    signature: signed.signature
  }
  if (value.supplement !== undefined) {
    if (!isCanonicalBase64(value.supplement)) {
      throw new TypeError('supplement must be canonical base64')
    }
    delivery.supplement = value.supplement
  }
  return delivery
}

function verifySignature(
  signedBytes: number[],
  fields: SignedFields & { signature: string }
): Verdict {
  const result = verifyBRC77(signedBytes, Utils.toArray(fields.signature, 'hex'))
  if (!result.valid) return 'bad-signature'
  return result.signer === fields.host ? 'ok' : 'identity-mismatch'
}

/** `expected.host` is the BRC-103 session identity the attestation arrived under. */
export function verifyAttestation(
  attestation: Attestation,
  expected: { queryId: string; host: string }
): Verdict {
  if (attestation.queryId !== expected.queryId) return 'wrong-query'
  if (attestation.host !== expected.host) return 'identity-mismatch'
  return verifySignature(attestationPreimage(attestation), attestation)
}

export function verifyDelivery(
  delivery: Delivery,
  expected: { queryId: string; host: string; contentHash: string }
):
  { verdict: 'ok'; payload: number[]; supplement: number[] } | { verdict: Exclude<Verdict, 'ok'> } {
  if (delivery.queryId !== expected.queryId) return { verdict: 'wrong-query' }
  if (delivery.host !== expected.host) return { verdict: 'identity-mismatch' }
  const payload = Utils.toArray(delivery.payload, 'base64')
  if (
    delivery.contentHash !== expected.contentHash ||
    delivery.payloadSize !== payload.length ||
    contentHash(payload) !== expected.contentHash
  ) {
    return { verdict: 'hash-mismatch' }
  }
  const verdict = verifySignature(deliveryPreimage(delivery), delivery)
  if (verdict !== 'ok') return { verdict }
  const supplement =
    delivery.supplement === undefined ? [] : Utils.toArray(delivery.supplement, 'base64')
  return { verdict: 'ok', payload, supplement }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/attestation.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 10: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  attestationPreimage,
  deliveryPreimage,
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery,
  type Attestation,
  type Delivery,
  type SignedFields,
  type TopicAnchor,
  type Verdict
} from './protocol/attestation.js'
export { signBRC77, verifyBRC77 } from './protocol/brc77.js'
export { isCanonicalBase64 } from './protocol/encoding.js'
export { EQCError, type EQCErrorCode } from './protocol/errors.js'
```

Append to `packages/overlays/eqc/src/host.ts`:

```ts
export { signAttestation, signDelivery } from './protocol/attestation.js'
export { HostError, type HostErrorCode } from './protocol/errors.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add wallet-based BRC-77 attestations and deliveries" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: BRC-29 payout derivation and payment envelopes

**Files:**

- Create: `packages/overlays/eqc/src/protocol/payment.ts`
- Test: `packages/overlays/eqc/src/protocol/payment.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `isHashHex`, `isPlainObject` (Task 1); `isCanonicalBase64` (Task 4).
- Produces:
  - `BRC29_PROTOCOL_ID: WalletProtocol` = `[2, '3241645161d8']`
  - `derivationPrefix(queryId: string): string`, `derivationSuffix(rank: number): string`
  - `interface PaymentEnvelope { derivationPrefix: string; derivationSuffix: string; transaction: string }`
  - `paymentEnvelope(queryId: string, rank: number, atomicBeef: number[]): PaymentEnvelope`
  - `parsePaymentEnvelope(value: unknown): PaymentEnvelope` (throws `TypeError`)
  - `payoutLockingScript(wallet: WalletInterface, counterparty: string, queryId: string, rank: number, forSelf: boolean, originator?: string): Promise<string>` — locking script hex. The payer passes the host key and `forSelf: false`; the host passes the client key and `forSelf: true`.

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/protocol/payment.test.ts`:

```ts
import { CompletedProtoWallet, PrivateKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  BRC29_PROTOCOL_ID,
  derivationPrefix,
  derivationSuffix,
  parsePaymentEnvelope,
  paymentEnvelope,
  payoutLockingScript
} from './payment.js'

const queryId = 'a4'.repeat(32)

describe('derivation encoding', () => {
  it('pins the BRC-29 protocol', () => {
    expect(BRC29_PROTOCOL_ID).toEqual([2, '3241645161d8'])
  })

  it('encodes the query ID bytes as standard base64', () => {
    expect(Utils.toHex(Utils.toArray(derivationPrefix(queryId), 'base64'))).toBe(queryId)
    expect(() => derivationPrefix('abc')).toThrow(TypeError)
  })

  it('encodes the rank as two big-endian bytes', () => {
    expect(derivationSuffix(1)).toBe('AAE=')
    expect(derivationSuffix(5)).toBe('AAU=')
    expect(derivationSuffix(256)).toBe('AQA=')
    expect(() => derivationSuffix(0)).toThrow(RangeError)
    expect(() => derivationSuffix(65_536)).toThrow(RangeError)
    expect(() => derivationSuffix(1.5)).toThrow(RangeError)
  })
})

describe('payoutLockingScript', () => {
  const payerKey = PrivateKey.fromRandom()
  const hostKey = PrivateKey.fromRandom()
  const payer = new CompletedProtoWallet(payerKey)
  const host = new CompletedProtoWallet(hostKey)
  const payerId = payerKey.toPublicKey().toString()
  const hostId = hostKey.toPublicKey().toString()

  it('derives the same script for payer and payee', async () => {
    const paid = await payoutLockingScript(payer, hostId, queryId, 2, false)
    const claimed = await payoutLockingScript(host, payerId, queryId, 2, true)
    expect(paid).toBe(claimed)
    expect(paid).toMatch(/^76a914[0-9a-f]{40}88ac$/)
  })

  it('binds the script to one query and one rank', async () => {
    const base = await payoutLockingScript(payer, hostId, queryId, 2, false)
    expect(await payoutLockingScript(payer, hostId, queryId, 3, false)).not.toBe(base)
    expect(await payoutLockingScript(payer, hostId, 'b5'.repeat(32), 2, false)).not.toBe(base)
  })
})

describe('payment envelopes', () => {
  it('round-trip through JSON', () => {
    const envelope = paymentEnvelope(queryId, 3, [1, 2, 3])
    expect(envelope).toEqual({
      derivationPrefix: derivationPrefix(queryId),
      derivationSuffix: 'AAM=',
      transaction: 'AQID'
    })
    expect(parsePaymentEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
  })

  it('reject missing fields, URL-safe base64, and unpadded base64', () => {
    const envelope = paymentEnvelope(queryId, 1, [1, 2, 3])
    expect(() => parsePaymentEnvelope({ ...envelope, transaction: undefined })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope({ ...envelope, derivationPrefix: 'a-_b' })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope({ ...envelope, derivationSuffix: 'AAE' })).toThrow(TypeError)
    expect(() => parsePaymentEnvelope('envelope')).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/payment.test.ts`
Expected: FAIL with `Cannot find module './payment.js'`.

- [ ] **Step 3: Implement the payment helpers**

`packages/overlays/eqc/src/protocol/payment.ts`:

```ts
import { P2PKH, PublicKey, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

import { isCanonicalBase64 } from './encoding.js'
import { isHashHex, isPlainObject } from './query.js'

export const BRC29_PROTOCOL_ID: WalletProtocol = [2, '3241645161d8']

const MAX_TRANSACTION_BASE64 = 8 * 1024 * 1024
const MAX_DERIVATION_CHARS = 512

export interface PaymentEnvelope {
  derivationPrefix: string
  derivationSuffix: string
  transaction: string
}

/** `wallet.internalizeAction` accepts only standard base64, so the query ID bytes are re-encoded. */
export function derivationPrefix(queryId: string): string {
  if (!isHashHex(queryId)) throw new TypeError('queryId must be 32 bytes of lowercase hex')
  return Utils.toBase64(Utils.toArray(queryId, 'hex'))
}

/** Two-byte big-endian rank; rank 1 is `AAE=`. */
export function derivationSuffix(rank: number): string {
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > 0xffff) {
    throw new RangeError('rank must be an integer from 1 to 65535')
  }
  return Utils.toBase64([rank >> 8, rank & 0xff])
}

export function paymentEnvelope(
  queryId: string,
  rank: number,
  atomicBeef: number[]
): PaymentEnvelope {
  return {
    derivationPrefix: derivationPrefix(queryId),
    derivationSuffix: derivationSuffix(rank),
    transaction: Utils.toBase64(atomicBeef)
  }
}

export function parsePaymentEnvelope(value: unknown): PaymentEnvelope {
  if (!isPlainObject(value)) throw new TypeError('Payment must be a JSON object')
  const { derivationPrefix: prefix, derivationSuffix: suffix, transaction } = value
  if (!isCanonicalBase64(prefix) || prefix.length === 0 || prefix.length > MAX_DERIVATION_CHARS) {
    throw new TypeError('derivationPrefix must be canonical base64')
  }
  if (!isCanonicalBase64(suffix) || suffix.length === 0 || suffix.length > MAX_DERIVATION_CHARS) {
    throw new TypeError('derivationSuffix must be canonical base64')
  }
  if (
    !isCanonicalBase64(transaction) ||
    transaction.length === 0 ||
    transaction.length > MAX_TRANSACTION_BASE64
  ) {
    throw new TypeError('transaction must be canonical base64 Atomic BEEF')
  }
  return { derivationPrefix: prefix, derivationSuffix: suffix, transaction }
}

/**
 * P2PKH script for the BRC-29 key bound to one query and one rank. The payer derives the host's
 * child key (`forSelf: false`); the host derives its own (`forSelf: true`). BRC-42 makes them equal.
 */
export async function payoutLockingScript(
  wallet: WalletInterface,
  counterparty: string,
  queryId: string,
  rank: number,
  forSelf: boolean,
  originator?: string
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${derivationPrefix(queryId)} ${derivationSuffix(rank)}`,
      counterparty,
      forSelf
    },
    originator
  )
  return new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/payment.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  BRC29_PROTOCOL_ID,
  derivationPrefix,
  derivationSuffix,
  parsePaymentEnvelope,
  paymentEnvelope,
  payoutLockingScript,
  type PaymentEnvelope
} from './protocol/payment.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add BRC-29 payout derivation bound to query and rank" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Host pending-query store

**Files:**

- Create: `packages/overlays/eqc/src/host/pendingStore.ts`
- Test: `packages/overlays/eqc/src/host/pendingStore.test.ts`
- Modify: `packages/overlays/eqc/src/host.ts`

**Interfaces:**

- Consumes: `EconomicQuery` (Task 1); `Attestation` (Task 4).
- Produces:
  - `type PendingState = 'pending' | 'settling' | 'settled'`
  - `interface PendingQuery { queryId: string; query: EconomicQuery; clientIdentityKey: string; attestation: Attestation; payload: number[]; supplement: number[]; expiresAt: number; state: PendingState }`
  - `interface PendingStore { get(queryId): Promise<PendingQuery | undefined>; put(record): Promise<'stored' | 'too-many-pending' | 'too-large'>; beginSettle(queryId): Promise<boolean>; abortSettle(queryId): Promise<void>; completeSettle(queryId): Promise<void> }`
  - `interface PendingStoreLimits { maxEntries: number; maxBytes: number; maxPendingPerClient: number; settledGraceMs: number }`
  - `class InMemoryPendingStore implements PendingStore { constructor(limits?: Partial<PendingStoreLimits>, clock?: () => number) }`

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/host/pendingStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Attestation } from '../protocol/attestation.js'
import type { EconomicQuery } from '../protocol/query.js'
import { InMemoryPendingStore, type PendingQuery } from './pendingStore.js'

const clientA = `02${'aa'.repeat(32)}`
const clientB = `02${'bb'.repeat(32)}`

function record(id: number, client: string, expiresAt: number, bytes = 10): PendingQuery {
  return {
    queryId: id.toString(16).padStart(64, '0'),
    query: {} as EconomicQuery,
    clientIdentityKey: client,
    attestation: {} as Attestation,
    payload: Array.from({ length: bytes }, () => 1),
    supplement: [],
    expiresAt,
    state: 'pending'
  }
}

describe('InMemoryPendingStore', () => {
  it('stores and returns records', async () => {
    const store = new InMemoryPendingStore({}, () => 0)
    const entry = record(1, clientA, 1000)
    expect(await store.put(entry)).toBe('stored')
    expect(await store.get(entry.queryId)).toBe(entry)
    expect(await store.get('ff'.repeat(32))).toBeUndefined()
  })

  it('caps pending queries per client without starving other clients', async () => {
    const store = new InMemoryPendingStore({ maxPendingPerClient: 2 }, () => 0)
    expect(await store.put(record(1, clientA, 1000))).toBe('stored')
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
    expect(await store.put(record(3, clientA, 1000))).toBe('too-many-pending')
    expect(await store.put(record(4, clientB, 1000))).toBe('stored')
  })

  it('rejects rather than evicts live records when full', async () => {
    const store = new InMemoryPendingStore({ maxEntries: 1, maxBytes: 15 }, () => 0)
    expect(await store.put(record(1, clientA, 1000, 20))).toBe('too-large')
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
    expect(await store.put(record(3, clientB, 1000))).toBe('too-many-pending')
    expect(await store.get(record(2, clientA, 1000).queryId)).toBeDefined()
  })

  it('reclaims room from expired records', async () => {
    let now = 0
    const store = new InMemoryPendingStore({ maxEntries: 1, settledGraceMs: 0 }, () => now)
    expect(await store.put(record(1, clientA, 1000))).toBe('stored')
    now = 1000
    expect(await store.put(record(2, clientB, 2000))).toBe('stored')
    expect(await store.get(record(1, clientA, 1000).queryId)).toBeUndefined()
  })

  it('keeps an expired record visible during the grace period, then forgets it', async () => {
    let now = 0
    const store = new InMemoryPendingStore({ settledGraceMs: 500 }, () => now)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    now = 1200
    expect(await store.get(entry.queryId)).toBe(entry)
    now = 1500
    expect(await store.get(entry.queryId)).toBeUndefined()
  })

  it('lets exactly one caller settle, and releases the claim on abort', async () => {
    const store = new InMemoryPendingStore({}, () => 0)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    expect(await store.beginSettle(entry.queryId)).toBe(true)
    expect(await store.beginSettle(entry.queryId)).toBe(false)
    await store.abortSettle(entry.queryId)
    expect(entry.state).toBe('pending')
    expect(await store.beginSettle(entry.queryId)).toBe(true)
    await store.completeSettle(entry.queryId)
    expect(entry.state).toBe('settled')
    expect(entry.payload).toEqual([])
    expect(await store.beginSettle(entry.queryId)).toBe(false)
    expect(await store.beginSettle('ff'.repeat(32))).toBe(false)
  })

  it('frees a settled record from the per-client cap', async () => {
    const store = new InMemoryPendingStore({ maxPendingPerClient: 1 }, () => 0)
    const entry = record(1, clientA, 1000)
    await store.put(entry)
    await store.beginSettle(entry.queryId)
    await store.completeSettle(entry.queryId)
    expect(await store.put(record(2, clientA, 1000))).toBe('stored')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/pendingStore.test.ts`
Expected: FAIL with `Cannot find module './pendingStore.js'`.

- [ ] **Step 3: Implement the store**

`packages/overlays/eqc/src/host/pendingStore.ts`:

```ts
import type { Attestation } from '../protocol/attestation.js'
import type { EconomicQuery } from '../protocol/query.js'

export type PendingState = 'pending' | 'settling' | 'settled'

export interface PendingQuery {
  queryId: string
  query: EconomicQuery
  clientIdentityKey: string
  attestation: Attestation
  payload: number[]
  supplement: number[]
  expiresAt: number
  state: PendingState
}

/** Asynchronous so a shared store can back several host instances. */
export interface PendingStore {
  get: (queryId: string) => Promise<PendingQuery | undefined>
  put: (record: PendingQuery) => Promise<'stored' | 'too-many-pending' | 'too-large'>
  /** Atomically claims a pending query for settlement. False when it is not claimable. */
  beginSettle: (queryId: string) => Promise<boolean>
  abortSettle: (queryId: string) => Promise<void>
  completeSettle: (queryId: string) => Promise<void>
}

export interface PendingStoreLimits {
  maxEntries: number
  maxBytes: number
  maxPendingPerClient: number
  settledGraceMs: number
}

const DEFAULT_LIMITS: PendingStoreLimits = {
  maxEntries: 10_000,
  maxBytes: 256 * 1024 * 1024,
  maxPendingPerClient: 32,
  settledGraceMs: 60_000
}

function sizeOf(record: PendingQuery): number {
  return record.payload.length + record.supplement.length
}

/**
 * Attestation is free and caches a payload, so the store is bounded. A full store rejects new
 * queries instead of evicting live ones, which would break honest clients mid-race.
 */
export class InMemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PendingQuery>()
  private readonly limits: PendingStoreLimits
  private readonly clock: () => number
  private bytes = 0

  constructor(limits: Partial<PendingStoreLimits> = {}, clock: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.clock = clock
  }

  async get(queryId: string): Promise<PendingQuery | undefined> {
    const record = this.records.get(queryId)
    if (record === undefined) return undefined
    if (this.clock() >= record.expiresAt + this.limits.settledGraceMs) {
      this.remove(record)
      return undefined
    }
    return record
  }

  async put(record: PendingQuery): Promise<'stored' | 'too-many-pending' | 'too-large'> {
    const size = sizeOf(record)
    if (size > this.limits.maxBytes) return 'too-large'
    this.purge()
    let pendingForClient = 0
    for (const existing of this.records.values()) {
      if (existing.clientIdentityKey === record.clientIdentityKey && existing.state !== 'settled') {
        pendingForClient++
      }
    }
    if (
      pendingForClient >= this.limits.maxPendingPerClient ||
      this.records.size >= this.limits.maxEntries ||
      this.bytes + size > this.limits.maxBytes
    ) {
      return 'too-many-pending'
    }
    this.records.set(record.queryId, record)
    this.bytes += size
    return 'stored'
  }

  async beginSettle(queryId: string): Promise<boolean> {
    const record = this.records.get(queryId)
    if (record === undefined || record.state !== 'pending') return false
    record.state = 'settling'
    return true
  }

  async abortSettle(queryId: string): Promise<void> {
    const record = this.records.get(queryId)
    if (record?.state === 'settling') record.state = 'pending'
  }

  async completeSettle(queryId: string): Promise<void> {
    const record = this.records.get(queryId)
    if (record === undefined) return
    this.bytes -= sizeOf(record)
    record.payload = []
    record.supplement = []
    record.state = 'settled'
  }

  private purge(): void {
    const now = this.clock()
    for (const record of this.records.values()) {
      if (now >= record.expiresAt + this.limits.settledGraceMs) this.remove(record)
    }
  }

  private remove(record: PendingQuery): void {
    this.records.delete(record.queryId)
    this.bytes -= sizeOf(record)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/pendingStore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export, check, and commit**

Append to `packages/overlays/eqc/src/host.ts`:

```ts
export {
  InMemoryPendingStore,
  type PendingQuery,
  type PendingState,
  type PendingStore,
  type PendingStoreLimits
} from './host/pendingStore.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add bounded pending-query store for hosts" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Wallet test doubles and the host payment verifier

**Files:**

- Create: `packages/overlays/eqc/test/support/wallets.ts`, `packages/overlays/eqc/test/support/transactions.ts`
- Create: `packages/overlays/eqc/src/host/paymentVerifier.ts`
- Test: `packages/overlays/eqc/src/host/paymentVerifier.test.ts`
- Modify: `packages/overlays/eqc/src/host.ts`

**Interfaces:**

- Consumes: `PaymentEnvelope`, `derivationPrefix`, `derivationSuffix`, `paymentEnvelope`, `payoutLockingScript` (Task 5).
- Produces:
  - `class PayerWallet extends CompletedProtoWallet { readonly identityKey: string; readonly actions: CreateActionArgs[]; failCreateAction: boolean }` — `createAction` builds a real Atomic BEEF transaction with the requested outputs in order.
  - `class HostWallet extends CompletedProtoWallet { readonly identityKey: string; readonly internalized: Array<{ txid: string; outputIndex: number; satoshis: number; sender: string }>; rejectPayments: boolean }` — `internalizeAction` performs the same BRC-29 locking-script check wallet-toolbox performs.
  - `sampleBeef(satoshis: number): { beef: number[]; txid: string }`
  - `type PaymentVerification = { ok: true; txid: string; outputIndex: number; satoshis: number } | { ok: false; reason: 'malformed' | 'no-output' | 'underpaid' | 'rejected'; required?: number; paid?: number }`
  - `verifyAndInternalizePayment(args: { wallet: WalletInterface; envelope: PaymentEnvelope; queryId: string; rank: number; clientIdentityKey: string; requiredSats: number; originator?: string }): Promise<PaymentVerification>`

- [ ] **Step 1: Create the wallet doubles**

`packages/overlays/eqc/test/support/wallets.ts`:

```ts
import {
  Beef,
  CompletedProtoWallet,
  LockingScript,
  P2PKH,
  PrivateKey,
  PublicKey,
  Script,
  Transaction,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type InternalizeActionResult
} from '@bsv/sdk'

/** A paying wallet: real key derivation, and `createAction` that builds a real Atomic BEEF. */
export class PayerWallet extends CompletedProtoWallet {
  readonly identityKey: string
  readonly actions: CreateActionArgs[] = []
  failCreateAction = false

  constructor(key: PrivateKey = PrivateKey.fromRandom()) {
    super(key)
    this.identityKey = key.toPublicKey().toString()
  }

  override async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    if (this.failCreateAction) throw new Error('Insufficient funds')
    this.actions.push(args)
    const transaction = new Transaction()
    transaction.addInput({
      sourceTXID: '0'.repeat(64),
      sourceOutputIndex: 0xffffffff,
      unlockingScript: Script.fromHex('00'),
      sequence: 0xffffffff
    })
    for (const output of args.outputs ?? []) {
      transaction.addOutput({
        lockingScript: LockingScript.fromHex(output.lockingScript),
        satoshis: output.satoshis
      })
    }
    const txid = transaction.id('hex')
    const beef = new Beef()
    beef.mergeTransaction(transaction)
    return { txid, tx: beef.toBinaryAtomic(txid) }
  }
}

/** A host wallet whose `internalizeAction` checks the BRC-29 script exactly as wallet-toolbox does. */
export class HostWallet extends CompletedProtoWallet {
  readonly identityKey: string
  readonly internalized: Array<{
    txid: string
    outputIndex: number
    satoshis: number
    sender: string
  }> = []
  rejectPayments = false

  constructor(key: PrivateKey = PrivateKey.fromRandom()) {
    super(key)
    this.identityKey = key.toPublicKey().toString()
  }

  override async internalizeAction(args: InternalizeActionArgs): Promise<InternalizeActionResult> {
    if (this.rejectPayments) throw new Error('Payment rejected')
    const transaction = Transaction.fromAtomicBEEF(args.tx)
    for (const entry of args.outputs) {
      const remittance = entry.paymentRemittance
      if (entry.protocol !== 'wallet payment' || remittance === undefined) {
        throw new Error('Only wallet payments are supported')
      }
      const { publicKey } = await this.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
        counterparty: remittance.senderIdentityKey,
        forSelf: true
      })
      const expected = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
      const output = transaction.outputs[entry.outputIndex]
      if (output === undefined || output.lockingScript.toHex() !== expected) {
        throw new Error('Output is not locked by a script conforming to BRC-29')
      }
      this.internalized.push({
        txid: transaction.id('hex'),
        outputIndex: entry.outputIndex,
        satoshis: output.satoshis ?? 0,
        sender: remittance.senderIdentityKey
      })
    }
    return { accepted: true }
  }
}
```

`packages/overlays/eqc/test/support/transactions.ts`:

```ts
import { Beef, P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'

/** A one-output transaction wrapped in BEEF, for building lookup answers in tests. */
export function sampleBeef(satoshis: number): { beef: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({
    lockingScript: new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()),
    satoshis
  })
  const txid = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return { beef: beef.toBinary(), txid }
}
```

- [ ] **Step 2: Write the failing test**

`packages/overlays/eqc/src/host/paymentVerifier.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { paymentEnvelope, payoutLockingScript } from '../protocol/payment.js'
import { verifyAndInternalizePayment } from './paymentVerifier.js'

const queryId = 'a4'.repeat(32)

async function payout(
  payer: PayerWallet,
  hosts: HostWallet[],
  satoshis: number[]
): Promise<number[]> {
  const outputs = await Promise.all(
    hosts.map(async (host, index) => ({
      lockingScript: await payoutLockingScript(payer, host.identityKey, queryId, index + 1, false),
      satoshis: satoshis[index],
      outputDescription: `Rank ${index + 1} payout`
    }))
  )
  const result = await payer.createAction({ description: 'BRC-178 query payout', outputs })
  if (result.tx === undefined) throw new Error('No transaction')
  return result.tx
}

describe('verifyAndInternalizePayment', () => {
  it('finds and internalizes its own output at a non-zero index', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet(), new HostWallet()]
    const transaction = await payout(payer, hosts, [500, 250, 250])
    const result = await verifyAndInternalizePayment({
      wallet: hosts[1],
      envelope: paymentEnvelope(queryId, 2, transaction),
      queryId,
      rank: 2,
      clientIdentityKey: payer.identityKey,
      requiredSats: 250
    })
    expect(result).toMatchObject({ ok: true, outputIndex: 1, satoshis: 250 })
    expect(hosts[1].internalized).toEqual([
      expect.objectContaining({ outputIndex: 1, satoshis: 250, sender: payer.identityKey })
    ])
  })

  it('reports underpayment without touching the wallet', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    const transaction = await payout(payer, [host], [100])
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, transaction),
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 250
    })
    expect(result).toEqual({ ok: false, reason: 'underpaid', required: 250, paid: 100 })
    expect(host.internalized).toEqual([])
  })

  it('finds nothing when the transaction pays another rank', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet()]
    const transaction = await payout(payer, hosts, [500, 250])
    const result = await verifyAndInternalizePayment({
      wallet: hosts[0],
      envelope: paymentEnvelope(queryId, 2, transaction),
      queryId,
      rank: 2,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'no-output' })
  })

  it('rejects an envelope bound to another query or another rank', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    const transaction = await payout(payer, [host], [500])
    const base = {
      wallet: host,
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    }
    expect(
      await verifyAndInternalizePayment({
        ...base,
        envelope: paymentEnvelope('b5'.repeat(32), 1, transaction)
      })
    ).toEqual({ ok: false, reason: 'malformed' })
    expect(
      await verifyAndInternalizePayment({
        ...base,
        envelope: paymentEnvelope(queryId, 2, transaction)
      })
    ).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects bytes that are not Atomic BEEF', async () => {
    const host = new HostWallet()
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, [1, 2, 3]),
      queryId,
      rank: 1,
      clientIdentityKey: new PayerWallet().identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('reports a wallet refusal as rejected', async () => {
    const payer = new PayerWallet()
    const host = new HostWallet()
    host.rejectPayments = true
    const transaction = await payout(payer, [host], [500])
    const result = await verifyAndInternalizePayment({
      wallet: host,
      envelope: paymentEnvelope(queryId, 1, transaction),
      queryId,
      rank: 1,
      clientIdentityKey: payer.identityKey,
      requiredSats: 1
    })
    expect(result).toEqual({ ok: false, reason: 'rejected' })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/paymentVerifier.test.ts`
Expected: FAIL with `Cannot find module './paymentVerifier.js'`.

- [ ] **Step 4: Implement the verifier**

`packages/overlays/eqc/src/host/paymentVerifier.ts`:

```ts
import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'

import {
  derivationPrefix,
  derivationSuffix,
  payoutLockingScript,
  type PaymentEnvelope
} from '../protocol/payment.js'

export type PaymentVerification =
  | { ok: true; txid: string; outputIndex: number; satoshis: number }
  | {
      ok: false
      reason: 'malformed' | 'no-output' | 'underpaid' | 'rejected'
      required?: number
      paid?: number
    }

/**
 * Verifies a BRC-178 payout for this host. `@bsv/payment-express-middleware` cannot be used: it
 * demands a server-minted derivation prefix and always internalizes output 0. Here the prefix is
 * the query ID, and the host finds its own output by deriving the script it expects.
 */
export async function verifyAndInternalizePayment(args: {
  wallet: WalletInterface
  envelope: PaymentEnvelope
  queryId: string
  rank: number
  clientIdentityKey: string
  requiredSats: number
  originator?: string
}): Promise<PaymentVerification> {
  const { wallet, envelope, queryId, rank, clientIdentityKey, requiredSats, originator } = args
  if (
    envelope.derivationPrefix !== derivationPrefix(queryId) ||
    envelope.derivationSuffix !== derivationSuffix(rank)
  ) {
    return { ok: false, reason: 'malformed' }
  }
  const atomicBeef = Utils.toArray(envelope.transaction, 'base64')
  let transaction: Transaction
  try {
    transaction = Transaction.fromAtomicBEEF(atomicBeef)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const expected = await payoutLockingScript(
    wallet,
    clientIdentityKey,
    queryId,
    rank,
    true,
    originator
  )
  const outputIndex = transaction.outputs.findIndex(
    output => output.lockingScript.toHex() === expected
  )
  if (outputIndex === -1) return { ok: false, reason: 'no-output' }
  const satoshis = transaction.outputs[outputIndex].satoshis ?? 0
  if (satoshis < requiredSats) {
    return { ok: false, reason: 'underpaid', required: requiredSats, paid: satoshis }
  }
  try {
    const result = await wallet.internalizeAction(
      {
        tx: atomicBeef,
        outputs: [
          {
            outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: envelope.derivationPrefix,
              derivationSuffix: envelope.derivationSuffix,
              senderIdentityKey: clientIdentityKey
            }
          }
        ],
        description: 'BRC-178 query payout',
        labels: ['brc178']
      },
      originator
    )
    if (result.accepted !== true) return { ok: false, reason: 'rejected' }
  } catch {
    return { ok: false, reason: 'rejected' }
  }
  return { ok: true, txid: transaction.id('hex'), outputIndex, satoshis }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/paymentVerifier.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Export, check, and commit**

Append to `packages/overlays/eqc/src/host.ts`:

```ts
export { verifyAndInternalizePayment, type PaymentVerification } from './host/paymentVerifier.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): verify BRC-178 payouts by derived script at any output index" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Query providers

**Files:**

- Create: `packages/overlays/eqc/src/host/providers.ts`
- Test: `packages/overlays/eqc/src/host/providers.test.ts`
- Modify: `packages/overlays/eqc/src/host.ts`

**Interfaces:**

- Consumes: `EconomicQuery`, `isPublicKeyHex` (Task 1); `CanonicalMessage`, `canonicalizeLookupAnswer`, `encodeMessageList` (Task 3); `TopicAnchor`, `HostError` (Task 4); `sampleBeef` (Task 7).
- Produces:
  - `interface ProviderResult { payload: number[]; supplement?: number[]; extensions?: { anchors?: TopicAnchor[] } }`
  - `interface QueryProvider { readonly type: string; execute(query: EconomicQuery, context: { clientIdentityKey: string }): Promise<ProviderResult> }`
  - `interface LookupEngineLike { lookup(question: LookupQuestion): Promise<{ type: string; outputs?: unknown }>; provideTopicAnchorTip?(topic: string): Promise<{ topic: string; blockHeight: number; blockHash?: string; tac: string }> }`
  - `overlayLookupProvider(options: { engine: LookupEngineLike; anchorTopics?: Record<string, string[]> }): QueryProvider` — type `overlay-lookup`
  - `interface MessageListSource { listMessages(recipient: string, messageBox: string): Promise<CanonicalMessage[]> }`
  - `messageListProvider(source: MessageListSource): QueryProvider` — type `message-list`
  - `bytesProvider(type: string, resolve: (params: Record<string, unknown>, context: { clientIdentityKey: string }) => Promise<number[] | undefined>): QueryProvider`

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/host/providers.test.ts`:

```ts
import { Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { sampleBeef } from '../../test/support/transactions.js'
import { HostError } from '../protocol/errors.js'
import { decodeOutpointList } from '../protocol/payloads.js'
import type { EconomicQuery } from '../protocol/query.js'
import { bytesProvider, messageListProvider, overlayLookupProvider } from './providers.js'

const client = `02${'ab'.repeat(32)}`
const context = { clientIdentityKey: client }

function query(type: string, params: Record<string, unknown>): EconomicQuery {
  return {
    type,
    client,
    params,
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: '2026-09-18T19:05:00.000Z',
    nonce: '11'.repeat(32)
  }
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof HostError) return error
    throw error
  }
  throw new Error('Expected a HostError')
}

describe('overlayLookupProvider', () => {
  const first = sampleBeef(1)
  const second = sampleBeef(2)
  const answer: LookupAnswer = {
    type: 'output-list',
    outputs: [
      { beef: second.beef, outputIndex: 0 },
      { beef: first.beef, outputIndex: 0 }
    ]
  }

  it('returns sorted outpoints, a BEEF supplement, and anchors for configured topics', async () => {
    const provider = overlayLookupProvider({
      engine: {
        lookup: async () => answer,
        provideTopicAnchorTip: async topic => ({ topic, blockHeight: 900, tac: 'cd'.repeat(32) })
      },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    expect(provider.type).toBe('overlay-lookup')
    const result = await provider.execute(
      query('overlay-lookup', { service: 'ls_example', query: { key: 'value' } }),
      context
    )
    expect(decodeOutpointList(result.payload).map(entry => entry.txid)).toEqual(
      [first.txid, second.txid].sort()
    )
    expect(result.supplement?.length).toBeGreaterThan(0)
    expect(result.extensions?.anchors).toEqual([
      { topic: 'tm_example', blockHeight: 900, tac: 'cd'.repeat(32) }
    ])
  })

  it('omits anchors when the engine lacks BASM or the tip lookup fails', async () => {
    const plain = overlayLookupProvider({
      engine: { lookup: async () => answer },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    const failing = overlayLookupProvider({
      engine: {
        lookup: async () => answer,
        provideTopicAnchorTip: async () => {
          throw new Error('BASM_UNSUPPORTED')
        }
      },
      anchorTopics: { ls_example: ['tm_example'] }
    })
    const request = query('overlay-lookup', { service: 'ls_example', query: {} })
    expect((await plain.execute(request, context)).extensions).toBeUndefined()
    expect((await failing.execute(request, context)).extensions).toBeUndefined()
  })

  it('passes the question through and rejects bad parameters and freeform answers', async () => {
    const questions: unknown[] = []
    const provider = overlayLookupProvider({
      engine: {
        lookup: async question => {
          questions.push(question)
          return { type: 'freeform' }
        }
      }
    })
    const freeform = await failure(
      provider.execute(query('overlay-lookup', { service: 'ls_x', query: 7 }), context)
    )
    expect(freeform.status).toBe(422)
    expect(freeform.code).toBe('ERR_UNSUPPORTED_CLASS')
    expect(questions).toEqual([{ service: 'ls_x', query: 7 }])
    const invalid = await failure(provider.execute(query('overlay-lookup', { query: 7 }), context))
    expect(invalid.status).toBe(400)
  })
})

describe('messageListProvider', () => {
  const provider = messageListProvider({
    listMessages: async (recipient, messageBox) => [
      { messageId: 'b', sender: recipient, body: messageBox },
      { messageId: 'a', sender: recipient, body: messageBox }
    ]
  })

  it('serves the caller its own canonical list', async () => {
    const result = await provider.execute(
      query('message-list', { recipient: client, messageBox: 'payment_inbox' }),
      context
    )
    expect(Utils.toUTF8(result.payload)).toBe(
      `[{"messageId":"a","sender":"${client}","body":"payment_inbox"},` +
        `{"messageId":"b","sender":"${client}","body":"payment_inbox"}]`
    )
  })

  it("refuses to list another identity's inbox", async () => {
    const other = `03${'cd'.repeat(32)}`
    const error = await failure(
      provider.execute(query('message-list', { recipient: other, messageBox: 'inbox' }), context)
    )
    expect(error.status).toBe(403)
    expect(error.code).toBe('ERR_FORBIDDEN_RECIPIENT')
  })

  it('rejects a missing message box', async () => {
    const error = await failure(
      provider.execute(query('message-list', { recipient: client }), context)
    )
    expect(error.status).toBe(400)
  })
})

describe('bytesProvider', () => {
  it('returns resolver bytes and rejects unknown keys', async () => {
    const provider = bytesProvider('relay-lookup', async params =>
      params.key === 'known' ? [1, 2, 3] : undefined
    )
    expect(provider.type).toBe('relay-lookup')
    expect(
      (await provider.execute(query('relay-lookup', { key: 'known' }), context)).payload
    ).toEqual([1, 2, 3])
    const error = await failure(provider.execute(query('relay-lookup', { key: 'other' }), context))
    expect(error.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/providers.test.ts`
Expected: FAIL with `Cannot find module './providers.js'`.

- [ ] **Step 3: Implement the providers**

`packages/overlays/eqc/src/host/providers.ts`:

```ts
import type { LookupAnswer, LookupQuestion } from '@bsv/sdk'

import type { TopicAnchor } from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import {
  canonicalizeLookupAnswer,
  encodeMessageList,
  type CanonicalMessage
} from '../protocol/payloads.js'
import { isPublicKeyHex, type EconomicQuery } from '../protocol/query.js'

export interface ProviderResult {
  payload: number[]
  /** Bytes delivered with the payload but outside the content hash, such as BEEF. */
  supplement?: number[]
  extensions?: { anchors?: TopicAnchor[] }
}

export interface ProviderContext {
  clientIdentityKey: string
}

/** Answers one query class. Throw `HostError` for a caller mistake; anything else becomes a 500. */
export interface QueryProvider {
  readonly type: string
  execute: (query: EconomicQuery, context: ProviderContext) => Promise<ProviderResult>
}

/** The part of `@bsv/overlay` `Engine` this package uses, typed structurally. */
export interface LookupEngineLike {
  lookup: (question: LookupQuestion) => Promise<{ type: string; outputs?: unknown }>
  provideTopicAnchorTip?: (
    topic: string
  ) => Promise<{ topic: string; blockHeight: number; blockHash?: string; tac: string }>
}

function invalid(description: string): HostError {
  return new HostError(400, 'ERR_INVALID_QUERY', description)
}

async function readAnchors(engine: LookupEngineLike, topics: string[]): Promise<TopicAnchor[]> {
  const provide = engine.provideTopicAnchorTip?.bind(engine)
  if (provide === undefined) return []
  const anchors: TopicAnchor[] = []
  for (const topic of topics) {
    try {
      const tip = await provide(topic)
      const anchor: TopicAnchor = { topic, blockHeight: tip.blockHeight, tac: tip.tac }
      if (tip.blockHash !== undefined) anchor.blockHash = tip.blockHash
      anchors.push(anchor)
    } catch {
      // A node without BASM support still answers; the client reports its anchors as unknown.
    }
  }
  return anchors
}

/**
 * Races BRC-24 lookups. The hashed payload is the sorted outpoint section; BEEF travels as the
 * supplement because honest hosts hold different proof state for the same outputs.
 */
export function overlayLookupProvider(options: {
  engine: LookupEngineLike
  /** BRC-136 topics backing each lookup service, reported as topic anchors. */
  anchorTopics?: Record<string, string[]>
}): QueryProvider {
  return {
    type: 'overlay-lookup',
    async execute(query) {
      const { service, query: question } = query.params
      if (typeof service !== 'string' || service.length === 0 || service.length > 256) {
        throw invalid('params.service must name a lookup service')
      }
      const answer = await options.engine.lookup({ service, query: question })
      if (answer.type !== 'output-list' || !Array.isArray(answer.outputs)) {
        throw new HostError(422, 'ERR_UNSUPPORTED_CLASS', 'Only output-list answers can be raced')
      }
      const result: ProviderResult = canonicalizeLookupAnswer(answer as LookupAnswer)
      const anchors = await readAnchors(options.engine, options.anchorTopics?.[service] ?? [])
      if (anchors.length > 0) result.extensions = { anchors }
      return result
    }
  }
}

export interface MessageListSource {
  listMessages: (recipient: string, messageBox: string) => Promise<CanonicalMessage[]>
}

/** Races BRC-33 message listings. Only the authenticated recipient may list its own inbox. */
export function messageListProvider(source: MessageListSource): QueryProvider {
  return {
    type: 'message-list',
    async execute(query, context) {
      const { recipient, messageBox } = query.params
      if (!isPublicKeyHex(recipient)) throw invalid('params.recipient must be an identity key')
      if (recipient !== context.clientIdentityKey) {
        throw new HostError(
          403,
          'ERR_FORBIDDEN_RECIPIENT',
          'Only the recipient may list its messages'
        )
      }
      if (typeof messageBox !== 'string' || messageBox.length === 0 || messageBox.length > 128) {
        throw invalid('params.messageBox must name a message box')
      }
      return { payload: encodeMessageList(await source.listMessages(recipient, messageBox)) }
    }
  }
}

/** Races any read whose answer is a byte string, such as `relay-lookup` or `message-body`. */
export function bytesProvider(
  type: string,
  resolve: (
    params: Record<string, unknown>,
    context: ProviderContext
  ) => Promise<number[] | undefined>
): QueryProvider {
  return {
    type,
    async execute(query, context) {
      const payload = await resolve(query.params, context)
      if (payload === undefined) throw invalid('No payload exists for these parameters')
      return { payload }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/providers.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export, check, and commit**

Append to `packages/overlays/eqc/src/host.ts`:

```ts
export {
  bytesProvider,
  messageListProvider,
  overlayLookupProvider,
  type LookupEngineLike,
  type MessageListSource,
  type ProviderContext,
  type ProviderResult,
  type QueryProvider
} from './host/providers.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add overlay-lookup, message-list, and byte providers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Host handlers and `createEconomicQueryHost`

**Files:**

- Create: `packages/overlays/eqc/src/protocol/params.ts`, `packages/overlays/eqc/src/host/handlers.ts`
- Test: `packages/overlays/eqc/src/protocol/params.test.ts`, `packages/overlays/eqc/src/host/handlers.test.ts`
- Modify: `packages/overlays/eqc/src/host.ts`, `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `DEFAULTS`, `ECONOMIC_PATHS`, `MAX_RANKED_HOSTS`, `computeQueryId`, `validateQuery`, `isHashHex`, `isPlainObject`, `isPublicKeyHex` (Task 1); `computePayouts` (Task 2); `contentHash` (Task 3); `signAttestation`, `signDelivery`, `HostError` (Task 4); `parsePaymentEnvelope`, `PaymentEnvelope` (Task 5); `InMemoryPendingStore`, `PendingStore` (Task 6); `verifyAndInternalizePayment` (Task 7); `QueryProvider` (Task 8).
- Produces:
  - `interface HostRequest { body?: unknown; headers: Record<string, string | string[] | undefined>; auth?: { identityKey?: string } }`
  - `interface HostResponse { status(code: number): HostResponse; json(body: unknown): unknown; set(name: string, value: string): unknown }`
  - `type HostHandler = (req: HostRequest, res: HostResponse) => Promise<void>`
  - `interface RouterLike { get(path: string, handler: HostHandler): unknown; post(path: string, handler: HostHandler): unknown }`
  - `interface HostParams { version: 1; host: string; threshold: number; topK: number; floorFeeSats: number; minPayoutSats: number; maxQueryTtlMs: number; classes: string[] }` and `parseHostParams(value: unknown): HostParams` (throws `TypeError`), both in `src/protocol/params.ts` so the client can share them without importing host code
  - `interface EconomicQueryHostOptions { wallet: WalletInterface; providers: QueryProvider[]; threshold?: number; topK?: number; floorFeeSats?: number | ((payloadSize: number) => number); minPayoutSats?: number; maxQueryTtlMs?: number; maxPayloadBytes?: number; store?: PendingStore; now?: () => number; originator?: string; logger?: { error: (...args: unknown[]) => void } }`
  - `interface EconomicQueryHost { params: HostHandler; query: HostHandler; collect: HostHandler; mount(router: RouterLike): void }`
  - `createEconomicQueryHost(options: EconomicQueryHostOptions): EconomicQueryHost`

Behaviour the handlers must implement (from the design's error table):

- `params`: unauthenticated; returns `HostParams`, with `floorFeeSats` evaluated at payload size 0.
- `query`: 401 unless `req.auth.identityKey` is a public key; 400 for an invalid body, for `client` differing from the caller, for `expires` beyond `now + maxQueryTtlMs`, or when `strictHosts` excludes this host; 410 when `expires` has passed; 422 for an unknown class; a provider's `HostError` passes through; any other provider failure is a bare 500; 413 above `maxPayloadBytes`; 402 when `query.maxFeeSats` is below this host's floor for the payload; 409 when the query is settling or settled; 429 when the store is full. A repeated pending query from the same client returns the stored attestation.
- `collect`: 401; 400 for a malformed body, duplicate ranking entries, or a ranking longer than `query.topK`; 404 for an unknown query or another client's query; 410 past expiry; 409 when settled, when the hash differs, or when this host is not ranked; 402 (with `x-bsv-payment-version: 1.0` and `x-bsv-payment-satoshis-required`) when payment is missing, underpaid, absent from the transaction, or refused by the wallet; 400 when the envelope is bound to another query or rank. Required satoshis are `max(minPayoutSats, computePayouts(floor(payloadSize), ranking.length)[rank - 1])`. The settle claim is taken before `internalizeAction` and released on failure.

- [ ] **Step 1: Write the failing host-parameters test**

`packages/overlays/eqc/src/protocol/params.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { parseHostParams, type HostParams } from './params.js'

const valid: HostParams = {
  version: 1,
  host: `02${'ab'.repeat(32)}`,
  threshold: 3,
  topK: 5,
  floorFeeSats: 1000,
  minPayoutSats: 1,
  maxQueryTtlMs: 60_000,
  classes: ['overlay-lookup']
}

describe('parseHostParams', () => {
  it('returns a copy holding only known fields', () => {
    expect(parseHostParams({ ...valid, extra: true })).toEqual(valid)
  })

  it.each([
    ['a string', 'params'],
    ['another version', { ...valid, version: 2 }],
    ['a bad host key', { ...valid, host: 'ab' }],
    ['a zero floor', { ...valid, floorFeeSats: 0 }],
    ['a fractional threshold', { ...valid, threshold: 1.5 }],
    ['non-string classes', { ...valid, classes: [1] }],
    ['too many classes', { ...valid, classes: Array.from({ length: 65 }, (_, i) => `c${i}`) }]
  ])('rejects %s', (_label, value) => {
    expect(() => parseHostParams(value)).toThrow(TypeError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/params.test.ts`
Expected: FAIL with `Cannot find module './params.js'`.

`packages/overlays/eqc/src/protocol/params.ts`:

```ts
import { isPlainObject, isPublicKeyHex } from './query.js'

/** Body of `GET /economic/params`. Unauthenticated, so every field is a claim, not a fact. */
export interface HostParams {
  version: 1
  host: string
  threshold: number
  topK: number
  floorFeeSats: number
  minPayoutSats: number
  maxQueryTtlMs: number
  classes: string[]
}

const MAX_CLASSES = 64

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

export function parseHostParams(value: unknown): HostParams {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new TypeError('Host params must be a version 1 object')
  }
  if (!isPublicKeyHex(value.host)) throw new TypeError('host must be a compressed public key')
  const classes = value.classes
  if (
    !Array.isArray(classes) ||
    classes.length > MAX_CLASSES ||
    !classes.every(item => typeof item === 'string' && item.length > 0 && item.length <= 64)
  ) {
    throw new TypeError('classes must list query class names')
  }
  return {
    version: 1,
    host: value.host,
    threshold: positiveInteger(value.threshold, 'threshold'),
    topK: positiveInteger(value.topK, 'topK'),
    floorFeeSats: positiveInteger(value.floorFeeSats, 'floorFeeSats'),
    minPayoutSats: positiveInteger(value.minPayoutSats, 'minPayoutSats'),
    maxQueryTtlMs: positiveInteger(value.maxQueryTtlMs, 'maxQueryTtlMs'),
    classes: [...(classes as string[])]
  }
}
```

Run: `pnpm --filter @bsv/eqc exec vitest run src/protocol/params.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Write the failing handlers test**

`packages/overlays/eqc/src/host/handlers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import {
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery
} from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import { paymentEnvelope, payoutLockingScript, type PaymentEnvelope } from '../protocol/payment.js'
import { computeQueryId, type EconomicQuery } from '../protocol/query.js'
import {
  createEconomicQueryHost,
  type EconomicQueryHost,
  type EconomicQueryHostOptions,
  type HostRequest
} from './handlers.js'
import { InMemoryPendingStore } from './pendingStore.js'
import { bytesProvider } from './providers.js'

const NOW = Date.parse('2026-09-18T19:00:00.000Z')
const PAYLOAD = [1, 2, 3, 4]

interface Recorded {
  statusCode: number
  body: any
  headers: Record<string, string>
  status: (code: number) => Recorded
  json: (body: unknown) => Recorded
  set: (name: string, value: string) => Recorded
}

function recorder(): Recorded {
  const response: Recorded = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code) {
      response.statusCode = code
      return response
    },
    json(body) {
      response.body = body
      return response
    },
    set(name, value) {
      response.headers[name.toLowerCase()] = value
      return response
    }
  }
  return response
}

function request(identityKey: string | undefined, body?: unknown, headers = {}): HostRequest {
  return { body, headers, auth: identityKey === undefined ? undefined : { identityKey } }
}

function makeHost(overrides: Partial<EconomicQueryHostOptions> = {}): {
  host: EconomicQueryHost
  wallet: HostWallet
} {
  const wallet = new HostWallet()
  const host = createEconomicQueryHost({
    wallet,
    providers: [bytesProvider('relay-lookup', async () => PAYLOAD)],
    now: () => NOW,
    logger: { error: () => undefined },
    ...overrides
  })
  return { host, wallet }
}

function makeQuery(client: string, overrides: Partial<EconomicQuery> = {}): EconomicQuery {
  return {
    type: 'relay-lookup',
    client,
    params: { key: 'k' },
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: new Date(NOW + 30_000).toISOString(),
    nonce: '11'.repeat(32),
    ...overrides
  }
}

async function attest(host: EconomicQueryHost, query: EconomicQuery): Promise<Recorded> {
  const response = recorder()
  await host.query(request(query.client, query), response)
  return response
}

async function pay(
  payer: PayerWallet,
  queryId: string,
  ranking: string[],
  satoshis: number[],
  rank: number
): Promise<PaymentEnvelope> {
  const outputs = await Promise.all(
    ranking.map(async (hostKey, index) => ({
      lockingScript: await payoutLockingScript(payer, hostKey, queryId, index + 1, false),
      satoshis: satoshis[index],
      outputDescription: `Rank ${index + 1} payout`
    }))
  )
  const action = await payer.createAction({ description: 'BRC-178 query payout', outputs })
  if (action.tx === undefined) throw new Error('No transaction')
  return paymentEnvelope(queryId, rank, action.tx)
}

describe('params', () => {
  it('advertises the market without authentication', async () => {
    const { host, wallet } = makeHost()
    const response = recorder()
    await host.params(request(undefined), response)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      version: 1,
      host: wallet.identityKey,
      threshold: 3,
      topK: 5,
      floorFeeSats: 1000,
      minPayoutSats: 1,
      maxQueryTtlMs: 60_000,
      classes: ['relay-lookup']
    })
  })

  it('mounts the three economic routes', () => {
    const { host } = makeHost()
    const routes: string[] = []
    host.mount({
      get: path => routes.push(`GET ${path}`),
      post: path => routes.push(`POST ${path}`)
    })
    expect(routes).toEqual([
      'GET /economic/params',
      'POST /economic/query',
      'POST /economic/collect'
    ])
  })
})

describe('query', () => {
  it('requires BRC-103 authentication', async () => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    for (const identity of [undefined, 'unknown']) {
      const response = recorder()
      await host.query(request(identity, makeQuery(payer.identityKey)), response)
      expect(response.statusCode).toBe(401)
      expect(response.body.code).toBe('ERR_AUTH_REQUIRED')
    }
  })

  it('returns a verifiable attestation quoting the floor', async () => {
    const { host, wallet } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const response = await attest(host, query)
    expect(response.statusCode).toBe(200)
    const attestation = parseAttestation(response.body)
    expect(attestation.payloadSize).toBe(PAYLOAD.length)
    expect(attestation.quotedFeeSats).toBe(1000)
    expect(
      verifyAttestation(attestation, { queryId: computeQueryId(query), host: wallet.identityKey })
    ).toBe('ok')
  })

  it('repeats a pending attestation and rejects a client-supplied queryId field', async () => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const first = await attest(host, query)
    const second = await attest(host, query)
    expect(second.body.signature).toBe(first.body.signature)
    const withId = recorder()
    await host.query(request(payer.identityKey, { ...query, queryId: 'ff'.repeat(32) }), withId)
    expect(withId.statusCode).toBe(400)
  })

  it.each([
    ['an invalid body', (q: EconomicQuery) => ({ ...q, threshold: 0 }), 400, 'ERR_INVALID_QUERY'],
    [
      'another client',
      (q: EconomicQuery) => ({ ...q, client: `03${'cd'.repeat(32)}` }),
      400,
      'ERR_INVALID_QUERY'
    ],
    [
      'a distant expiry',
      (q: EconomicQuery) => ({ ...q, expires: new Date(NOW + 120_000).toISOString() }),
      400,
      'ERR_INVALID_QUERY'
    ],
    [
      'a past expiry',
      (q: EconomicQuery) => ({ ...q, expires: new Date(NOW - 1).toISOString() }),
      410,
      'ERR_QUERY_EXPIRED'
    ],
    [
      'an unknown class',
      (q: EconomicQuery) => ({ ...q, type: 'message-body' }),
      422,
      'ERR_UNSUPPORTED_CLASS'
    ],
    [
      'a strict host set without this host',
      (q: EconomicQuery) => ({ ...q, strictHosts: true, hostSetHint: [`03${'ef'.repeat(32)}`] }),
      400,
      'ERR_INVALID_QUERY'
    ]
  ])('rejects %s', async (_label, mutate, status, code) => {
    const { host } = makeHost()
    const payer = new PayerWallet()
    const response = recorder()
    await host.query(request(payer.identityKey, mutate(makeQuery(payer.identityKey))), response)
    expect(response.statusCode).toBe(status)
    expect(response.body).toMatchObject({ status: 'error', code })
  })

  it('answers 402 when the client budget is below the host floor', async () => {
    const { host } = makeHost({ floorFeeSats: size => 5000 + size })
    const payer = new PayerWallet()
    const response = await attest(host, makeQuery(payer.identityKey))
    expect(response.statusCode).toBe(402)
    expect(response.headers['x-bsv-payment-satoshis-required']).toBe('5004')
    expect(response.headers['x-bsv-payment-version']).toBe('1.0')
  })

  it('bounds payload size and pending queries', async () => {
    const payer = new PayerWallet()
    const small = makeHost({ maxPayloadBytes: 3 })
    expect((await attest(small.host, makeQuery(payer.identityKey))).statusCode).toBe(413)

    const capped = makeHost({
      store: new InMemoryPendingStore({ maxPendingPerClient: 1 }, () => NOW)
    })
    expect((await attest(capped.host, makeQuery(payer.identityKey))).statusCode).toBe(200)
    const second = await attest(
      capped.host,
      makeQuery(payer.identityKey, { nonce: '22'.repeat(32) })
    )
    expect(second.statusCode).toBe(429)
    expect(second.body.code).toBe('ERR_TOO_MANY_PENDING')
  })

  it('passes provider HostErrors through and hides every other failure', async () => {
    const payer = new PayerWallet()
    const forbidden = makeHost({
      providers: [
        bytesProvider('relay-lookup', async () => {
          throw new HostError(403, 'ERR_FORBIDDEN_RECIPIENT', 'Not yours')
        })
      ]
    })
    expect((await attest(forbidden.host, makeQuery(payer.identityKey))).statusCode).toBe(403)

    const broken = makeHost({
      providers: [
        bytesProvider('relay-lookup', async () => {
          throw new Error('database password is hunter2')
        })
      ]
    })
    const response = await attest(broken.host, makeQuery(payer.identityKey))
    expect(response.statusCode).toBe(500)
    expect(response.body).toEqual({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'Internal error'
    })
  })
})

describe('collect', () => {
  async function prepared(): Promise<{
    host: EconomicQueryHost
    wallet: HostWallet
    payer: PayerWallet
    query: EconomicQuery
    queryId: string
    contentHash: string
    ranking: string[]
  }> {
    const { host, wallet } = makeHost()
    const payer = new PayerWallet()
    const query = makeQuery(payer.identityKey)
    const attestation = parseAttestation((await attest(host, query)).body)
    const ranking = [new HostWallet().identityKey, wallet.identityKey, new HostWallet().identityKey]
    return {
      host,
      wallet,
      payer,
      query,
      queryId: attestation.queryId,
      contentHash: attestation.contentHash,
      ranking
    }
  }

  it('delivers the attested bytes once its rank is paid', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const body = { type: 'collect', queryId, contentHash, ranking, payment }
    const response = recorder()
    await host.collect(request(payer.identityKey, body), response)
    expect(response.statusCode).toBe(200)
    const verdict = verifyDelivery(parseDelivery(response.body), {
      queryId,
      host: wallet.identityKey,
      contentHash
    })
    expect(verdict).toEqual({ verdict: 'ok', payload: PAYLOAD, supplement: [] })
    expect(wallet.internalized).toEqual([
      expect.objectContaining({ outputIndex: 1, satoshis: 250 })
    ])

    const replay = recorder()
    await host.collect(request(payer.identityKey, body), replay)
    expect(replay.statusCode).toBe(409)
    expect(replay.body.code).toBe('ERR_QUERY_SETTLED')
  })

  it('refuses a settled query on the query route too', async () => {
    const { host, payer, query, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking, payment }),
      recorder()
    )
    expect((await attest(host, query)).statusCode).toBe(409)
  })

  it('accepts the payment in the x-bsv-payment header', async () => {
    const { host, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const response = recorder()
    await host.collect(
      request(
        payer.identityKey,
        { type: 'collect', queryId, contentHash, ranking },
        { 'x-bsv-payment': JSON.stringify(payment) }
      ),
      response
    )
    expect(response.statusCode).toBe(200)
  })

  it('demands its Fibonacci share and lets the client retry', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const missing = recorder()
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking }),
      missing
    )
    expect(missing.statusCode).toBe(402)
    expect(missing.headers['x-bsv-payment-satoshis-required']).toBe('250')

    const cheap = await pay(payer, queryId, ranking, [500, 100, 250], 2)
    const underpaid = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId,
        contentHash,
        ranking,
        payment: cheap
      }),
      underpaid
    )
    expect(underpaid.statusCode).toBe(402)
    expect(wallet.internalized).toEqual([])

    const fair = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const retried = recorder()
    await host.collect(
      request(payer.identityKey, { type: 'collect', queryId, contentHash, ranking, payment: fair }),
      retried
    )
    expect(retried.statusCode).toBe(200)
  })

  it('rejects bad collects with the documented codes', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const base = { type: 'collect', queryId, contentHash, ranking, payment }
    const cases: Array<[string | undefined, unknown, number, string]> = [
      [undefined, base, 401, 'ERR_AUTH_REQUIRED'],
      [payer.identityKey, { ...base, type: 'other' }, 400, 'ERR_INVALID_COLLECT'],
      [
        payer.identityKey,
        { ...base, ranking: [wallet.identityKey, wallet.identityKey] },
        400,
        'ERR_INVALID_COLLECT'
      ],
      [payer.identityKey, { ...base, queryId: 'ff'.repeat(32) }, 404, 'ERR_QUERY_UNKNOWN'],
      [new PayerWallet().identityKey, base, 404, 'ERR_QUERY_UNKNOWN'],
      [payer.identityKey, { ...base, contentHash: 'ee'.repeat(32) }, 409, 'ERR_HASH_MISMATCH'],
      [payer.identityKey, { ...base, ranking: [ranking[0]] }, 409, 'ERR_NOT_RANKED'],
      [
        payer.identityKey,
        { ...base, payment: paymentEnvelope(queryId, 3, [1, 2, 3]) },
        400,
        'ERR_INVALID_COLLECT'
      ]
    ]
    for (const [identity, body, status, code] of cases) {
      const response = recorder()
      await host.collect(request(identity, body), response)
      expect([response.statusCode, response.body.code]).toEqual([status, code])
    }
    expect(wallet.internalized).toEqual([])
  })

  it('rejects a ranking longer than topK and an expired query', async () => {
    const payer = new PayerWallet()
    let now = NOW
    const { host, wallet } = makeHost({ now: () => now })
    const query = makeQuery(payer.identityKey, { threshold: 1, topK: 1 })
    const attestation = parseAttestation((await attest(host, query)).body)
    const ranking = [wallet.identityKey, new HostWallet().identityKey]
    const tooLong = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId: attestation.queryId,
        contentHash: attestation.contentHash,
        ranking
      }),
      tooLong
    )
    expect([tooLong.statusCode, tooLong.body.code]).toEqual([400, 'ERR_INVALID_COLLECT'])

    now = NOW + 31_000
    const expired = recorder()
    await host.collect(
      request(payer.identityKey, {
        type: 'collect',
        queryId: attestation.queryId,
        contentHash: attestation.contentHash,
        ranking: [wallet.identityKey]
      }),
      expired
    )
    expect([expired.statusCode, expired.body.code]).toEqual([410, 'ERR_QUERY_EXPIRED'])
  })

  it('delivers exactly once under concurrent collects', async () => {
    const { host, wallet, payer, queryId, contentHash, ranking } = await prepared()
    const payment = await pay(payer, queryId, ranking, [500, 250, 250], 2)
    const body = { type: 'collect', queryId, contentHash, ranking, payment }
    const responses = [recorder(), recorder(), recorder()]
    await Promise.all(
      responses.map(async r => await host.collect(request(payer.identityKey, body), r))
    )
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409, 409])
    expect(wallet.internalized).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/handlers.test.ts`
Expected: FAIL with `Cannot find module './handlers.js'`.

- [ ] **Step 5: Implement the handlers**

`packages/overlays/eqc/src/host/handlers.ts`:

```ts
import type { WalletInterface } from '@bsv/sdk'

import { signAttestation, signDelivery } from '../protocol/attestation.js'
import { HostError } from '../protocol/errors.js'
import { computePayouts } from '../protocol/fibonacci.js'
import type { HostParams } from '../protocol/params.js'
import { parsePaymentEnvelope, type PaymentEnvelope } from '../protocol/payment.js'
import { contentHash } from '../protocol/payloads.js'
import {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  isHashHex,
  isPlainObject,
  isPublicKeyHex,
  validateQuery,
  type EconomicQuery
} from '../protocol/query.js'
import { verifyAndInternalizePayment } from './paymentVerifier.js'
import { InMemoryPendingStore, type PendingStore } from './pendingStore.js'
import type { QueryProvider } from './providers.js'

/** The slice of an express `Request` the handlers read. `auth` is set by BRC-103 middleware. */
export interface HostRequest {
  body?: unknown
  headers: Record<string, string | string[] | undefined>
  auth?: { identityKey?: string }
}

/** The slice of an express `Response` the handlers write. */
export interface HostResponse {
  status(code: number): HostResponse
  json(body: unknown): unknown
  set(name: string, value: string): unknown
}

export type HostHandler = (req: HostRequest, res: HostResponse) => Promise<void>

/** Satisfied by an express `Router` or `Application`. */
export interface RouterLike {
  get(path: string, handler: HostHandler): unknown
  post(path: string, handler: HostHandler): unknown
}

export interface EconomicQueryHostOptions {
  wallet: WalletInterface
  providers: QueryProvider[]
  /** Advertised defaults; the client chooses the values it actually uses. */
  threshold?: number
  topK?: number
  /** Minimum total fee for a query, optionally scaled by canonical payload size. */
  floorFeeSats?: number | ((payloadSize: number) => number)
  /** Smallest output this host serves a collect for, even when its Fibonacci share is smaller. */
  minPayoutSats?: number
  maxQueryTtlMs?: number
  maxPayloadBytes?: number
  store?: PendingStore
  now?: () => number
  originator?: string
  logger?: { error: (...args: unknown[]) => void }
}

export interface EconomicQueryHost {
  params: HostHandler
  query: HostHandler
  collect: HostHandler
  mount: (router: RouterLike) => void
}

interface CollectRequest {
  queryId: string
  contentHash: string
  ranking: string[]
  payment?: PaymentEnvelope
}

const PAYMENT_VERSION = '1.0'
const DEFAULT_MAX_QUERY_TTL_MS = 60_000
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

function paymentRequired(satoshis: number): HostError {
  return new HostError(402, 'ERR_PAYMENT_REQUIRED', `Payment of ${satoshis} satoshis is required`, {
    'x-bsv-payment-version': PAYMENT_VERSION,
    'x-bsv-payment-satoshis-required': String(satoshis)
  })
}

function authenticate(req: HostRequest): string {
  const identityKey = req.auth?.identityKey
  if (!isPublicKeyHex(identityKey)) {
    throw new HostError(401, 'ERR_AUTH_REQUIRED', 'BRC-103 mutual authentication is required')
  }
  return identityKey
}

function parseCollect(req: HostRequest): CollectRequest {
  const invalid = (description: string): HostError =>
    new HostError(400, 'ERR_INVALID_COLLECT', description)
  const body = req.body
  if (!isPlainObject(body) || body.type !== 'collect') {
    throw invalid('Body must be an object of type collect')
  }
  if (!isHashHex(body.queryId) || !isHashHex(body.contentHash)) {
    throw invalid('queryId and contentHash must be 32 bytes of hex')
  }
  const ranking = body.ranking
  if (
    !Array.isArray(ranking) ||
    ranking.length === 0 ||
    ranking.length > MAX_RANKED_HOSTS ||
    !ranking.every(isPublicKeyHex) ||
    new Set(ranking).size !== ranking.length
  ) {
    throw invalid('ranking must list distinct host identity keys')
  }
  let rawPayment: unknown = body.payment
  const header = req.headers['x-bsv-payment']
  if (rawPayment === undefined && typeof header === 'string') {
    try {
      rawPayment = JSON.parse(header)
    } catch {
      throw invalid('x-bsv-payment must be JSON')
    }
  }
  const collect: CollectRequest = {
    queryId: body.queryId,
    contentHash: body.contentHash,
    ranking: [...ranking]
  }
  if (rawPayment !== undefined) {
    try {
      collect.payment = parsePaymentEnvelope(rawPayment)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'Invalid payment')
    }
  }
  return collect
}

export function createEconomicQueryHost(options: EconomicQueryHostOptions): EconomicQueryHost {
  const providers = new Map(options.providers.map(provider => [provider.type, provider]))
  const threshold = options.threshold ?? DEFAULTS.threshold
  const topK = options.topK ?? DEFAULTS.topK
  const minPayoutSats = options.minPayoutSats ?? 1
  const maxQueryTtlMs = options.maxQueryTtlMs ?? DEFAULT_MAX_QUERY_TTL_MS
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  const now = options.now ?? Date.now
  const store = options.store ?? new InMemoryPendingStore({}, now)
  const logger = options.logger ?? console
  const { wallet, originator } = options
  let identity: Promise<string> | undefined

  const hostKey = async (): Promise<string> => {
    identity ??= wallet
      .getPublicKey({ identityKey: true }, originator)
      .then(result => result.publicKey)
    return await identity
  }

  const floorFor = (payloadSize: number): number => {
    const configured = options.floorFeeSats ?? DEFAULTS.floorFeeSats
    const floor = typeof configured === 'function' ? configured(payloadSize) : configured
    if (!Number.isSafeInteger(floor) || floor < 1) {
      throw new Error('floorFeeSats must resolve to a positive safe integer')
    }
    return floor
  }

  const handle =
    (run: (req: HostRequest, res: HostResponse) => Promise<void>): HostHandler =>
    async (req, res) => {
      try {
        await run(req, res)
      } catch (error) {
        if (error instanceof HostError) {
          for (const [name, value] of Object.entries(error.headers)) res.set(name, value)
          res
            .status(error.status)
            .json({ status: 'error', code: error.code, description: error.message })
          return
        }
        logger.error('Economic query handler failed', error)
        res
          .status(500)
          .json({ status: 'error', code: 'ERR_INTERNAL', description: 'Internal error' })
      }
    }

  const readQuery = (req: HostRequest, client: string): EconomicQuery => {
    let query: EconomicQuery
    try {
      query = validateQuery(req.body)
    } catch (error) {
      throw new HostError(
        400,
        'ERR_INVALID_QUERY',
        error instanceof Error ? error.message : 'Invalid query'
      )
    }
    if (query.client !== client) {
      throw new HostError(400, 'ERR_INVALID_QUERY', 'client must be the authenticated identity')
    }
    const expiresAt = Date.parse(query.expires)
    if (expiresAt <= now()) throw new HostError(410, 'ERR_QUERY_EXPIRED', 'The query has expired')
    if (expiresAt > now() + maxQueryTtlMs) {
      throw new HostError(
        400,
        'ERR_INVALID_QUERY',
        `expires may be at most ${maxQueryTtlMs} ms away`
      )
    }
    return query
  }

  const params = handle(async (_req, res) => {
    const body: HostParams = {
      version: 1,
      host: await hostKey(),
      threshold,
      topK,
      floorFeeSats: floorFor(0),
      minPayoutSats,
      maxQueryTtlMs,
      classes: [...providers.keys()]
    }
    res.status(200).json(body)
  })

  const query = handle(async (req, res) => {
    const client = authenticate(req)
    const request = readQuery(req, client)
    const host = await hostKey()
    if (request.strictHosts === true && request.hostSetHint?.includes(host) !== true) {
      throw new HostError(400, 'ERR_INVALID_QUERY', 'This host is not in the strict host set')
    }
    const provider = providers.get(request.type)
    if (provider === undefined) {
      throw new HostError(422, 'ERR_UNSUPPORTED_CLASS', `Query class ${request.type} is not served`)
    }
    const queryId = computeQueryId(request)
    const existing = await store.get(queryId)
    if (existing !== undefined) {
      if (existing.state !== 'pending' || existing.clientIdentityKey !== client) {
        throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
      }
      res.status(200).json(existing.attestation)
      return
    }
    const result = await provider.execute(request, { clientIdentityKey: client })
    if (result.payload.length + (result.supplement?.length ?? 0) > maxPayloadBytes) {
      throw new HostError(413, 'ERR_PAYLOAD_TOO_LARGE', 'The answer exceeds this host limit')
    }
    const floor = floorFor(result.payload.length)
    if (request.maxFeeSats < floor) throw paymentRequired(floor)
    const attestation = await signAttestation(
      wallet,
      {
        queryId,
        host,
        contentHash: contentHash(result.payload),
        payloadSize: result.payload.length,
        quotedFeeSats: floor,
        attestedAt: new Date(now()).toISOString(),
        anchors: result.extensions?.anchors
      },
      originator
    )
    const stored = await store.put({
      queryId,
      query: request,
      clientIdentityKey: client,
      attestation,
      payload: result.payload,
      supplement: result.supplement ?? [],
      expiresAt: Date.parse(request.expires),
      state: 'pending'
    })
    if (stored === 'too-large') {
      throw new HostError(413, 'ERR_PAYLOAD_TOO_LARGE', 'The answer exceeds this host limit')
    }
    if (stored === 'too-many-pending') {
      throw new HostError(429, 'ERR_TOO_MANY_PENDING', 'Too many unsettled queries')
    }
    res.status(200).json(attestation)
  })

  const collect = handle(async (req, res) => {
    const client = authenticate(req)
    const request = parseCollect(req)
    const record = await store.get(request.queryId)
    if (record === undefined || record.clientIdentityKey !== client) {
      throw new HostError(404, 'ERR_QUERY_UNKNOWN', 'No such query for this client')
    }
    if (record.state !== 'pending') {
      throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
    }
    if (record.expiresAt <= now()) {
      throw new HostError(410, 'ERR_QUERY_EXPIRED', 'The query has expired')
    }
    if (request.contentHash !== record.attestation.contentHash) {
      throw new HostError(409, 'ERR_HASH_MISMATCH', 'This host attested a different content hash')
    }
    if (request.ranking.length > record.query.topK) {
      throw new HostError(400, 'ERR_INVALID_COLLECT', 'ranking is longer than the query topK')
    }
    const host = await hostKey()
    const rank = request.ranking.indexOf(host) + 1
    if (rank === 0) throw new HostError(409, 'ERR_NOT_RANKED', 'This host is not in the ranking')

    const share = computePayouts(floorFor(record.payload.length), request.ranking.length)[rank - 1]
    const required = Math.max(minPayoutSats, share)
    if (request.payment === undefined) throw paymentRequired(required)
    if (!(await store.beginSettle(request.queryId))) {
      throw new HostError(409, 'ERR_QUERY_SETTLED', 'This query has already been settled')
    }
    try {
      const payment = await verifyAndInternalizePayment({
        wallet,
        envelope: request.payment,
        queryId: request.queryId,
        rank,
        clientIdentityKey: client,
        requiredSats: required,
        originator
      })
      if (!payment.ok) {
        if (payment.reason === 'malformed') {
          throw new HostError(
            400,
            'ERR_INVALID_COLLECT',
            'Payment is not bound to this query and rank'
          )
        }
        throw paymentRequired(required)
      }
      const delivery = await signDelivery(
        wallet,
        { queryId: request.queryId, host, payload: record.payload, supplement: record.supplement },
        originator
      )
      await store.completeSettle(request.queryId)
      res.status(200).json(delivery)
    } catch (error) {
      await store.abortSettle(request.queryId)
      throw error
    }
  })

  return {
    params,
    query,
    collect,
    mount(router) {
      router.get(ECONOMIC_PATHS.params, params)
      router.post(ECONOMIC_PATHS.query, query)
      router.post(ECONOMIC_PATHS.collect, collect)
    }
  }
}
```

`abortSettle` after `completeSettle` is a no-op because the record is then `settled`, so a failure while writing the response cannot reopen a delivered query.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/host/handlers.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 7: Export, check, and commit**

Append to `packages/overlays/eqc/src/host.ts`:

```ts
export {
  createEconomicQueryHost,
  type EconomicQueryHost,
  type EconomicQueryHostOptions,
  type HostHandler,
  type HostRequest,
  type HostResponse,
  type RouterLike
} from './host/handlers.js'
export { parseHostParams, type HostParams } from './protocol/params.js'
```

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export { parseHostParams, type HostParams } from './protocol/params.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc build && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add economic query host handlers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Client-judged race and BRC-136 consistency

**Files:**

- Create: `packages/overlays/eqc/src/client/race.ts`, `packages/overlays/eqc/src/client/consistency.ts`
- Test: `packages/overlays/eqc/src/client/race.test.ts`, `packages/overlays/eqc/src/client/consistency.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `Attestation`, `TopicAnchor` (Task 4).
- Produces:
  - `type RejectionReason = 'timeout' | 'http' | 'malformed' | 'bad-signature' | 'identity-mismatch' | 'wrong-query' | 'minority-hash' | 'late' | 'collect-failed' | 'hash-mismatch'`
  - `interface Rejection { url: string; host?: string; reason: RejectionReason; detail?: string }`
  - `interface Arrival { url: string; host: string; attestation: Attestation; arrivedAt: number }`
  - `interface RaceTask { url: string; promise: Promise<Arrival | Rejection> }` — the promise must never reject
  - `runRace(tasks: RaceTask[], options: { raceMs: number; hostTimeoutMs: number; topK: number }): Promise<{ arrivals: Arrival[]; rejections: Rejection[]; unfinished: string[] }>`
  - `interface HashGroup { contentHash: string; hosts: string[]; firstArrival: number }`
  - `interface RaceOutcome { thresholdMet: boolean; winningHash?: string; ranked: Arrival[]; minority: Arrival[]; groups: HashGroup[] }`
  - `decideRace(arrivals: Arrival[], params: { threshold: number; topK: number }): RaceOutcome`
  - `type ConsistencyStatus = 'agreed' | 'lagging' | 'diverged' | 'unknown'`
  - `interface TopicConsistency { topic: string; status: ConsistencyStatus; blockHeight?: number; tac?: string; hosts: Array<{ host: string; status: ConsistencyStatus; blockHeight?: number; tac?: string }> }`
  - `assessConsistency(winners: Arrival[]): TopicConsistency[]`
  - `classifyMinority(minority: Arrival, winners: Arrival[]): 'lagging' | 'diverged-answer' | 'minority-hash'`

- [ ] **Step 1: Write the failing race test**

`packages/overlays/eqc/src/client/race.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Attestation } from '../protocol/attestation.js'
import { decideRace, runRace, type Arrival, type RaceTask, type Rejection } from './race.js'

const HASH_A = 'aa'.repeat(32)
const HASH_B = 'bb'.repeat(32)

function arrival(name: string, contentHash: string, arrivedAt: number, attestedAt = ''): Arrival {
  return {
    url: `https://${name}.example`,
    host: name,
    arrivedAt,
    attestation: { contentHash, attestedAt } as Attestation
  }
}

function after<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), milliseconds))
}

function task(value: Arrival | Rejection, milliseconds: number): RaceTask {
  return { url: value.url, promise: after(milliseconds, value) }
}

describe('decideRace', () => {
  it('ranks the winning hash by local arrival and ignores host-claimed time', () => {
    const outcome = decideRace(
      [
        arrival('slow', HASH_A, 30, '1999-01-01T00:00:00.000Z'),
        arrival('fast', HASH_A, 10, '2099-01-01T00:00:00.000Z'),
        arrival('mid', HASH_A, 20),
        arrival('stale', HASH_B, 5)
      ],
      { threshold: 3, topK: 5 }
    )
    expect(outcome.thresholdMet).toBe(true)
    expect(outcome.winningHash).toBe(HASH_A)
    expect(outcome.ranked.map(entry => entry.host)).toEqual(['fast', 'mid', 'slow'])
    expect(outcome.minority.map(entry => entry.host)).toEqual(['stale'])
  })

  it('keeps only the fastest topK hosts', () => {
    const arrivals = [1, 2, 3, 4].map(n => arrival(`h${n}`, HASH_A, n))
    const outcome = decideRace(arrivals, { threshold: 1, topK: 2 })
    expect(outcome.ranked.map(entry => entry.host)).toEqual(['h1', 'h2'])
  })

  it('breaks a tie toward the hash seen first', () => {
    const outcome = decideRace(
      [
        arrival('a1', HASH_A, 20),
        arrival('b1', HASH_B, 10),
        arrival('a2', HASH_A, 30),
        arrival('b2', HASH_B, 40)
      ],
      { threshold: 2, topK: 5 }
    )
    expect(outcome.winningHash).toBe(HASH_B)
  })

  it('reports an unmet threshold with every group', () => {
    const outcome = decideRace([arrival('only', HASH_A, 1), arrival('other', HASH_B, 2)], {
      threshold: 3,
      topK: 5
    })
    expect(outcome.thresholdMet).toBe(false)
    expect(outcome.ranked).toEqual([])
    expect(outcome.groups).toEqual([
      { contentHash: HASH_A, hosts: ['only'], firstArrival: 1 },
      { contentHash: HASH_B, hosts: ['other'], firstArrival: 2 }
    ])
  })

  it('handles no arrivals', () => {
    expect(decideRace([], { threshold: 1, topK: 1 })).toEqual({
      thresholdMet: false,
      ranked: [],
      minority: [],
      groups: []
    })
  })
})

describe('runRace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const options = { raceMs: 400, hostTimeoutMs: 5000, topK: 5 }

  it('closes the window raceMs after the first valid attestation', async () => {
    const race = runRace(
      [
        task(arrival('first', HASH_A, 10), 10),
        task(arrival('second', HASH_A, 100), 100),
        task(arrival('late', HASH_A, 1000), 1000)
      ],
      options
    )
    await vi.advanceTimersByTimeAsync(410)
    const result = await race
    expect(result.arrivals.map(entry => entry.host)).toEqual(['first', 'second'])
    expect(result.unfinished).toEqual(['https://late.example'])
  })

  it('ends as soon as every host has answered or failed', async () => {
    const failed: Rejection = { url: 'https://down.example', reason: 'http' }
    const race = runRace([task(arrival('first', HASH_A, 10), 10), task(failed, 20)], options)
    await vi.advanceTimersByTimeAsync(20)
    const result = await race
    expect(result.arrivals).toHaveLength(1)
    expect(result.rejections).toEqual([failed])
    expect(result.unfinished).toEqual([])
  })

  it('ends early once topK hosts share one hash', async () => {
    const race = runRace(
      [
        task(arrival('h1', HASH_A, 10), 10),
        task(arrival('h2', HASH_A, 20), 20),
        task(arrival('h3', HASH_A, 300), 300)
      ],
      { ...options, topK: 2 }
    )
    await vi.advanceTimersByTimeAsync(20)
    expect((await race).unfinished).toEqual(['https://h3.example'])
  })

  it('gives up at hostTimeoutMs when nothing valid arrives', async () => {
    const race = runRace([task(arrival('never', HASH_A, 9000), 9000)], options)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await race).toEqual({
      arrivals: [],
      rejections: [],
      unfinished: ['https://never.example']
    })
  })

  it('counts one identity once, however many domains it answers from', async () => {
    const twin: Arrival = { ...arrival('first', HASH_A, 20), url: 'https://twin.example' }
    const race = runRace([task(arrival('first', HASH_A, 10), 10), task(twin, 20)], options)
    await vi.advanceTimersByTimeAsync(20)
    const result = await race
    expect(result.arrivals).toHaveLength(1)
    expect(result.rejections).toEqual([
      {
        url: 'https://twin.example',
        host: 'first',
        reason: 'malformed',
        detail: 'duplicate host identity'
      }
    ])
  })

  it('returns immediately for an empty host list', async () => {
    expect(await runRace([], options)).toEqual({ arrivals: [], rejections: [], unfinished: [] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/race.test.ts`
Expected: FAIL with `Cannot find module './race.js'`.

- [ ] **Step 3: Implement the race**

`packages/overlays/eqc/src/client/race.ts`:

```ts
import type { Attestation } from '../protocol/attestation.js'

export type RejectionReason =
  | 'timeout'
  | 'http'
  | 'malformed'
  | 'bad-signature'
  | 'identity-mismatch'
  | 'wrong-query'
  | 'minority-hash'
  | 'late'
  | 'collect-failed'
  | 'hash-mismatch'

export interface Rejection {
  url: string
  host?: string
  reason: RejectionReason
  detail?: string
}

/** A verified attestation and the local time it arrived. `host` is the identity key. */
export interface Arrival {
  url: string
  host: string
  attestation: Attestation
  arrivedAt: number
}

/** `promise` must resolve to a `Rejection` instead of rejecting. */
export interface RaceTask {
  url: string
  promise: Promise<Arrival | Rejection>
}

export interface RaceResult {
  arrivals: Arrival[]
  rejections: Rejection[]
  unfinished: string[]
}

export interface HashGroup {
  contentHash: string
  hosts: string[]
  firstArrival: number
}

export interface RaceOutcome {
  thresholdMet: boolean
  winningHash?: string
  ranked: Arrival[]
  minority: Arrival[]
  groups: HashGroup[]
}

function isArrival(value: Arrival | Rejection): value is Arrival {
  return 'attestation' in value
}

function largestGroup(arrivals: Arrival[]): number {
  const counts = new Map<string, number>()
  let largest = 0
  for (const arrival of arrivals) {
    const count = (counts.get(arrival.attestation.contentHash) ?? 0) + 1
    counts.set(arrival.attestation.contentHash, count)
    largest = Math.max(largest, count)
  }
  return largest
}

/**
 * Collects attestations until the race window closes: `raceMs` after the first valid arrival,
 * or sooner when every host has settled or `topK` hosts already share one hash. With no valid
 * arrival the race ends at `hostTimeoutMs`.
 */
export async function runRace(
  tasks: RaceTask[],
  options: { raceMs: number; hostTimeoutMs: number; topK: number }
): Promise<RaceResult> {
  const arrivals: Arrival[] = []
  const rejections: Rejection[] = []
  const settled = new Set<string>()
  return await new Promise(resolve => {
    let finished = false
    let windowTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(overallTimer)
      if (windowTimer !== undefined) clearTimeout(windowTimer)
      resolve({
        arrivals: [...arrivals],
        rejections: [...rejections],
        unfinished: tasks.map(entry => entry.url).filter(url => !settled.has(url))
      })
    }
    const overallTimer = setTimeout(finish, options.hostTimeoutMs)
    if (tasks.length === 0) {
      finish()
      return
    }
    for (const entry of tasks) {
      void entry.promise.then(result => {
        if (finished) return
        settled.add(entry.url)
        if (!isArrival(result)) {
          rejections.push(result)
        } else if (arrivals.some(existing => existing.host === result.host)) {
          rejections.push({
            url: result.url,
            host: result.host,
            reason: 'malformed',
            detail: 'duplicate host identity'
          })
        } else {
          arrivals.push(result)
          if (arrivals.length === 1) windowTimer = setTimeout(finish, options.raceMs)
          if (largestGroup(arrivals) >= options.topK) finish()
        }
        if (settled.size === tasks.length) finish()
      })
    }
  })
}

/**
 * Picks the hash attested by the most distinct hosts (ties go to the hash seen first) and ranks
 * its hosts by client-measured arrival. Host-claimed `attestedAt` is never read.
 */
export function decideRace(
  arrivals: Arrival[],
  params: { threshold: number; topK: number }
): RaceOutcome {
  const byHash = new Map<string, Arrival[]>()
  for (const arrival of arrivals) {
    const group = byHash.get(arrival.attestation.contentHash) ?? []
    group.push(arrival)
    byHash.set(arrival.attestation.contentHash, group)
  }
  const sortedGroups = [...byHash.entries()].map(([contentHash, members]) => {
    const ordered = [...members].sort((left, right) => left.arrivedAt - right.arrivedAt)
    return { contentHash, ordered, firstArrival: ordered[0].arrivedAt }
  })
  sortedGroups.sort(
    (left, right) =>
      right.ordered.length - left.ordered.length || left.firstArrival - right.firstArrival
  )
  const groups: HashGroup[] = sortedGroups.map(group => ({
    contentHash: group.contentHash,
    hosts: group.ordered.map(member => member.host),
    firstArrival: group.firstArrival
  }))
  const winner = sortedGroups[0]
  if (winner === undefined || winner.ordered.length < params.threshold) {
    return { thresholdMet: false, ranked: [], minority: [], groups }
  }
  return {
    thresholdMet: true,
    winningHash: winner.contentHash,
    ranked: winner.ordered.slice(0, params.topK),
    minority: sortedGroups.slice(1).flatMap(group => group.ordered),
    groups
  }
}
```

- [ ] **Step 4: Run the race test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/race.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing consistency test**

`packages/overlays/eqc/src/client/consistency.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { Attestation, TopicAnchor } from '../protocol/attestation.js'
import { assessConsistency, classifyMinority } from './consistency.js'
import type { Arrival } from './race.js'

const TAC_1 = '11'.repeat(32)
const TAC_2 = '22'.repeat(32)

function host(name: string, anchors?: TopicAnchor[]): Arrival {
  return {
    url: `https://${name}.example`,
    host: name,
    arrivedAt: 0,
    attestation: { anchors } as Attestation
  }
}

const tip = (blockHeight: number, tac: string): TopicAnchor[] => [
  { topic: 'tm_example', blockHeight, tac }
]

describe('assessConsistency', () => {
  it('reports agreement when every winner shares height and TAC', () => {
    expect(assessConsistency([host('a', tip(900, TAC_1)), host('b', tip(900, TAC_1))])).toEqual([
      {
        topic: 'tm_example',
        status: 'agreed',
        blockHeight: 900,
        tac: TAC_1,
        hosts: [
          { host: 'a', status: 'agreed', blockHeight: 900, tac: TAC_1 },
          { host: 'b', status: 'agreed', blockHeight: 900, tac: TAC_1 }
        ]
      }
    ])
  })

  it('marks a lower tip as lagging and a host without anchors as unknown', () => {
    const [topic] = assessConsistency([
      host('a', tip(900, TAC_1)),
      host('b', tip(899, TAC_2)),
      host('c')
    ])
    expect(topic.status).toBe('lagging')
    expect(topic.hosts.map(entry => entry.status)).toEqual(['agreed', 'lagging', 'unknown'])
  })

  it('marks different TACs at the same height as diverged', () => {
    const [topic] = assessConsistency([host('a', tip(900, TAC_1)), host('b', tip(900, TAC_2))])
    expect(topic.status).toBe('diverged')
    expect(topic.tac).toBeUndefined()
  })

  it('returns nothing when no winner sent anchors', () => {
    expect(assessConsistency([host('a'), host('b')])).toEqual([])
  })
})

describe('classifyMinority', () => {
  const winners = [host('a', tip(900, TAC_1)), host('b', tip(900, TAC_1))]

  it('excuses a host that is behind', () => {
    expect(classifyMinority(host('m', tip(899, TAC_2)), winners)).toBe('lagging')
  })

  it('flags a host with matching admission state but a different answer', () => {
    expect(classifyMinority(host('m', tip(900, TAC_1)), winners)).toBe('diverged-answer')
  })

  it('stays neutral without comparable anchors', () => {
    expect(classifyMinority(host('m'), winners)).toBe('minority-hash')
    expect(classifyMinority(host('m', tip(900, TAC_2)), winners)).toBe('minority-hash')
  })
})
```

- [ ] **Step 6: Run it to verify it fails, then implement**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/consistency.test.ts`
Expected: FAIL with `Cannot find module './consistency.js'`.

`packages/overlays/eqc/src/client/consistency.ts`:

```ts
import type { Arrival } from './race.js'

export type ConsistencyStatus = 'agreed' | 'lagging' | 'diverged' | 'unknown'

export interface TopicConsistency {
  topic: string
  status: ConsistencyStatus
  /** Highest tip any winner reported. */
  blockHeight?: number
  /** The TAC at that height, when every host at that height agrees. */
  tac?: string
  hosts: Array<{ host: string; status: ConsistencyStatus; blockHeight?: number; tac?: string }>
}

interface Reference {
  blockHeight: number
  tac?: string
}

function referenceFor(topic: string, winners: Arrival[]): Reference | undefined {
  let blockHeight = Number.NEGATIVE_INFINITY
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) {
      if (anchor.topic === topic) blockHeight = Math.max(blockHeight, anchor.blockHeight)
    }
  }
  if (blockHeight === Number.NEGATIVE_INFINITY) return undefined
  const tacs = new Set<string>()
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) {
      if (anchor.topic === topic && anchor.blockHeight === blockHeight) tacs.add(anchor.tac)
    }
  }
  return tacs.size === 1 ? { blockHeight, tac: [...tacs][0] } : { blockHeight }
}

/**
 * Compares BRC-136 topic anchors across the winning hosts. Agreement means `t` independent hosts
 * share the answer and the topic's whole confirmed history through that height. A matching TAC
 * proves agreement on admission only; bans and janitor removals are node-local.
 */
export function assessConsistency(winners: Arrival[]): TopicConsistency[] {
  const topics = new Set<string>()
  for (const winner of winners) {
    for (const anchor of winner.attestation.anchors ?? []) topics.add(anchor.topic)
  }
  return [...topics].sort().map(topic => {
    const reference = referenceFor(topic, winners)
    const hosts = winners.map(winner => {
      const anchor = winner.attestation.anchors?.find(entry => entry.topic === topic)
      if (anchor === undefined || reference === undefined) {
        return { host: winner.host, status: 'unknown' as const }
      }
      let status: ConsistencyStatus = 'agreed'
      if (anchor.blockHeight < reference.blockHeight) status = 'lagging'
      else if (reference.tac === undefined) status = 'diverged'
      return { host: winner.host, status, blockHeight: anchor.blockHeight, tac: anchor.tac }
    })
    let status: ConsistencyStatus = 'agreed'
    if (hosts.some(entry => entry.status === 'diverged')) status = 'diverged'
    else if (hosts.some(entry => entry.status === 'lagging')) status = 'lagging'
    const result: TopicConsistency = { topic, status, hosts }
    if (reference !== undefined) {
      result.blockHeight = reference.blockHeight
      if (reference.tac !== undefined) result.tac = reference.tac
    }
    return result
  })
}

/**
 * Explains a minority answer for reputation. A host that is behind is excused; a host whose
 * admission state matches the winners yet answered differently is not.
 */
export function classifyMinority(
  minority: Arrival,
  winners: Arrival[]
): 'lagging' | 'diverged-answer' | 'minority-hash' {
  const anchors = minority.attestation.anchors ?? []
  if (anchors.length === 0) return 'minority-hash'
  let matched = 0
  for (const anchor of anchors) {
    const reference = referenceFor(anchor.topic, winners)
    if (reference === undefined) continue
    if (anchor.blockHeight < reference.blockHeight) return 'lagging'
    if (anchor.blockHeight === reference.blockHeight && anchor.tac === reference.tac) matched++
    else return 'minority-hash'
  }
  return matched > 0 ? 'diverged-answer' : 'minority-hash'
}
```

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/consistency.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  assessConsistency,
  classifyMinority,
  type ConsistencyStatus,
  type TopicConsistency
} from './client/consistency.js'
export {
  decideRace,
  runRace,
  type Arrival,
  type HashGroup,
  type RaceOutcome,
  type RaceResult,
  type RaceTask,
  type Rejection,
  type RejectionReason
} from './client/race.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add client-judged race and BRC-136 consistency assessment" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Host reputation

**Files:**

- Create: `packages/overlays/eqc/src/client/reputation.ts`
- Test: `packages/overlays/eqc/src/client/reputation.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `RejectionReason` (Task 10).
- Produces:
  - `type ReputationEvent = 'success' | 'lagging' | 'diverged-answer' | RejectionReason`
  - `interface ReputationStore { record(url: string, event: ReputationEvent, now: number): void; isExcluded(url: string, now: number): boolean; score(url: string): number }`
  - `class InMemoryReputationStore implements ReputationStore { constructor(cooldownMs?: number) }` — default cooldown 600000

Hard events (`hash-mismatch`, `bad-signature`, `identity-mismatch`, `diverged-answer`) exclude a host for the cooldown. Every other failure lowers its score by one. `success` raises it by one.

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/client/reputation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { InMemoryReputationStore } from './reputation.js'

const url = 'https://host.example'

describe('InMemoryReputationStore', () => {
  it('starts neutral', () => {
    const store = new InMemoryReputationStore()
    expect(store.score(url)).toBe(0)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it('scores success up and soft failures down without excluding', () => {
    const store = new InMemoryReputationStore()
    store.record(url, 'success', 0)
    store.record(url, 'success', 0)
    store.record(url, 'timeout', 0)
    store.record(url, 'late', 0)
    store.record(url, 'lagging', 0)
    expect(store.score(url)).toBe(-1)
    expect(store.isExcluded(url, 0)).toBe(false)
  })

  it.each(['hash-mismatch', 'bad-signature', 'identity-mismatch', 'diverged-answer'] as const)(
    'excludes a host for the cooldown after %s',
    event => {
      const store = new InMemoryReputationStore(1000)
      store.record(url, event, 500)
      expect(store.isExcluded(url, 1499)).toBe(true)
      expect(store.isExcluded(url, 1500)).toBe(false)
      expect(store.score(url)).toBeLessThan(0)
    }
  )

  it('defaults to a ten minute cooldown', () => {
    const store = new InMemoryReputationStore()
    store.record(url, 'hash-mismatch', 0)
    expect(store.isExcluded(url, 599_999)).toBe(true)
    expect(store.isExcluded(url, 600_000)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/reputation.test.ts`
Expected: FAIL with `Cannot find module './reputation.js'`.

`packages/overlays/eqc/src/client/reputation.ts`:

```ts
import type { RejectionReason } from './race.js'

export type ReputationEvent = 'success' | 'lagging' | 'diverged-answer' | RejectionReason

/** Local, per-client reputation keyed by host URL. Never fed by another party's claims. */
export interface ReputationStore {
  record: (url: string, event: ReputationEvent, now: number) => void
  isExcluded: (url: string, now: number) => boolean
  score: (url: string) => number
}

const HARD_EVENTS: ReadonlySet<ReputationEvent> = new Set([
  'hash-mismatch',
  'bad-signature',
  'identity-mismatch',
  'diverged-answer'
])
const HARD_PENALTY = 10
const DEFAULT_COOLDOWN_MS = 600_000

export class InMemoryReputationStore implements ReputationStore {
  private readonly scores = new Map<string, number>()
  private readonly excludedUntil = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs
  }

  record(url: string, event: ReputationEvent, now: number): void {
    const current = this.scores.get(url) ?? 0
    if (event === 'success') {
      this.scores.set(url, current + 1)
    } else if (HARD_EVENTS.has(event)) {
      this.scores.set(url, current - HARD_PENALTY)
      this.excludedUntil.set(url, now + this.cooldownMs)
    } else {
      this.scores.set(url, current - 1)
    }
  }

  isExcluded(url: string, now: number): boolean {
    return now < (this.excludedUntil.get(url) ?? 0)
  }

  score(url: string): number {
    return this.scores.get(url) ?? 0
  }
}
```

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/reputation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 3: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  InMemoryReputationStore,
  type ReputationEvent,
  type ReputationStore
} from './client/reputation.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add local host reputation with cooldown" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Host discovery from SLAP trackers

**Files:**

- Create: `packages/overlays/eqc/src/client/discovery.ts`
- Test: `packages/overlays/eqc/src/client/discovery.test.ts`
- Modify: `packages/overlays/eqc/test/support/transactions.ts`, `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `isPublicKeyHex`, `DEFAULTS` (Task 1).
- Produces:
  - `interface DiscoveredHost { url: string; identityKey?: string }`
  - `interface LookupResolverLike { query(question: LookupQuestion, timeout?: number): Promise<LookupAnswer> }` — satisfied by the SDK `LookupResolver`
  - `interface DiscoveryOptions { networkPreset?: LookupNetworkPreset; slapTrackers?: string[]; hostOverrides?: Record<string, string[]>; additionalHosts?: Record<string, string[]>; resolver?: LookupResolverLike; hostsTtlMs?: number; now?: () => number }`
  - `type DiscoveryTarget = { kind: 'overlay-lookup'; service: string } | { kind: 'message-list'; recipient: string } | { kind: 'static'; key: string }`
  - `discoveryTarget(type: string, params: Record<string, unknown>, client: string): DiscoveryTarget` (throws `TypeError`)
  - `class HostDiscovery { constructor(options?: DiscoveryOptions); hostsFor(target: DiscoveryTarget): Promise<DiscoveredHost[]> }`
  - In `test/support/transactions.ts`: `slapTokenOutput(wallet: WalletInterface, domain: string, service: string, protocol?: 'SHIP' | 'SLAP')` and `messageBoxTokenOutput(wallet: WalletInterface, recipient: string, host: string)`, each returning `Promise<{ beef: number[]; outputIndex: number }>`

Discovery is free: it runs over the existing BRC-24 `/lookup` route through a `LookupResolver`, makes no wallet call, and its cost is covered by the fee of the query that follows. The market key for overrides is the service name for `overlay-lookup` and the class name otherwise.

- [ ] **Step 1: Add token builders to the test support file**

Replace `packages/overlays/eqc/test/support/transactions.ts` with:

```ts
import {
  Beef,
  OverlayAdminTokenTemplate,
  P2PKH,
  PrivateKey,
  PushDrop,
  Script,
  Transaction,
  Utils,
  type LockingScript,
  type WalletInterface
} from '@bsv/sdk'

function wrap(lockingScript: LockingScript, satoshis: number): { beef: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({ lockingScript, satoshis })
  const txid = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return { beef: beef.toBinary(), txid }
}

/** A one-output transaction wrapped in BEEF, for building lookup answers in tests. */
export function sampleBeef(satoshis: number): { beef: number[]; txid: string } {
  return wrap(new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()), satoshis)
}

/** A real SHIP/SLAP advertisement token, as a SLAP tracker would return it. */
export async function slapTokenOutput(
  wallet: WalletInterface,
  domain: string,
  service: string,
  protocol: 'SHIP' | 'SLAP' = 'SLAP'
): Promise<{ beef: number[]; outputIndex: number }> {
  const script = await new OverlayAdminTokenTemplate(wallet).lock(protocol, domain, service)
  return { beef: wrap(script, 1).beef, outputIndex: 0 }
}

/** A real `tm_messagebox` advertisement: PushDrop fields `[identityKey, host]`. */
export async function messageBoxTokenOutput(
  wallet: WalletInterface,
  recipient: string,
  host: string
): Promise<{ beef: number[]; outputIndex: number }> {
  const script = await new PushDrop(wallet).lock(
    [Utils.toArray(recipient, 'hex'), Utils.toArray(host, 'utf8')],
    [1, 'messagebox advertisement'],
    '1',
    'anyone',
    true
  )
  return { beef: wrap(script, 1).beef, outputIndex: 0 }
}
```

- [ ] **Step 2: Write the failing test**

`packages/overlays/eqc/src/client/discovery.test.ts`:

```ts
import { CompletedProtoWallet, PrivateKey, type LookupAnswer, type LookupQuestion } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { messageBoxTokenOutput, slapTokenOutput } from '../../test/support/transactions.js'
import { HostDiscovery, discoveryTarget, type LookupResolverLike } from './discovery.js'

const hostKey = PrivateKey.fromRandom()
const hostWallet = new CompletedProtoWallet(hostKey)
const hostIdentity = hostKey.toPublicKey().toString()

function resolverFor(outputs: LookupAnswer['outputs']): LookupResolverLike & {
  questions: LookupQuestion[]
} {
  const questions: LookupQuestion[] = []
  return {
    questions,
    async query(question) {
      questions.push(question)
      return { type: 'output-list', outputs }
    }
  }
}

describe('discoveryTarget', () => {
  const client = `02${'ab'.repeat(32)}`

  it('maps each query class to its discovery path', () => {
    expect(discoveryTarget('overlay-lookup', { service: 'ls_x' }, client)).toEqual({
      kind: 'overlay-lookup',
      service: 'ls_x'
    })
    expect(discoveryTarget('message-list', { messageBox: 'inbox' }, client)).toEqual({
      kind: 'message-list',
      recipient: client
    })
    expect(discoveryTarget('relay-lookup', {}, client)).toEqual({
      kind: 'static',
      key: 'relay-lookup'
    })
  })

  it('requires a service name for overlay lookups', () => {
    expect(() => discoveryTarget('overlay-lookup', {}, client)).toThrow(TypeError)
  })
})

describe('HostDiscovery', () => {
  it('asks ls_slap for the service and keeps each SLAP identity key', async () => {
    const resolver = resolverFor([
      await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x'),
      await slapTokenOutput(hostWallet, 'https://other.example', 'ls_other'),
      await slapTokenOutput(hostWallet, 'https://ship.example', 'ls_x', 'SHIP'),
      { beef: [1, 2, 3], outputIndex: 0 }
    ])
    const discovery = new HostDiscovery({ resolver })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://a.example', identityKey: hostIdentity }
    ])
    expect(resolver.questions).toEqual([{ service: 'ls_slap', query: { service: 'ls_x' } }])
  })

  it('caches discovery for hostsTtlMs', async () => {
    let now = 0
    const resolver = resolverFor([await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x')])
    const discovery = new HostDiscovery({ resolver, hostsTtlMs: 1000, now: () => now })
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    now = 999
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    expect(resolver.questions).toHaveLength(1)
    now = 1000
    await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })
    expect(resolver.questions).toHaveLength(2)
  })

  it('lets hostOverrides replace discovery and additionalHosts extend it', async () => {
    const resolver = resolverFor([await slapTokenOutput(hostWallet, 'https://a.example', 'ls_x')])
    const overridden = new HostDiscovery({
      resolver,
      hostOverrides: { ls_x: ['https://only.example/'] }
    })
    expect(await overridden.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://only.example' }
    ])
    expect(resolver.questions).toEqual([])

    const extended = new HostDiscovery({
      resolver,
      additionalHosts: { ls_x: ['https://extra.example', 'https://a.example'] }
    })
    expect(await extended.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://a.example', identityKey: hostIdentity },
      { url: 'https://extra.example' }
    ])
  })

  it('accepts plain http only under the local preset', async () => {
    const outputs = [
      await slapTokenOutput(hostWallet, 'http://127.0.0.1:4001', 'ls_x'),
      await slapTokenOutput(hostWallet, 'ftp://files.example', 'ls_x'),
      await slapTokenOutput(hostWallet, 'not a url', 'ls_x')
    ]
    const mainnet = new HostDiscovery({ resolver: resolverFor(outputs) })
    expect(await mainnet.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([])
    const local = new HostDiscovery({ resolver: resolverFor(outputs), networkPreset: 'local' })
    expect(await local.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'http://127.0.0.1:4001', identityKey: hostIdentity }
    ])
  })

  it('treats the SLAP trackers as the hosts of ls_slap itself', async () => {
    const resolver = resolverFor([])
    const discovery = new HostDiscovery({ resolver, slapTrackers: ['https://tracker.example'] })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_slap' })).toEqual([
      { url: 'https://tracker.example' }
    ])
    expect(resolver.questions).toEqual([])
  })

  it('resolves message box hosts through ls_messagebox', async () => {
    const recipient = `02${'ab'.repeat(32)}`
    const resolver = resolverFor([
      await messageBoxTokenOutput(hostWallet, recipient, 'https://box.example')
    ])
    const discovery = new HostDiscovery({ resolver })
    expect(await discovery.hostsFor({ kind: 'message-list', recipient })).toEqual([
      { url: 'https://box.example' }
    ])
    expect(resolver.questions).toEqual([
      { service: 'ls_messagebox', query: { identityKey: recipient } }
    ])
  })

  it('uses only configured hosts for classes without a discovery path', async () => {
    const discovery = new HostDiscovery({
      resolver: resolverFor([]),
      hostOverrides: { 'relay-lookup': ['https://relay.example'] }
    })
    expect(await discovery.hostsFor({ kind: 'static', key: 'relay-lookup' })).toEqual([
      { url: 'https://relay.example' }
    ])
    expect(await discovery.hostsFor({ kind: 'static', key: 'message-body' })).toEqual([])
  })

  it('survives a failing resolver', async () => {
    const discovery = new HostDiscovery({
      resolver: {
        async query() {
          throw new Error('trackers unreachable')
        }
      },
      additionalHosts: { ls_x: ['https://extra.example'] }
    })
    expect(await discovery.hostsFor({ kind: 'overlay-lookup', service: 'ls_x' })).toEqual([
      { url: 'https://extra.example' }
    ])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/discovery.test.ts`
Expected: FAIL with `Cannot find module './discovery.js'`.

- [ ] **Step 4: Implement discovery**

`packages/overlays/eqc/src/client/discovery.ts`:

```ts
import {
  DEFAULT_SLAP_TRACKERS,
  DEFAULT_TESTNET_SLAP_TRACKERS,
  DEFAULT_TTN_SLAP_TRACKERS,
  LookupResolver,
  OverlayAdminTokenTemplate,
  PushDrop,
  Transaction,
  Utils,
  type LookupAnswer,
  type LookupNetworkPreset,
  type LookupQuestion
} from '@bsv/sdk'

import { DEFAULTS, isPublicKeyHex } from '../protocol/query.js'

export interface DiscoveredHost {
  url: string
  /** The key the host advertised on-chain. It must match the BRC-103 session key. */
  identityKey?: string
}

/** Satisfied by the SDK `LookupResolver`; injectable for tests. */
export interface LookupResolverLike {
  query: (question: LookupQuestion, timeout?: number) => Promise<LookupAnswer>
}

/** Network options carry the same names and meaning as `LookupResolverConfig`. */
export interface DiscoveryOptions {
  networkPreset?: LookupNetworkPreset
  slapTrackers?: string[]
  /** Per market key, hosts used in place of discovery. */
  hostOverrides?: Record<string, string[]>
  /** Per market key, hosts used in addition to discovery. */
  additionalHosts?: Record<string, string[]>
  resolver?: LookupResolverLike
  hostsTtlMs?: number
  now?: () => number
}

export type DiscoveryTarget =
  | { kind: 'overlay-lookup'; service: string }
  | { kind: 'message-list'; recipient: string }
  | { kind: 'static'; key: string }

/** The market key is the lookup service name for `overlay-lookup`, else the class name. */
export function discoveryTarget(
  type: string,
  params: Record<string, unknown>,
  client: string
): DiscoveryTarget {
  if (type === 'overlay-lookup') {
    if (typeof params.service !== 'string' || params.service.length === 0) {
      throw new TypeError('overlay-lookup needs params.service')
    }
    return { kind: 'overlay-lookup', service: params.service }
  }
  if (type === 'message-list') {
    return {
      kind: 'message-list',
      recipient: typeof params.recipient === 'string' ? params.recipient : client
    }
  }
  return { kind: 'static', key: type }
}

function marketKey(target: DiscoveryTarget): string {
  if (target.kind === 'overlay-lookup') return target.service
  return target.kind === 'message-list' ? 'message-list' : target.key
}

function defaultTrackers(preset: LookupNetworkPreset): string[] {
  if (preset === 'local') return ['http://localhost:8080']
  if (preset === 'testnet') return DEFAULT_TESTNET_SLAP_TRACKERS
  if (preset === 'teratestnet') return DEFAULT_TTN_SLAP_TRACKERS
  return DEFAULT_SLAP_TRACKERS
}

/**
 * Bootstraps from SLAP trackers, as `LookupResolver` does. Discovery runs on the free BRC-24
 * `/lookup` route and makes no wallet call; the fee of the query that follows covers it.
 */
export class HostDiscovery {
  private readonly preset: LookupNetworkPreset
  private readonly trackers: string[]
  private readonly overrides: Record<string, string[]>
  private readonly additional: Record<string, string[]>
  private readonly resolver: LookupResolverLike
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, { hosts: DiscoveredHost[]; expiresAt: number }>()

  constructor(options: DiscoveryOptions = {}) {
    this.preset = options.networkPreset ?? 'mainnet'
    this.trackers = options.slapTrackers ?? defaultTrackers(this.preset)
    this.overrides = options.hostOverrides ?? {}
    this.additional = options.additionalHosts ?? {}
    this.resolver =
      options.resolver ??
      new LookupResolver({ networkPreset: this.preset, slapTrackers: this.trackers })
    this.ttlMs = options.hostsTtlMs ?? DEFAULTS.hostsTtlMs
    this.now = options.now ?? Date.now
  }

  async hostsFor(target: DiscoveryTarget): Promise<DiscoveredHost[]> {
    const key = marketKey(target)
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() < cached.expiresAt) return cached.hosts
    const found = new Map<string, DiscoveredHost>()
    const add = (candidate: string, identityKey?: string): void => {
      const url = this.normalize(candidate)
      if (url === undefined || found.has(url)) return
      found.set(url, isPublicKeyHex(identityKey) ? { url, identityKey } : { url })
    }
    const override = this.overrides[key]
    if (override !== undefined) {
      for (const host of override) add(host)
    } else {
      for (const host of await this.discover(target)) add(host.url, host.identityKey)
      for (const host of this.additional[key] ?? []) add(host)
    }
    const hosts = [...found.values()]
    this.cache.set(key, { hosts, expiresAt: this.now() + this.ttlMs })
    return hosts
  }

  private async discover(target: DiscoveryTarget): Promise<DiscoveredHost[]> {
    if (target.kind === 'static') return []
    if (target.kind === 'overlay-lookup' && target.service === 'ls_slap') {
      return this.trackers.map(url => ({ url }))
    }
    const question: LookupQuestion =
      target.kind === 'overlay-lookup'
        ? { service: 'ls_slap', query: { service: target.service } }
        : { service: 'ls_messagebox', query: { identityKey: target.recipient } }
    let answer: LookupAnswer
    try {
      answer = await this.resolver.query(question)
    } catch {
      return []
    }
    if (answer.type !== 'output-list') return []
    const hosts: DiscoveredHost[] = []
    for (const output of answer.outputs) {
      try {
        const transaction = Transaction.fromBEEF(output.beef)
        const script = transaction.outputs[output.outputIndex].lockingScript
        if (target.kind === 'overlay-lookup') {
          const token = OverlayAdminTokenTemplate.decode(script)
          if (token.protocol === 'SLAP' && token.topicOrService === target.service) {
            hosts.push({ url: token.domain, identityKey: token.identityKey })
          }
        } else {
          hosts.push({ url: Utils.toUTF8(PushDrop.decode(script).fields[1]) })
        }
      } catch {
        // An undecodable advertisement names no host.
      }
    }
    return hosts
  }

  private normalize(candidate: string): string | undefined {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' || (url.protocol === 'http:' && this.preset === 'local')) {
        return url.origin
      }
    } catch {
      // Not a URL.
    }
    return undefined
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/discovery.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  HostDiscovery,
  discoveryTarget,
  type DiscoveredHost,
  type DiscoveryOptions,
  type DiscoveryTarget,
  type LookupResolverLike
} from './client/discovery.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): bootstrap host discovery from SLAP trackers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Authenticated transport that never pays

**Files:**

- Create: `packages/overlays/eqc/src/client/transport.ts`
- Test: `packages/overlays/eqc/src/client/transport.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `ECONOMIC_PATHS` (Task 1); `HostParams`, `parseHostParams` (Task 9).
- Produces:
  - `interface TransportResponse { status: number; body: unknown; identityKey?: string }`
  - `interface HostTransport { getParams(url: string, timeoutMs: number): Promise<HostParams>; post(url: string, path: string, body: unknown, timeoutMs: number): Promise<TransportResponse> }`
  - `class TransportTimeoutError extends Error`
  - `nonPayingWallet(wallet: WalletInterface): WalletInterface`
  - `class AuthFetchTransport implements HostTransport { constructor(wallet: WalletInterface, options?: { originator?: string; fetch?: typeof fetch; maxResponseBytes?: number }) }`

`AuthFetch` answers any well-formed HTTP 402 by calling `wallet.createAction` for whatever amount the server names, with no cap and no switch to disable it. The EQC talks to permissionlessly advertised hosts, so the transport gives `AuthFetch` a facade whose `createAction` and `signAction` throw. Only `settle` (Task 14) touches the real wallet's `createAction`.

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/client/transport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { PayerWallet } from '../../test/support/wallets.js'
import { AuthFetchTransport, TransportTimeoutError, nonPayingWallet } from './transport.js'

const params = {
  version: 1,
  host: `02${'ab'.repeat(32)}`,
  threshold: 3,
  topK: 5,
  floorFeeSats: 1000,
  minPayoutSats: 1,
  maxQueryTtlMs: 60_000,
  classes: ['overlay-lookup']
}

describe('nonPayingWallet', () => {
  it('refuses to create or sign actions and forwards everything else', async () => {
    const wallet = new PayerWallet()
    const facade = nonPayingWallet(wallet)
    await expect(facade.createAction({ description: 'HTTP 402 payment' })).rejects.toThrow(
      'never pays'
    )
    await expect(facade.signAction({ reference: 'cmVm', spends: {} })).rejects.toThrow('never pays')
    expect(wallet.actions).toEqual([])
    expect((await facade.getPublicKey({ identityKey: true })).publicKey).toBe(wallet.identityKey)
  })
})

describe('AuthFetchTransport.getParams', () => {
  it('reads /economic/params with a plain fetch', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) => new Response(JSON.stringify(params))
    )
    const transport = new AuthFetchTransport(new PayerWallet(), { fetch: fetchMock })
    expect(await transport.getParams('https://host.example', 1000)).toEqual(params)
    expect(fetchMock.mock.calls[0][0]).toBe('https://host.example/economic/params')
  })

  it('rejects hosts without the market, malformed bodies, and oversized bodies', async () => {
    const respond = (response: Response): AuthFetchTransport =>
      new AuthFetchTransport(new PayerWallet(), { fetch: vi.fn(async () => response) })
    await expect(
      respond(new Response('not found', { status: 404 })).getParams('https://h.example', 1000)
    ).rejects.toThrow('status 404')
    await expect(
      respond(new Response('{"version":2}')).getParams('https://h.example', 1000)
    ).rejects.toThrow(TypeError)
    await expect(
      respond(new Response('x'.repeat(70_000))).getParams('https://h.example', 1000)
    ).rejects.toThrow('too large')
  })

  it('times out', async () => {
    vi.useFakeTimers()
    try {
      const hanging = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
      const transport = new AuthFetchTransport(new PayerWallet(), { fetch: hanging })
      const pending = transport.getParams('https://h.example', 1000)
      const assertion = expect(pending).rejects.toBeInstanceOf(TransportTimeoutError)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
```

`AuthFetchTransport.post` needs a live BRC-103 peer, so Task 16 covers it end to end, including a host that answers with a full HTTP 402 challenge.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/transport.test.ts`
Expected: FAIL with `Cannot find module './transport.js'`.

- [ ] **Step 3: Implement the transport**

`packages/overlays/eqc/src/client/transport.ts`:

```ts
import { AuthFetch, type WalletInterface } from '@bsv/sdk'

import { parseHostParams, type HostParams } from '../protocol/params.js'
import { ECONOMIC_PATHS } from '../protocol/query.js'

export interface TransportResponse {
  status: number
  /** Parsed JSON, or `undefined` when the body was not JSON. */
  body: unknown
  /** The BRC-103 session identity of the host that answered. */
  identityKey?: string
}

export interface HostTransport {
  getParams: (url: string, timeoutMs: number) => Promise<HostParams>
  post: (url: string, path: string, body: unknown, timeoutMs: number) => Promise<TransportResponse>
}

export class TransportTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`${url} did not answer within ${timeoutMs} ms`)
    this.name = 'TransportTimeoutError'
  }
}

const MAX_PARAMS_BYTES = 65_536
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const BLOCKED_METHODS = new Set<string | symbol>(['createAction', 'signAction'])

/**
 * `AuthFetch` pays any well-formed HTTP 402 with no cap. Hosts here are untrusted, so the wallet
 * it sees can authenticate but cannot spend. The EQC spends only through `settle`.
 */
export function nonPayingWallet(wallet: WalletInterface): WalletInterface {
  return new Proxy(wallet, {
    get(target, property, receiver) {
      if (BLOCKED_METHODS.has(property)) {
        return async () => {
          throw new Error('The EQC transport never pays an HTTP 402 challenge')
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

async function withDeadline<T>(url: string, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TransportTimeoutError(url, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export class AuthFetchTransport implements HostTransport {
  private readonly authFetch: AuthFetch
  private readonly fetchImpl: typeof fetch
  private readonly maxResponseBytes: number

  constructor(
    wallet: WalletInterface,
    options: { originator?: string; fetch?: typeof fetch; maxResponseBytes?: number } = {}
  ) {
    this.authFetch = new AuthFetch(
      nonPayingWallet(wallet),
      undefined,
      undefined,
      options.originator
    )
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  }

  /** `/economic/params` is unauthenticated, so it is read with a plain, bounded fetch. */
  async getParams(url: string, timeoutMs: number): Promise<HostParams> {
    const controller = new AbortController()
    const work = (async () => {
      const response = await this.fetchImpl(`${url}${ECONOMIC_PATHS.params}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (response.status !== 200)
        throw new Error(`${url} answered params with status ${response.status}`)
      const text = await response.text()
      if (text.length > MAX_PARAMS_BYTES) throw new Error(`${url} params response is too large`)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new TypeError(`${url} params response is not JSON`)
      }
      return parseHostParams(parsed)
    })()
    try {
      return await withDeadline(url, timeoutMs, work)
    } finally {
      controller.abort()
    }
  }

  async post(
    url: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<TransportResponse> {
    const work = (async () => {
      const response = await this.authFetch.fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const text = await response.text()
      if (text.length > this.maxResponseBytes) throw new Error(`${url} response is too large`)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const result: TransportResponse = { status: response.status, body: parsed }
      const identityKey = response.headers.get('x-bsv-auth-identity-key')
      if (identityKey !== null) result.identityKey = identityKey
      return result
    })()
    return await withDeadline(url, timeoutMs, work)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/transport.test.ts`
Expected: PASS, 4 tests. If `pnpm --filter @bsv/eqc format:check` later reflows the long `if (response.status !== 200)` line, accept Prettier's output.

- [ ] **Step 5: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  AuthFetchTransport,
  TransportTimeoutError,
  nonPayingWallet,
  type HostTransport,
  type TransportResponse
} from './client/transport.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm exec prettier --write "packages/overlays/eqc/src/**/*.ts" && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add authenticated host transport that cannot pay 402 challenges" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Payout planning and settlement

**Files:**

- Create: `packages/overlays/eqc/src/client/settlement.ts`
- Test: `packages/overlays/eqc/src/client/settlement.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: `computePayouts` (Task 2); `paymentEnvelope`, `payoutLockingScript`, `PaymentEnvelope` (Task 5); `Arrival` (Task 10); `PayerWallet`, `HostWallet` (Task 7); `verifyAndInternalizePayment` (Task 7, test only).
- Produces:
  - `interface PayoutPlan { host: string; url: string; rank: number; satoshis: number }`
  - `interface Settlement { txid: string; envelopes: Map<string, PaymentEnvelope> }` — envelopes keyed by host identity key
  - `planPayouts(ranked: Arrival[], feeSats: number): PayoutPlan[]` — zero-satoshi ranks dropped, so the result is always a prefix of the ranking
  - `settle(wallet: WalletInterface, queryId: string, plans: PayoutPlan[], originator?: string): Promise<Settlement>`

`settle` is the only place the package calls `wallet.createAction`. It uses a normal action, so the client wallet broadcasts; see design decision 5.

- [ ] **Step 1: Write the failing test**

`packages/overlays/eqc/src/client/settlement.test.ts`:

```ts
import type { CreateActionArgs, CreateActionResult } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { verifyAndInternalizePayment } from '../host/paymentVerifier.js'
import type { Attestation } from '../protocol/attestation.js'
import type { Arrival } from './race.js'
import { planPayouts, settle } from './settlement.js'

const queryId = 'a4'.repeat(32)

function ranked(hosts: HostWallet[]): Arrival[] {
  return hosts.map((host, index) => ({
    url: `https://h${index + 1}.example`,
    host: host.identityKey,
    arrivedAt: index,
    attestation: {} as Attestation
  }))
}

describe('planPayouts', () => {
  it('splits the fee by Fibonacci weight in rank order', () => {
    const hosts = Array.from({ length: 5 }, () => new HostWallet())
    expect(planPayouts(ranked(hosts), 1000).map(plan => [plan.rank, plan.satoshis])).toEqual([
      [1, 418],
      [2, 250],
      [3, 166],
      [4, 83],
      [5, 83]
    ])
  })

  it('drops ranks whose share floors to zero', () => {
    const hosts = Array.from({ length: 5 }, () => new HostWallet())
    expect(planPayouts(ranked(hosts), 2).map(plan => [plan.rank, plan.satoshis])).toEqual([[1, 2]])
  })
})

describe('settle', () => {
  it('pays every ranked host from one transaction each host can claim', async () => {
    const payer = new PayerWallet()
    const hosts = [new HostWallet(), new HostWallet(), new HostWallet()]
    const plans = planPayouts(ranked(hosts), 1000)
    const settlement = await settle(payer, queryId, plans)

    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].options?.randomizeOutputs).toBe(false)
    expect(payer.actions[0].labels).toEqual(['brc178'])
    expect(payer.actions[0].outputs?.map(output => output.satoshis)).toEqual([500, 250, 250])
    expect(settlement.txid).toMatch(/^[0-9a-f]{64}$/)

    for (const [index, host] of hosts.entries()) {
      const envelope = settlement.envelopes.get(host.identityKey)
      if (envelope === undefined) throw new Error('Missing envelope')
      const result = await verifyAndInternalizePayment({
        wallet: host,
        envelope,
        queryId,
        rank: index + 1,
        clientIdentityKey: payer.identityKey,
        requiredSats: plans[index].satoshis
      })
      expect(result).toMatchObject({ ok: true, outputIndex: index })
    }
  })

  it('refuses to settle nothing', async () => {
    await expect(settle(new PayerWallet(), queryId, [])).rejects.toThrow('No payouts')
  })

  it('surfaces a wallet failure', async () => {
    const payer = new PayerWallet()
    payer.failCreateAction = true
    const plans = planPayouts(ranked([new HostWallet()]), 1000)
    await expect(settle(payer, queryId, plans)).rejects.toThrow('Insufficient funds')
  })

  it('rejects a wallet result that omits a planned output', async () => {
    class DroppingWallet extends PayerWallet {
      override async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
        return await super.createAction({ ...args, outputs: args.outputs?.slice(1) })
      }
    }
    const plans = planPayouts(ranked([new HostWallet(), new HostWallet()]), 1000)
    await expect(settle(new DroppingWallet(), queryId, plans)).rejects.toThrow('rank 1')
  })

  it('rejects a wallet result without a transaction', async () => {
    class EmptyWallet extends PayerWallet {
      override async createAction(): Promise<CreateActionResult> {
        return {}
      }
    }
    const plans = planPayouts(ranked([new HostWallet()]), 1000)
    await expect(settle(new EmptyWallet(), queryId, plans)).rejects.toThrow('no transaction')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/settlement.test.ts`
Expected: FAIL with `Cannot find module './settlement.js'`.

- [ ] **Step 3: Implement settlement**

`packages/overlays/eqc/src/client/settlement.ts`:

```ts
import { Transaction, type WalletInterface } from '@bsv/sdk'

import { computePayouts } from '../protocol/fibonacci.js'
import { paymentEnvelope, payoutLockingScript, type PaymentEnvelope } from '../protocol/payment.js'
import type { Arrival } from './race.js'

export interface PayoutPlan {
  /** Host identity key. */
  host: string
  url: string
  rank: number
  satoshis: number
}

export interface Settlement {
  txid: string
  /** One envelope per paid host, keyed by identity key; only the suffix differs. */
  envelopes: Map<string, PaymentEnvelope>
}

/** Fibonacci split over the ranked hosts. Shares are non-increasing, so zeros only trail. */
export function planPayouts(ranked: Arrival[], feeSats: number): PayoutPlan[] {
  if (ranked.length === 0) return []
  const payouts = computePayouts(feeSats, ranked.length)
  return ranked
    .map((arrival, index) => ({
      host: arrival.host,
      url: arrival.url,
      rank: index + 1,
      satoshis: payouts[index]
    }))
    .filter(plan => plan.satoshis > 0)
}

/**
 * Builds the single payout transaction. A normal action is used, so the client wallet
 * broadcasts: a host's `internalizeAction` broadcasts on receipt anyway, and aborting a
 * `noSend` action after dispatch would leave the wallet believing spent inputs are free.
 */
export async function settle(
  wallet: WalletInterface,
  queryId: string,
  plans: PayoutPlan[],
  originator?: string
): Promise<Settlement> {
  if (plans.length === 0) throw new Error('No payouts to settle')
  const scripts = await Promise.all(
    plans.map(
      async plan =>
        await payoutLockingScript(wallet, plan.host, queryId, plan.rank, false, originator)
    )
  )
  const result = await wallet.createAction(
    {
      description: 'BRC-178 query payout',
      labels: ['brc178'],
      outputs: plans.map((plan, index) => ({
        lockingScript: scripts[index],
        satoshis: plan.satoshis,
        outputDescription: `Rank ${plan.rank} payout`
      })),
      options: { randomizeOutputs: false }
    },
    originator
  )
  if (result.tx === undefined) throw new Error('The wallet returned no transaction')
  const transaction = Transaction.fromAtomicBEEF(result.tx)
  for (const [index, plan] of plans.entries()) {
    const paid = transaction.outputs.some(
      output =>
        output.lockingScript.toHex() === scripts[index] && (output.satoshis ?? 0) === plan.satoshis
    )
    if (!paid) throw new Error(`The wallet transaction does not pay rank ${plan.rank}`)
  }
  const envelopes = new Map<string, PaymentEnvelope>()
  for (const plan of plans) {
    envelopes.set(plan.host, paymentEnvelope(queryId, plan.rank, result.tx))
  }
  return { txid: result.txid ?? transaction.id('hex'), envelopes }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/settlement.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export { planPayouts, settle, type PayoutPlan, type Settlement } from './client/settlement.js'
```

Run: `pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): settle ranked hosts from one Fibonacci payout transaction" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: The `EQC` client

**Files:**

- Create: `packages/overlays/eqc/src/client/EQC.ts`
- Create: `packages/overlays/eqc/test/support/loopback.ts`
- Test: `packages/overlays/eqc/src/client/EQC.test.ts`
- Modify: `packages/overlays/eqc/src/index.ts`

**Interfaces:**

- Consumes: everything produced by Tasks 1–14. In particular `HostTransport`/`AuthFetchTransport` (Task 13), `HostDiscovery`/`DiscoveryOptions`/`discoveryTarget` (Task 12), `runRace`/`decideRace` (Task 10), `assessConsistency`/`classifyMinority` (Task 10), `ReputationStore`/`InMemoryReputationStore` (Task 11), `planPayouts`/`settle` (Task 14), `createEconomicQueryHost` (Task 9, tests only).
- Produces:
  - `interface EQCOptions extends DiscoveryOptions { threshold?: number; topK?: number; raceMs?: number; floorFeeSats?: number; maxFeeSats?: number; feeSats?: number; queryTtlMs?: number; hostTimeoutMs?: number; paramsTtlMs?: number; maxHosts?: number; reputation?: ReputationStore; transport?: HostTransport; originator?: string; clock?: () => number }` — `clock` is a monotonic millisecond source for arrival stamps; `now` (from `DiscoveryOptions`) is wall-clock time for expiry, caches, and reputation
  - `interface QueryRequest { type: string; params: Record<string, unknown> }`
  - `type QueryOverrides = Pick<EQCOptions, 'threshold' | 'topK' | 'raceMs' | 'floorFeeSats' | 'maxFeeSats' | 'feeSats'>`
  - `interface RankedHost { host: string; url: string; rank: number; arrivalMs: number; payoutSats: number }`
  - `interface QueryResult { queryId: string; contentHash: string; payload: number[]; supplement: number[]; ranking: RankedHost[]; txid: string; feeSats: number; attestations: Attestation[]; consistency: TopicConsistency[]; rejected: Rejection[]; completion: Promise<void> }`
  - `class EQC { constructor(wallet: WalletInterface, options?: EQCOptions); query(request, overrides?): Promise<QueryResult>; lookup(question: LookupQuestion, overrides?): Promise<LookupAnswer>; listMessages(args: { messageBox: string }, overrides?): Promise<CanonicalMessage[]>; params(url: string): Promise<HostParams> }`
  - `class LoopbackNetwork implements HostTransport` in `test/support/loopback.ts`

The first valid delivery resolves `query()`. Collects to the other paid hosts keep running; they append to `result.rejected` and update reputation, and `result.completion` resolves when all have settled.

- [ ] **Step 1: Create the loopback network test double**

`packages/overlays/eqc/test/support/loopback.ts`:

```ts
import type { HostTransport, TransportResponse } from '../../src/client/transport.js'
import {
  createEconomicQueryHost,
  type EconomicQueryHost,
  type EconomicQueryHostOptions
} from '../../src/host/handlers.js'
import { parseHostParams, type HostParams } from '../../src/protocol/params.js'
import { ECONOMIC_PATHS } from '../../src/protocol/query.js'
import { HostWallet } from './wallets.js'

export interface LoopbackHost {
  url: string
  wallet: HostWallet
  host: EconomicQueryHost
  /** Delay before every authenticated response. */
  delayMs: number
  down: boolean
  withoutMarket: boolean
  /** Identity key the transport reports for the session, to simulate a spoof. */
  sessionIdentity?: string
  /** Rewrites a successful collect body, to simulate a host that serves wrong bytes. */
  tamperDelivery?: (body: Record<string, unknown>) => Record<string, unknown>
  posts: Array<{ path: string; body: unknown }>
}

interface Captured {
  status: number
  body: unknown
}

function capture(): Captured & {
  response: {
    status: (code: number) => unknown
    json: (body: unknown) => unknown
    set: () => unknown
  }
} {
  const captured: Captured = { status: 0, body: undefined }
  const response = {
    status(code: number) {
      captured.status = code
      return response
    },
    json(body: unknown) {
      captured.body = JSON.parse(JSON.stringify(body))
      return response
    },
    set() {
      return response
    }
  }
  return Object.assign(captured, { response })
}

/** Routes transport calls straight into real host handlers, without HTTP or BRC-103. */
export class LoopbackNetwork implements HostTransport {
  readonly hosts = new Map<string, LoopbackHost>()

  constructor(private readonly clientIdentityKey: string) {}

  add(
    url: string,
    options: Omit<EconomicQueryHostOptions, 'wallet'>,
    behaviour: Partial<Pick<LoopbackHost, 'delayMs' | 'down' | 'withoutMarket'>> = {}
  ): LoopbackHost {
    const wallet = new HostWallet()
    const entry: LoopbackHost = {
      url,
      wallet,
      host: createEconomicQueryHost({ logger: { error: () => undefined }, ...options, wallet }),
      delayMs: 0,
      down: false,
      withoutMarket: false,
      posts: [],
      ...behaviour
    }
    this.hosts.set(url, entry)
    return entry
  }

  async getParams(url: string): Promise<HostParams> {
    const entry = this.hosts.get(url)
    if (entry === undefined || entry.down || entry.withoutMarket) {
      throw new Error(`${url} answered params with status 404`)
    }
    const captured = capture()
    await entry.host.params({ headers: {} }, captured.response as never)
    return parseHostParams(captured.body)
  }

  async post(url: string, path: string, body: unknown): Promise<TransportResponse> {
    const entry = this.hosts.get(url)
    if (entry === undefined || entry.down) throw new Error(`${url} is unreachable`)
    entry.posts.push({ path, body })
    if (entry.delayMs > 0) await new Promise(resolve => setTimeout(resolve, entry.delayMs))
    const captured = capture()
    const request = {
      body: JSON.parse(JSON.stringify(body)),
      headers: {},
      auth: { identityKey: this.clientIdentityKey }
    }
    const handler = path === ECONOMIC_PATHS.query ? entry.host.query : entry.host.collect
    await handler(request, captured.response as never)
    let responseBody = captured.body
    if (
      path === ECONOMIC_PATHS.collect &&
      captured.status === 200 &&
      entry.tamperDelivery !== undefined
    ) {
      responseBody = entry.tamperDelivery(responseBody as Record<string, unknown>)
    }
    return {
      status: captured.status,
      body: responseBody,
      identityKey: entry.sessionIdentity ?? entry.wallet.identityKey
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

`packages/overlays/eqc/src/client/EQC.test.ts`:

```ts
import { Transaction, Utils, type LookupAnswer } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { LoopbackNetwork } from '../../test/support/loopback.js'
import { sampleBeef } from '../../test/support/transactions.js'
import { HostWallet, PayerWallet } from '../../test/support/wallets.js'
import { bytesProvider, messageListProvider, overlayLookupProvider } from '../host/providers.js'
import { EQCError } from '../protocol/errors.js'
import { EQC, type EQCOptions } from './EQC.js'
import { InMemoryReputationStore } from './reputation.js'

const ANSWER = [1, 2, 3, 4]
const urls = [1, 2, 3, 4, 5].map(n => `https://h${n}.example`)

function relay(payload: number[]): ReturnType<typeof bytesProvider> {
  return bytesProvider('relay-lookup', async () => payload)
}

function setup(options: EQCOptions = {}): {
  payer: PayerWallet
  network: LoopbackNetwork
  eqc: EQC
} {
  const payer = new PayerWallet()
  const network = new LoopbackNetwork(payer.identityKey)
  const eqc = new EQC(payer, {
    transport: network,
    hostOverrides: { 'relay-lookup': urls, ls_x: urls, 'message-list': urls },
    raceMs: 60,
    hostTimeoutMs: 400,
    ...options
  })
  return { payer, network, eqc }
}

async function failure(promise: Promise<unknown>): Promise<EQCError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EQCError) return error
    throw error
  }
  throw new Error('Expected an EQCError')
}

const request = { type: 'relay-lookup', params: { key: 'k' } }

describe('EQC.query', () => {
  it('pays the five fastest agreeing hosts by arrival order from one transaction', async () => {
    const { payer, network, eqc } = setup()
    const hosts = urls.map((url, index) =>
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: (5 - index) * 8 })
    )
    const result = await eqc.query(request)
    await result.completion

    expect(result.payload).toEqual(ANSWER)
    expect(result.feeSats).toBe(1000)
    expect(result.ranking.map(entry => entry.url)).toEqual([...urls].reverse())
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([418, 250, 166, 83, 83])
    expect(result.ranking[0].arrivalMs).toBe(0)
    expect(result.rejected).toEqual([])
    expect(result.attestations).toHaveLength(5)

    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].outputs).toHaveLength(5)
    const fastest = hosts[4].wallet.internalized
    expect(fastest).toEqual([expect.objectContaining({ txid: result.txid, satoshis: 418 })])
    expect(hosts[0].wallet.internalized).toEqual([expect.objectContaining({ satoshis: 83 })])
  })

  it('leaves a host that answers differently unpaid', async () => {
    const { network, eqc } = setup()
    const stale = network.add(urls[0], { providers: [relay([9, 9])] })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.ranking).toHaveLength(4)
    expect(result.ranking.map(entry => entry.payoutSats).reduce((a, b) => a + b, 0)).toBe(1000)
    expect(result.rejected).toEqual([
      {
        url: urls[0],
        host: stale.wallet.identityKey,
        reason: 'minority-hash',
        detail: 'minority-hash'
      }
    ])
    expect(stale.wallet.internalized).toEqual([])
    expect(stale.posts.map(post => post.path)).toEqual(['/economic/query'])
  })

  it('refuses to start with fewer market hosts than the threshold', async () => {
    const { payer, network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)] })
    network.add(urls[1], { providers: [relay(ANSWER)] })
    for (const url of urls.slice(2)) {
      network.add(url, { providers: [relay(ANSWER)] }, { down: true })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_NO_HOSTS')
    expect(payer.actions).toEqual([])
  })

  it('pays nobody and touches no wallet when the threshold is not met', async () => {
    const { payer, network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)] })
    network.add(urls[1], { providers: [relay([])] })
    network.add(urls[2], { providers: [relay([])] })
    network.add(urls[3], { providers: [relay([7])] })
    network.add(urls[4], { providers: [relay([8])] })
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_THRESHOLD')
    expect((error.details.groups as unknown[]).length).toBe(4)
    expect(payer.actions).toEqual([])
    for (const host of network.hosts.values()) {
      expect(host.posts.map(post => post.path)).toEqual(['/economic/query'])
    }
  })

  it('makes hoarding self-defeating: the lone holder is the minority', async () => {
    const { network, eqc } = setup()
    const hoarder = network.add(urls[0], { providers: [relay(ANSWER)] })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay([])] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.payload).toEqual([])
    expect(hoarder.wallet.internalized).toEqual([])
    expect(result.ranking).toHaveLength(4)
  })

  it('survives a liar, gets the bytes elsewhere, and cools the liar down', async () => {
    const reputation = new InMemoryReputationStore()
    const { network, eqc } = setup({ reputation })
    const liar = network.add(urls[0], { providers: [relay(ANSWER)] })
    liar.tamperDelivery = body => ({ ...body, payload: Utils.toBase64([6, 6, 6, 6]) })
    for (const url of urls.slice(1)) {
      network.add(url, { providers: [relay(ANSWER)] }, { delayMs: 15 })
    }
    const result = await eqc.query(request)
    await result.completion
    expect(result.payload).toEqual(ANSWER)
    expect(result.ranking[0].url).toBe(urls[0])
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'hash-mismatch' })
    )
    expect(reputation.isExcluded(urls[0], Date.now())).toBe(true)

    const again = await eqc.query(request)
    await again.completion
    expect(again.ranking.map(entry => entry.url)).not.toContain(urls[0])
  })

  it('discards a host whose session key differs from the key it signs with', async () => {
    const { network, eqc } = setup()
    const spoof = network.add(urls[0], { providers: [relay(ANSWER)] })
    spoof.sessionIdentity = new HostWallet().identityKey
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: urls[0], reason: 'identity-mismatch' })
    )
    expect(spoof.wallet.internalized).toEqual([])
  })

  it('counts a slow host as late and does not pay it', async () => {
    const { network, eqc } = setup({ raceMs: 30 })
    for (const url of urls.slice(0, 3)) network.add(url, { providers: [relay(ANSWER)] })
    const slow = network.add(urls[3], { providers: [relay(ANSWER)] }, { delayMs: 200 })
    network.add(urls[4], { providers: [relay(ANSWER)] }, { withoutMarket: true })
    const result = await eqc.query(request)
    await result.completion
    expect(result.ranking).toHaveLength(3)
    expect(result.rejected).toContainEqual({ url: urls[3], reason: 'late' })
    expect(slow.wallet.internalized).toEqual([])
  })

  it('respects the budget: a greedy host is skipped, an impossible floor is refused', async () => {
    const { network, eqc } = setup()
    const greedy = network.add(urls[0], { providers: [relay(ANSWER)], floorFeeSats: 5000 })
    for (const url of urls.slice(1)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.feeSats).toBe(1000)
    expect(greedy.posts).toEqual([])

    const error = await failure(eqc.query(request, { floorFeeSats: 3000 }))
    expect(error.code).toBe('ERR_EQC_BUDGET')
  })

  it('raises the fee to the highest advertised floor within budget', async () => {
    const { network, eqc } = setup()
    network.add(urls[0], { providers: [relay(ANSWER)], floorFeeSats: 1500 })
    for (const url of urls.slice(1, 3)) network.add(url, { providers: [relay(ANSWER)] })
    const result = await eqc.query(request)
    await result.completion
    expect(result.feeSats).toBe(1500)
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([750, 375, 375])
  })

  it('reports a wallet that cannot pay before any collect is sent', async () => {
    const { payer, network, eqc } = setup()
    const hosts = urls.map(url => network.add(url, { providers: [relay(ANSWER)] }))
    payer.failCreateAction = true
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_PAYMENT')
    expect(hosts.flatMap(host => host.posts.map(post => post.path))).not.toContain(
      '/economic/collect'
    )
  })

  it('reports an undelivered query with the payout txid', async () => {
    const { network, eqc } = setup()
    for (const url of urls) {
      network.add(url, { providers: [relay(ANSWER)] }).tamperDelivery = body => ({
        ...body,
        payload: Utils.toBase64([0])
      })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_UNDELIVERED')
    expect(error.details.txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails with no attestation when every host errors', async () => {
    const { network, eqc } = setup()
    for (const url of urls) {
      network.add(url, {
        providers: [
          bytesProvider('relay-lookup', async () => {
            throw new Error('storage offline')
          })
        ]
      })
    }
    const error = await failure(eqc.query(request))
    expect(error.code).toBe('ERR_EQC_NO_ATTESTATION')
  })

  it('validates its configuration', () => {
    const payer = new PayerWallet()
    expect(() => new EQC(payer, { threshold: 3, topK: 2 })).toThrow(RangeError)
    expect(() => new EQC(payer, { threshold: 1, topK: 1 })).not.toThrow()
    expect(() => new EQC(payer, { raceMs: -1 })).toThrow(RangeError)
  })
})

describe('EQC convenience methods', () => {
  it('lookup rebuilds a LookupAnswer and reports BRC-136 consistency', async () => {
    const { network, eqc } = setup()
    const first = sampleBeef(1)
    const second = sampleBeef(2)
    const answer: LookupAnswer = {
      type: 'output-list',
      outputs: [
        { beef: first.beef, outputIndex: 0 },
        { beef: second.beef, outputIndex: 0 }
      ]
    }
    for (const [index, url] of urls.entries()) {
      const outputs = index % 2 === 0 ? answer.outputs : [...answer.outputs].reverse()
      network.add(url, {
        providers: [
          overlayLookupProvider({
            engine: {
              lookup: async () => ({ type: 'output-list', outputs }),
              provideTopicAnchorTip: async topic => ({
                topic,
                blockHeight: 900,
                tac: 'cd'.repeat(32)
              })
            },
            anchorTopics: { ls_x: ['tm_x'] }
          })
        ]
      })
    }
    const rebuilt = await eqc.lookup({ service: 'ls_x', query: { key: 'value' } })
    expect(
      rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex')).sort()
    ).toEqual([first.txid, second.txid].sort())

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: 'ls_x', query: { key: 'value' } }
    })
    await result.completion
    expect(result.consistency).toEqual([
      expect.objectContaining({ topic: 'tm_x', status: 'agreed', blockHeight: 900 })
    ])
  })

  it('listMessages races the caller own inbox', async () => {
    const { payer, network, eqc } = setup()
    for (const url of urls) {
      network.add(url, {
        providers: [
          messageListProvider({
            listMessages: async (recipient, messageBox) => [
              { messageId: '2', sender: recipient, body: messageBox },
              { messageId: '1', sender: recipient, body: messageBox }
            ]
          })
        ]
      })
    }
    expect(await eqc.listMessages({ messageBox: 'payment_inbox' })).toEqual([
      { messageId: '1', sender: payer.identityKey, body: 'payment_inbox' },
      { messageId: '2', sender: payer.identityKey, body: 'payment_inbox' }
    ])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/EQC.test.ts`
Expected: FAIL with `Cannot find module './EQC.js'`.

- [ ] **Step 4: Implement the client**

`packages/overlays/eqc/src/client/EQC.ts`:

```ts
import {
  Random,
  Utils,
  type LookupAnswer,
  type LookupQuestion,
  type WalletInterface
} from '@bsv/sdk'

import {
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery,
  type Attestation,
  type Delivery
} from '../protocol/attestation.js'
import { EQCError } from '../protocol/errors.js'
import { sumOfWeights } from '../protocol/fibonacci.js'
import type { HostParams } from '../protocol/params.js'
import {
  decodeMessageList,
  rebuildLookupAnswer,
  type CanonicalMessage
} from '../protocol/payloads.js'
import {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  type EconomicQuery
} from '../protocol/query.js'
import { assessConsistency, classifyMinority, type TopicConsistency } from './consistency.js'
import {
  HostDiscovery,
  discoveryTarget,
  type DiscoveredHost,
  type DiscoveryOptions
} from './discovery.js'
import { decideRace, runRace, type Arrival, type Rejection } from './race.js'
import { InMemoryReputationStore, type ReputationStore } from './reputation.js'
import { planPayouts, settle, type PayoutPlan, type Settlement } from './settlement.js'
import {
  AuthFetchTransport,
  TransportTimeoutError,
  type HostTransport,
  type TransportResponse
} from './transport.js'

export interface EQCOptions extends DiscoveryOptions {
  threshold?: number
  topK?: number
  raceMs?: number
  floorFeeSats?: number
  maxFeeSats?: number
  /** A fee to offer above the floor. It is still capped by `maxFeeSats`. */
  feeSats?: number
  queryTtlMs?: number
  hostTimeoutMs?: number
  paramsTtlMs?: number
  /** Most hosts contacted per query, best reputation first. */
  maxHosts?: number
  reputation?: ReputationStore
  transport?: HostTransport
  originator?: string
  /** Monotonic milliseconds for arrival stamps. `now` is wall-clock time. */
  clock?: () => number
}

export type QueryOverrides = Pick<
  EQCOptions,
  'threshold' | 'topK' | 'raceMs' | 'floorFeeSats' | 'maxFeeSats' | 'feeSats'
>

export interface QueryRequest {
  type: string
  params: Record<string, unknown>
}

export interface RankedHost {
  host: string
  url: string
  rank: number
  /** Milliseconds behind the fastest ranked host, as measured by this client. */
  arrivalMs: number
  payoutSats: number
}

export interface QueryResult {
  queryId: string
  contentHash: string
  payload: number[]
  supplement: number[]
  ranking: RankedHost[]
  txid: string
  feeSats: number
  attestations: Attestation[]
  consistency: TopicConsistency[]
  /** Grows until `completion` resolves, as the remaining collects finish. */
  rejected: Rejection[]
  completion: Promise<void>
}

interface Market {
  threshold: number
  topK: number
  raceMs: number
  floorFeeSats: number
  maxFeeSats: number
  feeSats: number
}

interface Candidate {
  host: DiscoveredHost
  params: HostParams
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

/**
 * Economic Query Client for BRC-178. Discovers hosts from SLAP trackers, asks all of them the
 * same authenticated query, ranks their attestations by local arrival time, pays the fastest
 * hosts that agree from one transaction, and returns bytes whose hash it verified.
 */
export class EQC {
  private readonly wallet: WalletInterface
  private readonly options: EQCOptions
  private readonly discovery: HostDiscovery
  private readonly transport: HostTransport
  private readonly reputation: ReputationStore
  private readonly clock: () => number
  private readonly now: () => number
  private readonly paramsCache = new Map<string, { params?: HostParams; expiresAt: number }>()
  private identity: Promise<string> | undefined

  constructor(wallet: WalletInterface, options: EQCOptions = {}) {
    this.wallet = wallet
    this.options = options
    this.market({})
    this.discovery = new HostDiscovery(options)
    this.transport =
      options.transport ?? new AuthFetchTransport(wallet, { originator: options.originator })
    this.reputation = options.reputation ?? new InMemoryReputationStore()
    this.clock = options.clock ?? (() => performance.now())
    this.now = options.now ?? Date.now
  }

  /** Races an overlay lookup and rebuilds the `LookupAnswer` from the verified bytes. */
  async lookup(question: LookupQuestion, overrides: QueryOverrides = {}): Promise<LookupAnswer> {
    const result = await this.query(
      { type: 'overlay-lookup', params: { service: question.service, query: question.query } },
      overrides
    )
    return rebuildLookupAnswer(result.payload, result.supplement)
  }

  /** Races the caller's own message box listing. */
  async listMessages(
    args: { messageBox: string },
    overrides: QueryOverrides = {}
  ): Promise<CanonicalMessage[]> {
    const recipient = await this.identityKey()
    const result = await this.query(
      { type: 'message-list', params: { recipient, messageBox: args.messageBox } },
      overrides
    )
    return decodeMessageList(result.payload)
  }

  /** Reads and caches a host's unauthenticated `/economic/params`. */
  async params(url: string): Promise<HostParams> {
    const cached = this.paramsCache.get(url)
    if (cached !== undefined && this.now() < cached.expiresAt) {
      if (cached.params === undefined) throw new Error(`${url} has no economic params`)
      return cached.params
    }
    const expiresAt = this.now() + (this.options.paramsTtlMs ?? DEFAULTS.paramsTtlMs)
    try {
      const params = await this.transport.getParams(url, this.hostTimeoutMs())
      this.paramsCache.set(url, { params, expiresAt })
      return params
    } catch (error) {
      this.paramsCache.set(url, { expiresAt })
      throw error
    }
  }

  async query(request: QueryRequest, overrides: QueryOverrides = {}): Promise<QueryResult> {
    const market = this.market(overrides)
    const client = await this.identityKey()
    const rejected: Rejection[] = []
    const candidates = await this.candidates(request, client, market, rejected)
    if (candidates.length < market.threshold) {
      throw new EQCError(
        'ERR_EQC_NO_HOSTS',
        `${candidates.length} market hosts are available but the threshold is ${market.threshold}`,
        { rejected }
      )
    }

    const query = this.buildQuery(request, client, market, candidates)
    const queryId = computeQueryId(query)
    const race = await runRace(
      candidates.map(candidate => ({
        url: candidate.host.url,
        promise: this.attest(candidate.host, query, queryId)
      })),
      { raceMs: market.raceMs, hostTimeoutMs: this.hostTimeoutMs(), topK: market.topK }
    )
    for (const rejection of race.rejections) this.reject(rejected, rejection)
    for (const url of race.unfinished) {
      this.reject(rejected, { url, reason: race.arrivals.length > 0 ? 'late' : 'timeout' })
    }
    if (race.arrivals.length === 0) {
      throw new EQCError('ERR_EQC_NO_ATTESTATION', 'No host returned a valid attestation', {
        rejected
      })
    }

    const outcome = decideRace(race.arrivals, market)
    if (!outcome.thresholdMet || outcome.winningHash === undefined) {
      throw new EQCError(
        'ERR_EQC_THRESHOLD',
        `No content hash was attested by ${market.threshold} hosts; nothing was paid`,
        { groups: outcome.groups, consistency: assessConsistency(race.arrivals), rejected }
      )
    }
    for (const minority of outcome.minority) {
      const classification = classifyMinority(minority, outcome.ranked)
      this.reputation.record(minority.url, classification, this.now())
      rejected.push({
        url: minority.url,
        host: minority.host,
        reason: 'minority-hash',
        detail: classification
      })
    }

    const quotes = outcome.ranked
      .map(arrival => arrival.attestation.quotedFeeSats)
      .filter(quote => quote <= market.maxFeeSats)
    const feeSats = Math.min(
      market.maxFeeSats,
      Math.max(query.floorFeeSats, market.feeSats, sumOfWeights(outcome.ranked.length), ...quotes)
    )
    const plans = planPayouts(outcome.ranked, feeSats)
    let settlement: Settlement
    try {
      settlement = await settle(this.wallet, queryId, plans, this.options.originator)
    } catch (error) {
      throw new EQCError('ERR_EQC_PAYMENT', 'The wallet could not create the payout transaction', {
        cause: error instanceof Error ? error.message : String(error)
      })
    }

    const contentHash = outcome.winningHash
    const ranking = outcome.ranked.map(arrival => arrival.host)
    const validate = request.type === 'overlay-lookup' ? rebuildLookupAnswer : undefined
    const attempts = plans.map(
      async plan =>
        await this.collect(plan, settlement, { queryId, contentHash, ranking }, rejected, validate)
    )
    const completion = Promise.allSettled(attempts).then(() => undefined)
    let delivered: { payload: number[]; supplement: number[] }
    try {
      delivered = await Promise.any(attempts)
    } catch {
      await completion
      throw new EQCError(
        'ERR_EQC_UNDELIVERED',
        'The payout was dispatched but no host delivered the attested bytes',
        { txid: settlement.txid, rejected }
      )
    }

    const firstArrival = outcome.ranked[0].arrivedAt
    return {
      queryId,
      contentHash,
      payload: delivered.payload,
      supplement: delivered.supplement,
      ranking: outcome.ranked.map((arrival, index) => ({
        host: arrival.host,
        url: arrival.url,
        rank: index + 1,
        arrivalMs: arrival.arrivedAt - firstArrival,
        payoutSats: plans.find(plan => plan.rank === index + 1)?.satoshis ?? 0
      })),
      txid: settlement.txid,
      feeSats,
      attestations: race.arrivals.map(arrival => arrival.attestation),
      consistency: assessConsistency(outcome.ranked),
      rejected,
      completion
    }
  }

  private market(overrides: QueryOverrides): Market {
    const pick = (name: keyof QueryOverrides, fallback: number): number =>
      overrides[name] ?? this.options[name] ?? fallback
    const threshold = boundedInteger(
      pick('threshold', DEFAULTS.threshold),
      'threshold',
      1,
      MAX_RANKED_HOSTS
    )
    const topK = boundedInteger(pick('topK', DEFAULTS.topK), 'topK', 1, MAX_RANKED_HOSTS)
    if (threshold > 1 && topK < threshold) {
      throw new RangeError('topK must be at least threshold unless threshold is 1')
    }
    const market: Market = {
      threshold,
      topK,
      raceMs: boundedInteger(pick('raceMs', DEFAULTS.raceMs), 'raceMs', 0, 60_000),
      floorFeeSats: boundedInteger(
        pick('floorFeeSats', DEFAULTS.floorFeeSats),
        'floorFeeSats',
        1,
        Number.MAX_SAFE_INTEGER
      ),
      maxFeeSats: boundedInteger(
        pick('maxFeeSats', DEFAULTS.maxFeeSats),
        'maxFeeSats',
        1,
        Number.MAX_SAFE_INTEGER
      ),
      feeSats: boundedInteger(pick('feeSats', 0), 'feeSats', 0, Number.MAX_SAFE_INTEGER)
    }
    if (market.floorFeeSats > market.maxFeeSats) {
      throw new EQCError(
        'ERR_EQC_BUDGET',
        `floorFeeSats ${market.floorFeeSats} exceeds maxFeeSats ${market.maxFeeSats}`
      )
    }
    return market
  }

  private hostTimeoutMs(): number {
    return this.options.hostTimeoutMs ?? DEFAULTS.hostTimeoutMs
  }

  private async identityKey(): Promise<string> {
    this.identity ??= this.wallet
      .getPublicKey({ identityKey: true }, this.options.originator)
      .then(result => result.publicKey)
    return await this.identity
  }

  private reject(rejected: Rejection[], rejection: Rejection): void {
    rejected.push(rejection)
    this.reputation.record(rejection.url, rejection.reason, this.now())
  }

  /** Discovery is free; hosts are then filtered by reputation, market support, and budget. */
  private async candidates(
    request: QueryRequest,
    client: string,
    market: Market,
    rejected: Rejection[]
  ): Promise<Candidate[]> {
    const discovered = await this.discovery.hostsFor(
      discoveryTarget(request.type, request.params, client)
    )
    const now = this.now()
    const usable = discovered
      .filter(host => !this.reputation.isExcluded(host.url, now))
      .sort((left, right) => this.reputation.score(right.url) - this.reputation.score(left.url))
      .slice(0, this.options.maxHosts ?? DEFAULTS.maxHosts)
    const checked = await Promise.all(
      usable.map(async host => {
        try {
          return { host, params: await this.params(host.url) }
        } catch {
          rejected.push({ url: host.url, reason: 'http', detail: 'no economic params' })
          return undefined
        }
      })
    )
    return checked.filter(
      (candidate): candidate is Candidate =>
        candidate !== undefined &&
        candidate.params.classes.includes(request.type) &&
        candidate.params.floorFeeSats <= market.maxFeeSats
    )
  }

  private buildQuery(
    request: QueryRequest,
    client: string,
    market: Market,
    candidates: Candidate[]
  ): EconomicQuery {
    const hint = [
      ...new Set(candidates.map(candidate => candidate.host.identityKey ?? candidate.params.host))
    ]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, 64)
    return {
      type: request.type,
      client,
      hostSetHint: hint,
      params: request.params,
      maxFeeSats: market.maxFeeSats,
      floorFeeSats: Math.max(
        market.floorFeeSats,
        ...candidates.map(candidate => candidate.params.floorFeeSats)
      ),
      threshold: market.threshold,
      topK: market.topK,
      raceMs: market.raceMs,
      expires: new Date(
        this.now() + (this.options.queryTtlMs ?? DEFAULTS.queryTtlMs)
      ).toISOString(),
      nonce: Utils.toHex(Random(32))
    }
  }

  /** Never rejects: a failing host becomes a `Rejection` so it cannot fail the query. */
  private async attest(
    host: DiscoveredHost,
    query: EconomicQuery,
    queryId: string
  ): Promise<Arrival | Rejection> {
    const { url } = host
    try {
      const response = await this.transport.post(
        url,
        ECONOMIC_PATHS.query,
        query,
        this.hostTimeoutMs()
      )
      const arrivedAt = this.clock()
      if (response.status !== 200)
        return { url, reason: 'http', detail: `status ${response.status}` }
      let attestation: Attestation
      try {
        attestation = parseAttestation(response.body)
      } catch (error) {
        return { url, reason: 'malformed', detail: error instanceof Error ? error.message : '' }
      }
      const sessionKey = response.identityKey
      if (
        sessionKey === undefined ||
        (host.identityKey !== undefined && host.identityKey !== sessionKey)
      ) {
        return { url, host: attestation.host, reason: 'identity-mismatch' }
      }
      const verdict = verifyAttestation(attestation, { queryId, host: sessionKey })
      if (verdict === 'ok') return { url, host: sessionKey, attestation, arrivedAt }
      return {
        url,
        host: attestation.host,
        reason: verdict === 'hash-mismatch' ? 'malformed' : verdict
      }
    } catch (error) {
      return {
        url,
        reason: error instanceof TransportTimeoutError ? 'timeout' : 'http',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Resolves with verified bytes or throws after recording why this host failed. */
  private async collect(
    plan: PayoutPlan,
    settlement: Settlement,
    committed: { queryId: string; contentHash: string; ranking: string[] },
    rejected: Rejection[],
    validate?: (payload: number[], supplement: number[]) => unknown
  ): Promise<{ payload: number[]; supplement: number[] }> {
    const fail = (reason: Rejection['reason'], detail?: string): never => {
      const rejection: Rejection = { url: plan.url, host: plan.host, reason }
      if (detail !== undefined) rejection.detail = detail
      this.reject(rejected, rejection)
      throw new Error(`${plan.url}: ${reason}`)
    }
    let response: TransportResponse
    try {
      response = await this.transport.post(
        plan.url,
        ECONOMIC_PATHS.collect,
        {
          type: 'collect',
          queryId: committed.queryId,
          contentHash: committed.contentHash,
          ranking: committed.ranking,
          payment: settlement.envelopes.get(plan.host)
        },
        this.hostTimeoutMs()
      )
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : String(error))
    }
    if (response.status !== 200) return fail('collect-failed', `status ${response.status}`)
    if (response.identityKey !== plan.host) return fail('identity-mismatch')
    let delivery: Delivery
    try {
      delivery = parseDelivery(response.body)
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : '')
    }
    const result = verifyDelivery(delivery, {
      queryId: committed.queryId,
      host: plan.host,
      contentHash: committed.contentHash
    })
    if (result.verdict !== 'ok') return fail(result.verdict)
    try {
      validate?.(result.payload, result.supplement)
    } catch (error) {
      return fail('collect-failed', error instanceof Error ? error.message : 'invalid supplement')
    }
    this.reputation.record(plan.url, 'success', this.now())
    return { payload: result.payload, supplement: result.supplement }
  }
}
```

`Rejection['reason']` in `collect` includes verdicts `wrong-query`, `identity-mismatch`, `bad-signature`, and `hash-mismatch`, all of which are `RejectionReason` values, so `fail(result.verdict)` type-checks.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @bsv/eqc exec vitest run src/client/EQC.test.ts`
Expected: PASS, 16 tests. These tests use real timers with delays under 250 ms; the file should finish in a few seconds.

- [ ] **Step 6: Export, check, and commit**

Append to `packages/overlays/eqc/src/index.ts`:

```ts
export {
  EQC,
  type EQCOptions,
  type QueryOverrides,
  type QueryRequest,
  type QueryResult,
  type RankedHost
} from './client/EQC.js'
```

Run: `pnpm exec prettier --write "packages/overlays/eqc/src/**/*.ts" "packages/overlays/eqc/test/**/*.ts" && pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc build && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "feat(eqc): add the EQC client" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: End-to-end market over real HTTP and BRC-103

**Files:**

- Create: `packages/overlays/eqc/test/e2e/harness.ts`
- Test: `packages/overlays/eqc/test/e2e/market.test.ts`

**Interfaces:**

- Consumes: `EQC` (Task 15); `createEconomicQueryHost`, `overlayLookupProvider`, `QueryProvider` (Tasks 8–9); `HostWallet`, `PayerWallet` (Task 7); `sampleBeef`, `slapTokenOutput` (Tasks 7 and 12); `createAuthMiddleware` from `@bsv/auth-express-middleware`; `express`.
- Produces: test-only helpers `startHost(options)` and `slapResolver(entries)`.

This task proves three things unit tests cannot: that an express `Application` satisfies `RouterLike` at compile time, that the flow works through the real BRC-103 middleware and the real `AuthFetch`, and that `AuthFetch` cannot be tricked into paying an HTTP 402 challenge. Hosts mirror `OverlayExpress`: `express.json()`, then `createAuthMiddleware({ allowUnauthenticated: true })`, then the economic routes.

- [ ] **Step 1: Build the dependencies the test resolves through `dist/`**

Run: `pnpm --filter "@bsv/eqc..." build`
Expected: `@bsv/sdk`, `@bsv/auth-express-middleware`, and `@bsv/eqc` build without errors.

- [ ] **Step 2: Create the harness**

`packages/overlays/eqc/test/e2e/harness.ts`:

```ts
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import type { LookupAnswer, LookupQuestion, WalletInterface } from '@bsv/sdk'
import express from 'express'

import type { LookupResolverLike } from '../../src/client/discovery.js'
import { createEconomicQueryHost } from '../../src/host/handlers.js'
import type { QueryProvider } from '../../src/host/providers.js'
import { ECONOMIC_PATHS } from '../../src/protocol/query.js'
import { slapTokenOutput } from '../support/transactions.js'
import { HostWallet } from '../support/wallets.js'

export interface E2EHost {
  url: string
  wallet: HostWallet
  close: () => Promise<void>
}

export async function startHost(options: {
  providers: QueryProvider[]
  delayMs?: number
  /** Answer every query with a complete BRC-105 challenge for this many satoshis. */
  demand402Sats?: number
}): Promise<E2EHost> {
  const wallet = new HostWallet()
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(createAuthMiddleware({ wallet, allowUnauthenticated: true, logLevel: 'error' }))
  if (options.delayMs !== undefined) {
    const delayMs = options.delayMs
    app.use((_req, _res, next) => {
      setTimeout(next, delayMs)
    })
  }
  if (options.demand402Sats !== undefined) {
    const satoshis = options.demand402Sats
    app.post(ECONOMIC_PATHS.query, (_req, res) => {
      res
        .status(402)
        .set({
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': String(satoshis),
          'x-bsv-payment-derivation-prefix': 'AAECAwQFBgcICQoLDA0ODw=='
        })
        .json({ status: 'error', code: 'ERR_PAYMENT_REQUIRED', satoshisRequired: satoshis })
    })
  }
  // Compile-time proof that an express Application satisfies RouterLike.
  createEconomicQueryHost({
    wallet,
    providers: options.providers,
    logger: { error: () => undefined }
  }).mount(app)

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    listening.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    wallet,
    close: async () =>
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** Stands in for the SLAP trackers: answers `ls_slap` with real advertisement tokens. */
export function slapResolver(
  service: string,
  entries: Array<{ url: string; advertiser: WalletInterface }>
): LookupResolverLike {
  return {
    async query(question: LookupQuestion): Promise<LookupAnswer> {
      if (question.service !== 'ls_slap') return { type: 'output-list', outputs: [] }
      const outputs = await Promise.all(
        entries.map(async entry => await slapTokenOutput(entry.advertiser, entry.url, service))
      )
      return { type: 'output-list', outputs }
    }
  }
}
```

- [ ] **Step 3: Write the end-to-end test**

`packages/overlays/eqc/test/e2e/market.test.ts`:

```ts
import { Transaction, type LookupAnswer } from '@bsv/sdk'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { EQC } from '../../src/client/EQC.js'
import { createEconomicQueryHost } from '../../src/host/handlers.js'
import { overlayLookupProvider, type QueryProvider } from '../../src/host/providers.js'
import { sampleBeef } from '../support/transactions.js'
import { HostWallet, PayerWallet } from '../support/wallets.js'
import { slapResolver, startHost, type E2EHost } from './harness.js'

const SERVICE = 'ls_e2e'
const first = sampleBeef(1)
const second = sampleBeef(2)
const answer: LookupAnswer = {
  type: 'output-list',
  outputs: [
    { beef: first.beef, outputIndex: 0 },
    { beef: second.beef, outputIndex: 0, context: [7] }
  ]
}

function provider(reverse: boolean): QueryProvider {
  const outputs = reverse ? [...answer.outputs].reverse() : answer.outputs
  return overlayLookupProvider({
    engine: {
      lookup: async () => ({ type: 'output-list', outputs }),
      provideTopicAnchorTip: async topic => ({ topic, blockHeight: 900, tac: 'cd'.repeat(32) })
    },
    anchorTopics: { [SERVICE]: ['tm_e2e'] }
  })
}

const running: E2EHost[] = []

async function start(options: Parameters<typeof startHost>[0]): Promise<E2EHost> {
  const host = await startHost(options)
  running.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async host => await host.close()))
})

describe('economic query market over HTTP', () => {
  it('lets an express Router satisfy RouterLike', () => {
    const router = express.Router()
    createEconomicQueryHost({ wallet: new HostWallet(), providers: [] }).mount(router)
    expect(router.stack).toHaveLength(3)
  })

  it('discovers hosts from SLAP tokens, races them, pays five, and verifies the answer', async () => {
    const hosts = await Promise.all(
      [0, 1, 2, 3, 4].map(async index => await start({ providers: [provider(index % 2 === 1)] }))
    )
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(
        SERVICE,
        hosts.map(host => ({ url: host.url, advertiser: host.wallet }))
      )
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: { key: 'value' } }
    })
    await result.completion

    expect(result.rejected).toEqual([])
    expect(result.ranking).toHaveLength(5)
    expect(result.ranking.map(entry => entry.payoutSats)).toEqual([418, 250, 166, 83, 83])
    expect(result.consistency).toEqual([
      expect.objectContaining({ topic: 'tm_e2e', status: 'agreed' })
    ])
    expect(payer.actions).toHaveLength(1)
    for (const host of hosts) {
      expect(host.wallet.internalized).toEqual([expect.objectContaining({ txid: result.txid })])
    }

    const rebuilt = await eqc.lookup({ service: SERVICE, query: { key: 'value' } })
    expect(
      rebuilt.outputs.map(output => Transaction.fromBEEF(output.beef).id('hex')).sort()
    ).toEqual([first.txid, second.txid].sort())
  }, 30_000)

  it('never pays a host that answers with an HTTP 402 challenge', async () => {
    const honest = await Promise.all(
      [0, 1, 2].map(async () => await start({ providers: [provider(false)] }))
    )
    const greedy = await start({ providers: [provider(false)], demand402Sats: 1_000_000 })
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(
        SERVICE,
        [...honest, greedy].map(host => ({ url: host.url, advertiser: host.wallet }))
      )
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: {} }
    })
    await result.completion

    expect(result.ranking.map(entry => entry.url).sort()).toEqual(
      honest.map(host => host.url).sort()
    )
    expect(result.rejected).toContainEqual(expect.objectContaining({ url: greedy.url }))
    expect(payer.actions).toHaveLength(1)
    expect(payer.actions[0].description).toBe('BRC-178 query payout')
    expect(payer.actions[0].outputs?.map(output => output.satoshis)).toEqual([500, 250, 250])
    expect(greedy.wallet.internalized).toEqual([])
  }, 30_000)

  it('discards a host whose live identity differs from its SLAP advertisement', async () => {
    const honest = await Promise.all(
      [0, 1, 2].map(async () => await start({ providers: [provider(false)] }))
    )
    const hijacked = await start({ providers: [provider(false)] })
    const payer = new PayerWallet()
    const eqc = new EQC(payer, {
      networkPreset: 'local',
      resolver: slapResolver(SERVICE, [
        ...honest.map(host => ({ url: host.url, advertiser: host.wallet })),
        { url: hijacked.url, advertiser: new HostWallet() }
      ])
    })

    const result = await eqc.query({
      type: 'overlay-lookup',
      params: { service: SERVICE, query: {} }
    })
    await result.completion

    expect(result.ranking).toHaveLength(3)
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ url: hijacked.url, reason: 'identity-mismatch' })
    )
    expect(hijacked.wallet.internalized).toEqual([])
  }, 30_000)
})
```

- [ ] **Step 4: Run the end-to-end test**

Run: `pnpm --filter @bsv/eqc exec vitest run test/e2e/market.test.ts`
Expected: PASS, 4 tests. If the first test fails to compile because `express.Router()` or `express()` is not assignable to `RouterLike`, the defect is in `RouterLike` (Task 9): keep its members as method signatures (`get(path: string, handler: HostHandler): unknown`), never property signatures, so parameter bivariance applies. Do not add an `express` import to `src/`.

- [ ] **Step 5: Run every package check and commit**

Run: `pnpm exec prettier --write "packages/overlays/eqc/test/**/*.ts" && pnpm --filter @bsv/eqc exec vitest run && pnpm --filter @bsv/eqc typecheck && pnpm --filter @bsv/eqc lint && pnpm --filter @bsv/eqc format:check`
Expected: all PASS.

```bash
git add packages/overlays/eqc
git commit -m "test(eqc): exercise the market end to end over HTTP and BRC-103" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: `registerRouter` hook in `@bsv/overlay-express`

**Files:**

- Modify: `packages/overlays/overlay-express/src/OverlayExpress.ts` (types near the other exported types at the top; two private fields beside the other fields; a method after `registerHealthCheck`; two insertions inside `start()`)
- Modify: `packages/overlays/overlay-express/mod.ts`
- Test: `packages/overlays/overlay-express/src/__tests__/OverlayExpress.test.ts`
- Modify: `packages/overlays/overlay-express/package.json` (`version`), `CHANGELOG.md`, `README.md`
- Modify: `docs/packages/overlays/overlay-express.md`, `governance/repository-health/baselines.json`, `governance/package-release-notes.json`
- Regenerate: `docs/reference/package-api-migrations.md`, `docs/reference/stack-facts.md`

**Interfaces:**

- Consumes: nothing from `@bsv/eqc`. The hook is generic.
- Produces:
  - `interface RegisteredRouterContext { engine: Engine; wallet: WalletInterface | undefined }`
  - `type RegisteredRouterFactory = (context: RegisteredRouterContext) => express.RequestHandler | Promise<express.RequestHandler>`
  - `OverlayExpress.registerRouter(path: string, factory: RegisteredRouterFactory): this`

Factories run inside `start()` immediately after the BRC-103 middleware is mounted and before the admin routes and the catch-all 404, so registered routers inherit CORS, body parsing, response limits, and `req.auth`.

- [ ] **Step 1: Write the failing tests**

In `packages/overlays/overlay-express/src/__tests__/OverlayExpress.test.ts`, inside `describe('start method', ...)`, insert this block immediately before `it('should throw if engine not configured', ...)`. `createAuthMiddleware` is already imported and mocked in this file; if the import is missing, add `import { createAuthMiddleware } from '@bsv/auth-express-middleware'` beside the other imports. Indent the block to match the surrounding `describe`.

```ts
describe('registerRouter', () => {
  const startAndCaptureUse = async (): Promise<any[][]> => {
    const useSpy = jest.spyOn(instance.app, 'use')
    jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
      callback()
      return {} as any
    })
    await instance.start()
    return useSpy.mock.calls as any[][]
  }

  it('mounts a registered router after BRC-103 auth and before the 404 handler', async () => {
    instance.serverWallet = {} as any
    const handler = jest.fn()
    const factory = jest.fn<any>().mockResolvedValue(handler)
    expect(instance.registerRouter('/extra', factory)).toBe(instance)

    const calls = await startAndCaptureUse()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith({ engine: mockEngine, wallet: instance.serverWallet })
    const authMiddleware = jest.mocked(createAuthMiddleware).mock.results[0].value
    const authIndex = calls.findIndex(call => call[0] === authMiddleware)
    const routerIndex = calls.findIndex(call => call[0] === '/extra' && call[1] === handler)
    expect(authIndex).toBeGreaterThanOrEqual(0)
    expect(routerIndex).toBeGreaterThan(authIndex)
    expect(routerIndex).toBeLessThan(calls.length - 1)
  })

  it('hands the factory an undefined wallet when no server wallet exists', async () => {
    const factory = jest.fn<any>().mockReturnValue(jest.fn())
    instance.registerRouter('/extra', factory)
    await startAndCaptureUse()
    expect(factory).toHaveBeenCalledWith({ engine: mockEngine, wallet: undefined })
  })

  it('mounts several routers in registration order', async () => {
    const first = jest.fn()
    const second = jest.fn()
    instance.registerRouter('/first', () => first as any)
    instance.registerRouter('/second', () => second as any)
    const calls = await startAndCaptureUse()
    const firstIndex = calls.findIndex(call => call[1] === first)
    const secondIndex = calls.findIndex(call => call[1] === second)
    expect(firstIndex).toBeGreaterThanOrEqual(0)
    expect(secondIndex).toBeGreaterThan(firstIndex)
  })

  it('rejects invalid arguments and registration after start()', async () => {
    expect(() => instance.registerRouter('extra', () => jest.fn() as any)).toThrow(TypeError)
    expect(() => instance.registerRouter('/extra', undefined as any)).toThrow(TypeError)
    await startAndCaptureUse()
    expect(() => instance.registerRouter('/late', () => jest.fn() as any)).toThrow(
      'registerRouter must be called before start()'
    )
  })

  it('fails start() when a factory throws', async () => {
    instance.registerRouter('/broken', () => {
      throw new Error('factory failed')
    })
    jest.spyOn(instance.app, 'listen').mockImplementation((port: any, callback: any) => {
      callback()
      return {} as any
    })
    await expect(instance.start()).rejects.toThrow('factory failed')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @bsv/overlay-express exec jest --watchman=false src/__tests__/OverlayExpress.test.ts -t registerRouter`
Expected: FAIL with `instance.registerRouter is not a function`.

- [ ] **Step 3: Implement the hook**

In `packages/overlays/overlay-express/src/OverlayExpress.ts`:

1. Beside the other exported interfaces near the top of the file (for example directly above `export interface EngineConfig`), add:

```ts
/** What a factory registered with {@link OverlayExpress.registerRouter} receives. */
export interface RegisteredRouterContext {
  engine: Engine
  /** The server wallet behind BRC-103 authentication, or undefined when it failed to start. */
  wallet: WalletInterface | undefined
}

/** Builds a router once the engine and server wallet exist. */
export type RegisteredRouterFactory = (
  context: RegisteredRouterContext
) => express.RequestHandler | Promise<express.RequestHandler>
```

2. Beside the other class fields (for example directly after the `edgePolicyConfig` field), add:

```ts
  // Application routers mounted by start(), in registration order
  private readonly registeredRouters: Array<{ path: string; factory: RegisteredRouterFactory }> =
    []

  // Set once start() begins wiring routes; later registrations could never be reached
  private startInvoked = false
```

3. Directly after the `registerHealthCheck` method, add:

```ts
  /**
   * Registers an application router. Its factory runs during `start()`, after the BRC-103
   * authentication middleware is mounted and before the admin routes and the 404 handler, so
   * the router inherits CORS, body parsing, response limits, and `req.auth`.
   *
   * @param path - Mount path, beginning with "/"
   * @param factory - Receives the engine and server wallet and returns the router
   */
  registerRouter(path: string, factory: RegisteredRouterFactory): this {
    if (this.startInvoked) throw new Error('registerRouter must be called before start()')
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError('Router path must begin with "/"')
    }
    if (typeof factory !== 'function') throw new TypeError('Router factory must be a function')
    this.registeredRouters.push({ path, factory })
    this.logger.log(chalk.blue(`Registered router at ${path}`))
    return this
  }
```

4. In `start()`, directly after the line `this.startTime = new Date()`, add:

```ts
this.startInvoked = true
```

5. In `start()`, directly after the `if (this.serverWallet !== undefined) { ... }` block that mounts `bsvAuth` and before the `checkAdminAuth` comment, add:

```ts
for (const { path, factory } of this.registeredRouters) {
  this.app.use(path, await factory({ engine, wallet: this.serverWallet }))
  this.logger.log(chalk.blue(`Mounted registered router at ${path}`))
}
```

In `packages/overlays/overlay-express/mod.ts`, add the two types to the first export list:

```ts
  type HealthStatus,
  type RegisteredRouterContext,
  type RegisteredRouterFactory,
  type TopicAnchorHeaderResolver
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @bsv/overlay-express exec jest --watchman=false src/__tests__/OverlayExpress.test.ts`
Expected: PASS for the whole file, including 5 new `registerRouter` tests.

- [ ] **Step 5: Version, changelog, README, and package documentation**

1. `packages/overlays/overlay-express/package.json`: change `"version": "2.7.1"` to `"version": "2.8.0"`. Edit only this field; do not run a version sync script.
2. `packages/overlays/overlay-express/CHANGELOG.md`: add as the first bullet under `## [Unreleased]`:

```markdown
- Added `registerRouter(path, factory)`. Registered routers mount during `start()` after the BRC-103 authentication middleware and before the admin routes and 404 handler, inheriting CORS, body parsing, response limits, and `req.auth`. Additive; no consumer migration is required.
```

3. `packages/overlays/overlay-express/README.md`: add this section directly before `### Admin-Protected Endpoints`:

````markdown
### Registering Additional Routers

`registerRouter(path, factory)` mounts your own router inside the server. The factory runs
during `start()`, after the BRC-103 authentication middleware and before the admin routes and
the 404 handler, so the router inherits CORS, body parsing, response size limits, and
`req.auth.identityKey`. Requests without BRC-103 headers arrive with `req.auth.identityKey`
equal to `'unknown'`; routes that need authentication must reject them. Call it before
`start()`.

```ts
server.registerRouter('/', ({ engine, wallet }) => {
  if (wallet === undefined) throw new Error('A server wallet is required')
  const router = express.Router()
  router.get('/status', (_req, res) => res.json({ ok: true }))
  return router
})
```
````

4. `docs/packages/overlays/overlay-express.md`: set frontmatter `version: '2.8.0'`, and `last_updated` and `last_verified` to today's date. Add this section directly before the page's last `##` heading:

````markdown
## Registering additional routers

`registerRouter(path, factory)` mounts an application router inside the server. The factory runs
during `start()`, after the BRC-103 authentication middleware and before the admin routes and the
404 handler, so the router inherits CORS, body parsing, response size limits, and
`req.auth.identityKey`. Unauthenticated requests arrive with `req.auth.identityKey` equal to
`'unknown'`. Call it before `start()`.

```ts
server.registerRouter('/', ({ engine, wallet }) => {
  if (wallet === undefined) throw new Error('A server wallet is required')
  const router = express.Router()
  router.get('/status', (_req, res) => res.json({ ok: true }))
  return router
})
```
````

- [ ] **Step 6: Governance records**

1. `governance/repository-health/baselines.json`: in `publicPackageVersions`, change `"@bsv/overlay-express": "2.7.1"` to `"2.8.0"`.
2. `governance/package-release-notes.json`: in the `@bsv/overlay-express` entry, leave `publishedVersion` and `releaseType` untouched. Append to the end of `summary`: ` Adds registerRouter so applications can mount routers after BRC-103 authentication and before the 404 handler.` Append to the end of `migration`: ` No migration is required for registerRouter; it is additive.`
3. Run: `git grep -n "2\.7\.1" -- docs governance packages/overlays/overlay-express`
   Update any remaining line that records the `@bsv/overlay-express` version. Leave other packages' versions alone.
4. Run: `pnpm docs:packages && pnpm docs:facts`
   Then run `git status --short docs/` and restore any regenerated page unrelated to `@bsv/overlay-express` with `git checkout -- <path>`. Expected remaining changes: `docs/reference/package-api-migrations.md` and `docs/reference/stack-facts.md`.

- [ ] **Step 7: Check and commit**

Run: `pnpm --filter @bsv/overlay-express build && pnpm --filter @bsv/overlay-express test && pnpm --filter @bsv/overlay-express lint && pnpm --filter @bsv/overlay-express typecheck && pnpm --filter @bsv/overlay-express format:check && pnpm docs:packages:check && node scripts/documentation-policy.mjs`
Expected: all PASS.

```bash
git add packages/overlays/overlay-express docs governance
git commit -m "feat(overlay-express): add registerRouter hook for application routers" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Package documentation, governance registration, and full validation

**Files:**

- Modify: `packages/overlays/eqc/README.md`
- Create: `packages/overlays/eqc/browser-budget.json`, `docs/packages/overlays/eqc.md`
- Generate: `packages/overlays/eqc/AGENTS.md`, `packages/overlays/eqc/LICENSE.txt`
- Modify: `docs/packages/overlays/index.md`, `docs/packages/index.md`, `docs-site/src/lib/nav.ts`
- Modify: `governance/repository-health/projects.json`, `governance/repository-health/baselines.json`, `governance/package-release-notes.json`, `governance/npm-package-supply-chain.json`, `governance/test-quality/policy.json`, `governance/mutation-testing/policy.json`, `governance/mutation-testing/targets.mjs`, `governance/browser-artifact-policy.json`
- Modify: `scripts/configure-ts-stack-npm-trust.sh`, `scripts/repository-health.test.mjs`, `scripts/package-documentation.test.mjs`, `scripts/package-license-policy.test.mjs`, `scripts/typescript-toolchain.test.mjs`, `scripts/test-governance.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-18-eqc-brc178-design.md` (status line)

**Interfaces:**

- Consumes: the finished package from Tasks 1–16.
- Produces: a repository whose governance checks pass with 43 projects and 35 public packages.

- [ ] **Step 1: Write the full README**

Replace `packages/overlays/eqc/README.md` with:

````markdown
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
````

- [ ] **Step 2: Register the project and generate its policy files**

1. `governance/repository-health/projects.json`: insert this entry between the `packages/overlays/btms-backend` and `packages/overlays/gasp-core` entries:

```json
    {
      "path": "packages/overlays/eqc",
      "name": "@bsv/eqc",
      "owner": "ts-stack-maintainers",
      "area": "overlays",
      "profile": "browser-library",
      "consumerProfiles": ["browser-bundler", "browser-esm", "node-cjs", "node-esm"],
      "criticality": "tier-1",
      "runtimeTargets": ["browser", "node"],
      "release": "npm-oidc"
    },
```

2. Run: `pnpm contributor-policy:sync && pnpm license:sync`
   Expected: `packages/overlays/eqc/AGENTS.md` and `packages/overlays/eqc/LICENSE.txt` appear. Run `git status --short` and restore any unrelated file the sync touched with `git checkout -- <path>`.

- [ ] **Step 3: Browser budget**

1. Create `packages/overlays/eqc/browser-budget.json` with a deliberately generous first budget:

```json
{
  "schemaVersion": 1,
  "profile": "browser",
  "package": "@bsv/eqc",
  "entry": ".",
  "requiredExports": ["EQC", "computeQueryId"],
  "prohibitedExports": ["createEconomicQueryHost", "overlayLookupProvider"],
  "maximumBytes": {
    "vite": { "raw": 5000000, "gzip": 2000000, "brotli": 2000000 },
    "esbuild": { "raw": 5000000, "gzip": 2000000, "brotli": 2000000 }
  }
}
```

2. `governance/browser-artifact-policy.json`: add after the `@bsv/chirp` entry:

```json
    {
      "name": "@bsv/eqc",
      "path": "packages/overlays/eqc",
      "budget": "packages/overlays/eqc/browser-budget.json",
      "entry": ".",
      "splittingDisposition": "The root entry holds the client and protocol core; host handlers ship only from the ./host subpath."
    },
```

3. Run: `pnpm --filter @bsv/eqc test:browser`
   Expected: the final line reads `Verified @bsv/eqc@0.1.0 exact-tarball browser contract: {"vite":{"raw":...,"gzip":...,"brotli":...},"esbuild":{...}}`. If it reports a prohibited module or a `node:` specifier, a file under `src/protocol` or `src/client` imports something Node-only; remove that import rather than relaxing the check.
4. Replace each of the six numbers in `maximumBytes` with the measured value multiplied by 1.1 and rounded up to the next 1000. Re-run `pnpm --filter @bsv/eqc test:browser`; expected PASS.

- [ ] **Step 4: Release notes, baselines, and supply chain**

1. `governance/package-release-notes.json`: insert directly after the `@bsv/ecpm-permission-module` entry:

```json
    {
      "name": "@bsv/eqc",
      "publishedVersion": "0.0.0",
      "releaseType": "minor",
      "summary": "Introduces the Economic Query Client for BRC-178 race-settled collection markets: SLAP-bootstrapped host discovery, a client-judged race over BRC-77 attestations, one Fibonacci-weighted BRC-29 payout transaction, hash-verified collection, BRC-136 topic-anchor consistency reporting, local host reputation, and framework-agnostic host handlers with overlay-lookup, message-list, and byte providers.",
      "migration": "No consumer migration is required; this is the first release of a new additive package. Existing LookupResolver, MessageBoxClient, overlay, and message box server routes are unchanged."
    },
```

2. `governance/repository-health/baselines.json`: in `workspace`, change `projects` 42 to 43, `packageAreaProjects` 37 to 38, and `publicPackages` 34 to 35. In `publicPackageVersions`, add `"@bsv/eqc": "0.1.0"` in alphabetical position.
3. `governance/npm-package-supply-chain.json`: change `publicPackageCount` 34 to 35.
4. `scripts/configure-ts-stack-npm-trust.sh`: add `"@bsv/eqc"` to the `PKGS` array after `"@bsv/lch"`.

- [ ] **Step 5: Property and mutation registration**

1. `governance/test-quality/policy.json`: add `"packages/overlays/eqc/package.json"` to `propertyTesting.manifests`, and add to `propertyTesting.suites`:

```json
      {
        "path": "packages/overlays/eqc/src/protocol/protocol.property.test.ts",
        "manifest": "packages/overlays/eqc/package.json",
        "risk": "critical",
        "boundary": "BRC-178 payout arithmetic and the canonical encodings hashed into query identifiers and content hashes",
        "target": "Fee conservation and rank monotonicity of the Fibonacci split, and order independence of canonical JSON, message-list, and outpoint-list bytes",
        "invariants": [
          "Payouts sum exactly to the fee, never increase with rank, and give every rank but the first its floored Fibonacci share.",
          "Canonical JSON is independent of object key order and survives a parse and re-encode.",
          "Canonical message-list and outpoint-list bytes are independent of input order."
        ]
      },
```

2. `governance/mutation-testing/policy.json`: add to `targets`:

```json
    {
      "id": "eqc-protocol",
      "manifest": "packages/overlays/eqc/package.json",
      "propertyTest": "packages/overlays/eqc/src/protocol/protocol.property.test.ts",
      "risk": "critical",
      "boundary": "BRC-178 payout arithmetic and the canonical encodings hashed into query identifiers and content hashes",
      "minimumScore": 80,
      "maximumNoCoverage": 0,
      "maximumInvalid": 0
    },
```

3. `governance/mutation-testing/targets.mjs`: add beside the `'payment-402'` target:

```js
    'eqc-protocol': {
      packageDirectory: 'packages/overlays/eqc',
      manifest: 'packages/overlays/eqc/package.json',
      propertyTest: 'packages/overlays/eqc/src/protocol/protocol.property.test.ts',
      mutate: ['src/protocol/fibonacci.ts', 'src/protocol/canonicalJson.ts'],
      ...vitestTarget('vitest.config.ts')
    },
```

4. Run: `pnpm test:mutation --target eqc-protocol`
   Expected: a mutation score is reported with zero no-coverage and zero invalid mutants. If the score is below 80, read the surviving mutants and add unit assertions to `fibonacci.test.ts` or `canonicalJson.test.ts` that kill them; do not lower `minimumScore` below 80. If the score is comfortably higher, raise `minimumScore` to the measured score rounded down to the nearest 5.

- [ ] **Step 6: Documentation pages**

1. Create `docs/packages/overlays/eqc.md`, using today's date for both date fields:

````markdown
---
id: eqc
title: '@bsv/eqc'
kind: package
domain: overlays
npm: '@bsv/eqc'
version: '0.1.0'
last_updated: '2026-09-18'
last_verified: '2026-09-18'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc'
status: experimental
tags: ['overlay', 'message-box', 'payments', 'brc-178', 'brc-136']
---

# @bsv/eqc

> Economic Query Client for BRC-178 race-settled collection markets: hosts compete to answer a query and the client pays the fastest that agree.

## Install

```bash
npm install @bsv/eqc @bsv/sdk
```

## Quick start

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet)
const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
```

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
```

## What it provides

- **`EQC`** — discovers hosts from SLAP trackers, fans one BRC-103 authenticated query out to all of them, ranks BRC-77 attestations by local arrival time, pays the top `K` hosts that attested the same content hash from one Fibonacci-weighted BRC-29 transaction, and returns bytes whose hash it verified.
- **`@bsv/eqc/host`** — `GET /economic/params`, `POST /economic/query`, and `POST /economic/collect` handlers with providers for overlay lookups, message box listings, and arbitrary byte reads.
- **Protocol core** — canonical JSON query identifiers, canonical payload encodings, wallet-based BRC-77 signatures, and the payout split.

## How the market works

1. Discovery is free: an `ls_slap` lookup on the ordinary `/lookup` route names the hosts.
2. Every host attests a content hash. The client stamps each arrival with its own clock.
3. When at least `threshold` hosts attest one hash, the client pays the fastest `topK` of them. Below the threshold nobody is paid and no wallet call is made.
4. Each paid host receives the transaction in a collect request, internalizes its own output, and returns the bytes.

A host that withholds data from its peers ends up alone with its hash and earns nothing. For overlay lookups, attestations carry BRC-136 topic anchors, and the result reports whether the winning hosts agree on the topic's confirmed history.

## Operational and security notes

- The default minimum fee is 1000 satoshis and the default budget is 2000 satoshis per query.
- The client pays when it dispatches collect requests; loss is bounded by `maxFeeSats` per query, and hosts that take payment without delivering are excluded for ten minutes.
- The transport never pays HTTP 402 challenges.
- BEEF returned with an overlay lookup is outside the content hash and must be verified by SPV.
- Message box servers cannot yet serve this market from several hosts; see the design document.

## Reference

- [Design and protocol decisions](../../superpowers/specs/2026-09-18-eqc-brc178-design.md)
- [BRC-178](https://bsv.brc.dev/overlays/0178), [BRC-136](https://bsv.brc.dev/overlays/0136)
- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/eqc#readme)
````

2. `docs/packages/overlays/index.md`: add a table row after the `@bsv/overlay-discovery-services` row, keeping the column alignment Prettier produces. The first cell is a Markdown link with the label `@bsv/eqc` and the target `./eqc.md` (written apart here because the docs link checker also reads fenced snippets, and that target does not resolve from this directory):

```markdown
| <link: @bsv/eqc> | Economic Query Client and host handlers for BRC-178 race-settled collection markets |
```

3. `docs/packages/index.md`: add after the `@bsv/overlay-discovery-services` bullet, where the link has the label `@bsv/eqc` and the target `./overlays/eqc.md`:

```markdown
- <link: @bsv/eqc> — Pay the fastest agreeing overlay and message box hosts (BRC-178)
```

4. `docs-site/src/lib/nav.ts`: add after the `@bsv/overlay-discovery-services` item in the overlays group:

```ts
          { label: '@bsv/eqc', href: '/packages/overlays/eqc/' },
```

5. `docs/superpowers/specs/2026-09-18-eqc-brc178-design.md`: change the status line to `**Status:** Implemented in phase 1 (package and overlay-express hook); phases 2 and 3 pending`.
6. Run: `pnpm exec prettier --write docs/packages/overlays/index.md docs/packages/overlays/eqc.md docs/packages/index.md && pnpm docs:packages && pnpm docs:facts`
   Then `git status --short docs/` and restore regenerated pages unrelated to `@bsv/eqc` with `git checkout -- <path>`.

- [ ] **Step 7: Update the hardcoded registry counts**

Run: `node --test scripts/*.test.mjs`
Expected: failures that name the old counts. Apply exactly these deltas, then re-run until it passes:

| File                                      | Change                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/repository-health.test.mjs`      | every `42` that counts projects becomes `43`, including the test title `42-project registry`; every `34` that counts public packages becomes `35` |
| `scripts/package-documentation.test.mjs`  | both `34` become `35`                                                                                                                             |
| `scripts/package-license-policy.test.mjs` | `51` becomes `52`                                                                                                                                 |
| `scripts/typescript-toolchain.test.mjs`   | `48` becomes `51` (three new tsconfig files)                                                                                                      |
| `scripts/test-governance.test.mjs`        | `propertySuites` 33 → 34, `propertyPackages` 31 → 32, `propertyClassifiedPackages` 37 → 38, `mutationTargets` 33 → 34                             |

If a test reports a different expected number than this table, trust the test output: it is computed from the registries.

- [ ] **Step 8: Full validation**

Run each command and read its output before running the next:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm health:check
pnpm lint
pnpm format:check
pnpm typecheck
pnpm --filter @bsv/eqc test
pnpm --filter @bsv/eqc test:coverage
pnpm --filter @bsv/eqc test:property
pnpm --filter @bsv/eqc pack:check
pnpm --filter @bsv/eqc test:browser
pnpm --filter @bsv/overlay-express test
pnpm docs:facts:check
node scripts/check-sdk-peer.mjs
pnpm audit:security
```

Expected: every command exits 0. `pnpm install --frozen-lockfile` must not want to change the lockfile; if it does, run `pnpm install --lockfile-only --ignore-scripts`, confirm the only change is the `packages/overlays/eqc` importer, and commit it. If `pnpm health:check` reports findings under paths that are not part of this branch (for example nested worktrees), re-run the validation from a detached worktree outside the repository: `git worktree add --detach /Users/personal/git/ts-stack-prep/eqc HEAD`, then repeat this step there and remove it afterwards with `git worktree remove /Users/personal/git/ts-stack-prep/eqc`.

- [ ] **Step 9: Commit**

```bash
git add -A packages/overlays/eqc docs governance scripts docs-site pnpm-lock.yaml
git status --short
git commit -m "docs(eqc): document and register @bsv/eqc with repository governance" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Before committing, read `git status --short` and confirm every listed file belongs to this task. Do not push.
