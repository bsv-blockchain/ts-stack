# Overlay lookup recovery validation

The shared fix applies to the standard `LookupResolver` for every service. The
regressions cover persisted exclusion, stale discovery, bounded settlement and
failure-versus-empty reporting. KV-specific tests additionally exercise proof
validation, spend reconciliation and indexing-aware writes.

All fault injection uses synthetic data, trusted fixture roots and isolated local
processes. Source comparison starts at ts-stack `98734b07cf` (2026-09-04).

## Reproductions and regression coverage

| Failure                                         | Evidence                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Future cooldown excludes a recovered host       | `LookupResolver.poison-reproduction.test.ts` reproduces the old exclusion, including a record generated through normal failure/flush calls after clock skew. The current standard resolver contacts the recovered host without clearing storage. |
| Empty peer masks data on another host           | Shared resolver tests require both hosts to be contacted and preserve later data.                                                                                                                                                                |
| First discovery response retains a retired host | Discovery tests require the union of bounded tracker responses and a fresh discovery operation on the next query.                                                                                                                                |
| A hung host holds up a lookup                   | All standard query APIs settle within their host/operation budgets, including discovery; iterator close cancels remaining work.                                                                                                                  |
| Outage becomes an apparently empty collection   | Incomplete empty aggregates throw retryable `LookupUnavailableError`; detailed/progressive APIs retain completion evidence.                                                                                                                      |
| Bad proof or stale ancestor wins by latency     | KV tests validate BEEF, signatures, selectors and fixture-root SPV before reconciliation; incomparable tips produce conflict.                                                                                                                    |
| Accepted transaction is not yet indexed         | Optional KV write tests retain the same transaction identity, report unconfirmed status and reconcile without creating another transaction.                                                                                                      |
| Persisted penalties recur across tabs/reloads   | `browser/lookup-recovery.mjs` uses the exact packed UMD in Chromium, real IndexedDB transactions, two concurrent tabs, four services and five outage/recovery cycles.                                                                            |

The legacy cooldown behavior can be reproduced at `ff36b55`; the standard-export
recovery assertions are in `LookupResolver.shared-reliability.test.ts`. Services
include identity, SHIP, custom lookups and KV, so these checks do not depend on
using the optional KV entrypoint.

Real loopback HTTP fault injection covers disabled, delayed, corrupt, stale and
empty peers using actual JSON, BEEF and signatures. Fake-clock tests establish
250 ms recovered-host response, 2,000 ms healthy-plus-hung settlement and a
1,600 ms total budget including 1,400 ms discovery. These measurements describe
the fixtures, not a production latency SLO.

