# Local validation — unapproved shared overlay lookup draft

Date: 2026-09-04. Source base: `98734b07cf` on ts-stack main. All failure
injection used synthetic data and isolated local processes. No live wallet,
overlay, Kubernetes, DNS, discovery advertisement, secret or reputation state
was touched.

## Shared resolver revision: SDK 3.0.0 candidate

The standard `LookupResolver` now owns the shared implementation for every service
and every query API. The optional resolver/facilitator names are compatibility
aliases. This revision supersedes the original adapter-only scope below.

| Check | Result |
| --- | --- |
| Full SDK coverage suite | 164 suites, 5,998 tests, 1 snapshot passed |
| Coverage | Statements 94.32%, branches 86.49%, functions 95.06%, lines 95.23% |
| New standard-export regressions | 15 tests: non-KV services, all three query APIs, advisory cooldown recovery, total deadline including discovery, iterator cancellation, progressive recovery, invalid BEEF/txid hints, scoped reputation, and generic validator API |
| SDK build and workspace typecheck | Passed |
| Root health, lint and format | Passed; 42 projects, 34 public packages, zero contract findings/control errors |
| Packed artifact contract | Passed ESM/CJS, all conditional/wildcard exports, strict types, source maps and publint; includes the root LookupUnavailableError export |
| Exact-tarball browser contract | Passed Vite, esbuild and UMD |
| Main UMD | 554,559 raw bytes, below unchanged 555,000-byte limit |
| Property profile | 3 suites, 6 tests passed |
| Conformance parser | 76 files, 6,690 vectors, zero structure/parse errors; no new portable protocol claim |
| Metanet Docs candidate integration | Exact local 3.0.0 tarball, standard and optional imports verified; 49 files / 185 tests and frontend build passed |
| Gloss candidate integration | Same exact tarball, standard import verified; TypeScript build and 4 tests passed |
| Dependency audit | Still fails: 8 high, 2 moderate (2 existing ignored findings), unchanged dependency graph |

The original cooldown reproductions now assert successful recovery on the standard
resolver; their failing legacy behavior remains reproducible at commit `ff36b55`.
The shared tests exercise arbitrary `ls_custom`, identity, SHIP and KV service
names using the ordinary package export. Real loopback KV fault-injection tests
also run through the shared resolver and facilitator aliases in the full suite.
The default APIs now enforce the same core policies without a KV import.

Controlled fake-clock measurements: 250 ms recovered-host/fast-empty case,
2,000 ms healthy-plus-hung case for each API, and 1,600 ms total including
1,400 ms discovery. These are local deterministic measurements, not production
SLO data. Explicit iterator close cancels the remaining requests and leaves no
resolver timers. Service-specific proofs/currentness remain distinct from
transport completion.

The new default error/deadline/persistence contract is deliberately recorded as
an unapproved major candidate. Consumer manifests, locks, peer ranges, deployed
pins and compatibility adapters are unchanged; a future coordinated SDK 3 peer
migration is still required. Existing consumer preview commits are reused with
local extracted artifacts only. No artifact was published.

Commands: the same invariant checks listed below; SDK `test:coverage --runInBand`,
`test:property`; `node scripts/check-package-artifact.mjs packages/sdk --exports
PrivateKey,PublicKey,Transaction,Script,WalletClient,ProtoWallet,AuthFetch,IdentityClient,LookupResolver,LookupUnavailableError,RemittanceManager
--esm-only-entrypoints ./umd`; `node scripts/check-browser-package.mjs packages/sdk`;
`pnpm conformance`; `pnpm audit:security`; and each consumer's local test/build.

## Original adapter-only validation at `ff36b55` (historical)


| Check                                           | Result                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Frozen pnpm install, lifecycle scripts disabled | Passed                                                                                         |
| Workspace build                                 | Passed; local package/application artifacts only                                               |
| Repository health                               | Passed: 42 projects, 34 public packages, zero contract findings/control errors                 |
| Root lint and format                            | Passed                                                                                         |
| Workspace typecheck                             | Passed after building the workspace; fresh checkout first needed Verifast outputs              |
| SDK full coverage suite                         | 163 suites, 5,983 tests, 1 snapshot passed                                                     |
| SDK coverage                                    | Statements 94.30%, branches 86.41%, functions 95.09%, lines 95.20%                             |
| Existing SDK property profile                   | 3 suites, 6 tests passed                                                                       |
| SDK packed artifact contract                    | Passed ESM/CJS imports, conditional/wildcard exports, source maps, publint and type resolution |
| SDK exact-tarball browser contract              | Passed Vite, esbuild and UMD                                                                   |
| Main UMD payload                                | 554,942 raw bytes; unchanged 555,000-byte budget                                               |
| New root-cause/adapter tests                    | 59 tests across 7 suites, included in full SDK results                                         |
| Real loopback HTTP fault injection              | 5 cases passed: disabled, delayed, corrupt, stale and empty peers                              |
| Metanet Docs with local SDK artifact            | 49 test files, 185 tests and frontend build passed                                             |
| Metanet Docs lint                               | Zero errors; 10 existing React refresh warnings                                                |
| Gloss with local SDK artifact                   | TypeScript build and 4 tests passed                                                            |
| Security audit                                  | Failed on unchanged dependency graph; details below                                            |

Commands include `pnpm build`, `pnpm health:check`, `pnpm lint`,
`pnpm format:check`, `pnpm typecheck`, `pnpm --filter @bsv/sdk test:coverage
--runInBand`, `pnpm --filter @bsv/sdk test:property`,
`pnpm --filter @bsv/sdk pack:check`, `pnpm --filter @bsv/sdk test:browser`,
and `pnpm audit:security`. Tests never changed production state.

The new suites preserve three passing legacy reproductions and test the optional
adapter with real signatures, BEEF parsing and fixture-specific trusted Merkle
roots. Fake clocks establish the 800 ms fast-empty/data case, 2,000 ms degraded
host window and 2,400 ms delayed-discovery/retired-host case. HTTP tests use a
1,000 ms total budget and 300 ms per-host budget and assert success within the
total budget. These are controlled local measurements, not production SLO data.

## Audit and review limitations

`pnpm audit:security` reports 10 vulnerabilities: 8 high and 2 moderate, with 2
already governed ignored findings. High findings include the existing `fast-uri`
version beneath root AJV tooling and `toml` beneath docs-site's
`remark-mdx-frontmatter`. This branch has no dependency or lockfile change.
No advisory was suppressed and no quality threshold or bundle budget was raised.
The only baseline metadata change updates the SDK package version to its proposed
major version; security baselines and accepted findings are unchanged.

A public CI merge gate must not be represented as passing: the audit gate is
known to be blocked on this dependency graph, and the draft is explicitly not
ready for deployment. This task does not authorize publication or a separate
maintenance dependency migration.

The full suite's coverage threshold passed, but that is not a claim that all
requested behavior is implemented. Remaining work includes durable cross-tab and
restart pending-write recovery, cross-device uniqueness, a currentness/absence
protocol, verified history, production consumer wiring, real multi-tab browser
scheduling tests, independent portable conformance for any new protocol, and
focused mutation/adversarial resource testing. Read the companion design before
considering promotion.

## Consumer artifact verification

Consumer manifests, locks, production factories, host pins and compatibility
patches are unchanged. Local preview commits are:

- Metanet Docs: `a63e76a`, branch `codex/globalkv-reliability-integration`.
- Gloss: `01c6b7c`, branch `codex/globalkv-reliability-integration`.

The optional module was verified by directly importing
`@bsv/sdk/kvstore/reliable` from each consumer's dependency tree before testing.
Metanet Docs' normal no-save npm install hit an existing Tiptap peer conflict;
its first baseline test pass therefore did not use the candidate. That result
was discarded as candidate evidence. The local SDK tarball was then extracted
into its disposable `node_modules/@bsv/sdk`, imports were verified, and the full
suite/build rerun successfully. Gloss used the same locally packed artifact.

These preview commits remain local. Consumer PRs are deferred until an approved,
reproducible package input exists. The React preview tests failure-versus-absence
copy and a functioning Retry button; both consumers use the shared read session
for retained data and recovery. They do not switch production traffic.

## Human approval required for later work

Review the SDK draft and agree on the authority/fault model first. Complete the
protocol and remaining durability tests, then obtain explicit approval for each
package publication, server deployment and consumer migration. Preserve existing
pins and compatibility adapters during capability validation. A rollback uses
prior packages/configuration; v4 reputation does not delete legacy records.

Nothing was merged, published, deployed or changed in production. Network-ops
itself remains unchanged. This report is evidence for a draft proposal, not a
release approval or a claim that the entire requested end state is achieved.