## Validation commands

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm health:check
pnpm lint
pnpm format:check
pnpm typecheck
pnpm --filter @bsv/sdk test:coverage --runInBand
pnpm --filter @bsv/sdk test:property
pnpm --filter @bsv/sdk pack:check
pnpm --filter @bsv/sdk test:browser
pnpm --filter @bsv/wallet-toolbox-mobile test:mobile
pnpm --filter docs-site test
pnpm --filter docs-site build
pnpm conformance
pnpm audit:security
```

The browser command requires Chrome or Chromium in a standard system location,
uses a disposable browser profile, and removes its package extraction afterwards.
No browser account, production endpoint or existing storage is used. Ten
consecutive runs of the transactional fixture passed (200 reloads total).

The final local SDK coverage suite passed 165 suites / 6,004 tests and
one snapshot, with 94.37% statement, 86.51% branch, 95.29% function and 95.29% line
coverage. Packed ESM/CJS exports, strict declarations, source maps, publint,
Vite, esbuild and UMD contracts passed. UMD is 554,955 bytes within the unchanged 555,000-byte budget.
The PR records the final exact-head results; historical measurements are not a
substitute for its current hosted merge gate.

The existing property profile passed three suites / six tests. Conformance
parsed 76 files / 6,690 vectors without errors; no new portable protocol is
introduced. Four targeted fault mutations were independently detected by the
regressions: reinstating cooldown exclusion (5 failed tests), returning empty on
failure (1), using only the first tracker (1), and sharing reputation across
services (5). All mutated source was restored and the focused suites passed
again. This is evidence for those four mechanisms, not a general mutation score;
the governed hosted mutation campaign remains a separate gate.

## Consumer checks and scope

Metanet Docs (`a63e76a`) passed 49 files / 185 tests and its frontend build against
an extracted local SDK 3 tarball. Gloss (`01c6b7c`) passed four tests and its
TypeScript build against the same artifact. The candidate imports were verified
inside each consumer's dependency tree before testing. The previews exercise
retained data, degraded status and Retry through the shared read session.

Consumer preview commits remain local; production factories, dependency pins and
compatibility adapters are unchanged. Publication and consumer adoption follow
the coordinated SDK 3 migration described in [the migration guide](overlay-lookup-migration.md).

The shared resolver fixes recovery and distinguishes incomplete transport from
empty results. It cannot establish authoritative global absence/currentness for
an arbitrary service. Those guarantees require a service validator and an
explicit authority/protocol model. Durable pending-write recovery across reloads,
cross-device uniqueness, verified KV history and production UI adoption are
separate extensions; see [the design](globalkv-reliability-draft.md).

## Coordinated SDK peer compatibility

The first clean-install CI run exposed SDK 2-only peer declarations in first-party
packages. The 31 affected packages now accept SDK 3 alongside their existing SDK 2
ranges, with patch versions and synchronized release documentation. The complete
workspace `pack:check` run passes clean installs, declarations, exports and package
payloads. The full workspace browser matrix also passes with unchanged budgets,
including the wallet browser consumer and packed Chromium recovery fixture.
No force-install or peer-validation bypass is used. Source versions and
ranges are listed in the generated package API/migration table.

Workspace tests also exercise the SDK 3 graph. Three wallet suites initially
encountered missing middleware output while package checks rebuilt those files;
after builds completed, all three suites / 46 tests passed. The other 219 wallet
suites / 2,103 tests passed in the first run. CI performs builds before tests,
so this local scheduling mistake does not require a source workaround.

## Tooling dependency remediation

The audit identified vulnerable `fast-uri`, `qs` and `toml` versions in the build
and test graph. Compatible lock updates select fast-uri 3.1.7 and qs 6.16.0.
The existing typed-rest-client override selects the same patched qs version.
The current frontmatter plugin still requires toml 3, so a parent-scoped toml
4.2.0 substitution is registered with an owner, review date and removal condition.
MDX TOML/YAML integration, parser security regressions and the full documentation
build check its compatibility. No advisory dismissal or quality/bundle threshold
was added or relaxed.

## Cross-runtime CI follow-up

Repeated Chromium runs exposed a stale localStorage read overwriting a newer
update in another tab despite Web Locks. Browser persistence now reads and writes
inside one IndexedDB transaction. The fixture waits for committed state, reloads
both tabs with active penalties and preserves legacy localStorage unchanged.
Independent-cache, same-key concurrency, abort and unavailable-database tests
cover the storage boundary. Refresh is capped at 50 ms and remains advisory.

The Hermes profile exposed bytecode growth from redundant async wrappers in the
shared resolver. Promise-returning adapters and synchronous structural validators
avoid unnecessary transpiled state machines. Mobile, browser, cancellation and
deadline checks validate the same resolver with the original bundle budgets. The
packed mobile fixture measures 1,718,536 bytes for Metro and 3,493,469 bytes for
Hermes, below the unchanged 1,720,000 and 3,495,000 byte limits.

Node 24.20 accepts some invalid punycode labels that earlier URL parsers rejected.
Discovery advertisement validation explicitly requires those labels to decode,
while preserving valid internationalized names. All 100 discovery tests pass on
Node 24.20, including the unchanged property regression that exposed this change.
The governed advertisement mutation profile passes at 86.83% (145 detected of
167 valid mutations).

The IndexedDB transaction tests use the existing workspace `fake-indexeddb`
6.2.5 version as an SDK development dependency. It is excluded from runtime
bundles; real Chromium independently verifies browser persistence.
