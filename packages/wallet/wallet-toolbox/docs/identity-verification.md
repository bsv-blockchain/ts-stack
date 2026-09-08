# Identity overlay verification

This page records the current C01, C02, and C03 source contract for identity
results returned by Wallet Toolbox. The implementation and its tests remain
under review; this page is not a claim that the wider verification plan or
release gates have completed.

## Evidence boundary

An overlay result is a host-supplied `LookupAnswer`. A host TXID hint and
`context` are metadata, never chain authority. [`queryOverlayEvidence`](../src/utility/identityUtils.ts)
copies the BEEF and context bytes received through the additive resolver
`onEvidence` callback. Resolver callback intake defaults to 512 outputs and
16 MiB per query and accepts `evidenceLimits: { maxOutputs?, maxBytes? }` as
configurable local policy. It uses a 300 ms identity grace window. Older or
custom resolvers that do not invoke the callback remain usable through the
legacy output-list fallback.

Direct `queryOverlayEvidence` callers can configure
`{ candidateBytes?, retainedBytes?, outputs? }`. To admit larger valid
evidence, pass matching byte limits to both this intake option and the third
`IdentityEvidenceVerifier` constructor argument (`TransactionEvidenceLimits`).
The resolver and verifier limits are separate admission boundaries and are not
consensus limits.

[`TransactionEvidenceCoordinator`](../../../sdk/src/transaction/TransactionEvidenceCoordinator.ts)
parses the owned bytes, derives the selected transaction ID, compares any
supplied hint, checks the selected output, validates the complete unconfirmed
graph, and performs fresh canonical-root checks through the caller's
`ChainTracker`. It checks source transaction/value/script bindings, source TXID
consistency, duplicate spent outpoints, input/script limits, and rejects an
unconfirmed zero-input leaf. A successful result identifies a transaction
output and locking script; it does not establish service relevance, current
unspentness, ownership, or freshness.

The coordinator's `chainNamespace` and `policyId` are explicit caller-owned
trust context. An optional synchronous
`ChainTracker.getVerificationContext(): string | number` is a provider,
policy, or recovery-generation marker. The optional
`getVerificationContextToken(signal?)` obtains a fresh trusted tip/context
token and brackets canonical-root and height checks. Chaintracks and local
adapters include monotonic reorganization/reset epochs and fence reset entry
and failure paths. `LocalChainTracker` tokens cover only the providers
participating in the current attempt: remote-only uses fallback identity,
local-primary uses local identity. An unused provider cannot stand in, and a
missing participating identity fails closed. Built-in remote ChainTracks
clients advertise reorg-event capability explicitly; method presence is not
capability. `Services.getChainTracker()` publishes one coalesced wrapper
before yielding. A remote tip equality read cannot detect an unobserved ABA
transition, and a token over multiple sources is not an atomic multi-source
snapshot. Canonical roots and observed heights remain dependencies that are
rechecked on each use, including positive-cache reuse. Existing trackers may
omit either optional method and may ignore optional abort signals.

`EvidenceScriptWork` in the SDK now shares bounded script work by a binding that
covers the actual transaction, all input source-output bytes and values, and
script policy/backend parameters. The binding is transaction-wide rather than
an input-index-only key. A cache hit can skip cryptographic script execution
only. It still performs source/value binding, complete graph traversal,
canonical chain calls, and policy/context checks. Non-batch individual
executions preserve each entry's fulfilled or rejected result so a failed
sibling cannot reject a successful shared ancestor. Only a backend batch-level
failure rejects the whole batch. Non-abortable backend work remains counted
until its actual promise settles, and in-flight owners are isolated. A normal
block arrival before the next reuse does not erase exact cryptographic script
work when its transaction/source/policy binding remains valid; canonical roots
and fresh context are still checked.

## Identity envelope

The interoperable identity output is the standard subject-signed PushDrop
created by [`IdentityClient.publiclyRevealAttributes`](../../../sdk/src/identity/IdentityClient.ts):
protocol ID `[1, 'identity']`, key ID `'1'`, token amount `1`, and output index
`0`. [`IdentityTopicManager`](../../../../packages/overlays/topics/src/identity/IdentityTopicManager.ts)
checks the same protocol and key, then certificate validity and nonempty
attributes. `IdentityClientOptions` exposes custom protocol and key values, but
the current server topic does not accept arbitrary values; custom values remain
a compatibility characterization item and C01 does not widen server
acceptance.

The parser checks the subject signature, requires `VerifiableCertificate.verify()`
to return `true`, decrypts the fields, and requires nonempty decrypted fields.
`ProtoWallet.verifySignature` throws on a cryptographic failure today; the
parser catches and rejects that candidate. C01 does not claim an invalid
certificate can bypass this throw. There is no existing topic contract for an
arbitrary `lockingPublicKey` equality rule, so none is added.

## Cache and contact boundaries

The wallet keeps three distinct boundaries:

- Transaction evidence is revalidated through the current chain tracker on
  every use. Coordinator positive results are bounded by configurable generic
  SDK limits, including 128 entries, 16 MiB retained bytes, and 60 seconds.
- Decrypted certificate JSON is wallet-owned and copied on return. Its cache is
  bounded at 2 MiB, 128 entries, and 60 seconds.
- Raw overlay lookup receipts are copied into a wallet cache bounded at 32
  queries, 16 MiB, and 120 seconds. A rejected or incomplete parse evicts that
  query entry so a later call can fetch again.

The wallet obtains the tracker from `getServices().getChainTracker()` and
reuses the configured instance. Direct [`queryOverlay`](../src/utility/identityUtils.ts),
`parseResults`, and `parseResults$` calls fail closed when no tracker is
provided. [`verifyOverlayOutput`](../src/utility/verifyOverlayOutput.ts)
requires an explicit tracker. Local contacts remain a separate wallet-owned
source and retain their existing short-circuit and trust behavior; contact
results must retain local provenance and are not overlay SPV results. Invalid
candidate evidence is dropped, while typed `limit` and `timeout` outcomes
propagate to the wallet caller instead of becoming a definitive empty result.

## Compatibility characterization

C01, C02, and C03 preserve existing Promise and `parseResults$` async-iterable
shapes. The resolver's `onEvidence` callback is optional and additive. Legacy
resolver answers continue to aggregate by TXID/output index with first-wins
suppression; a host hint is only a resolver fast path and must be re-derived
and checked by security-sensitive consumers. The callback is the bounded path
for consumers that need each host receipt before that suppression. Existing
2-second lookup and 5-second tracker-wait defaults remain unchanged.

Permission negotiation and pagination are unchanged. The interface
characterization still records that documentation says `seekPermission`
defaults to true while the validator currently applies false. Identity lookup
also retains the existing limit/offset validation and forwarding
characterization; this evidence work does not silently change either contract.

The standard topic envelope characterization and custom `IdentityClientOptions`
behavior above remain required for interoperability. No arbitrary locking-key
equality rule is implied. Chaintracks and local adapters now expose monotonic
reorganization/reset epochs and fence reset lifecycle races, including reset
ownership checks after disposal and before a destructive hook. Remote tip
equality still cannot detect an unobserved ABA transition, and no adapter token
provides an atomic multi-source snapshot. C03 therefore makes no general
reorganization-safety claim.

## Usage

Wallet callers use the existing Services configuration:

```ts
const tracker = await wallet.getServices().getChainTracker()
const certificates = await parseResults(answer, tracker)
```

Omitting the utility tracker remains source-compatible but returns no verified
overlay identities. There is no bypass toggle. Wallet RPC shapes, stored data,
permission defaults, and pagination behavior require no migration from this
source work.

On browser and React Native runtimes, `parseResults$` cooperatively yields
between certificates. This is a current-runtime scheduling behavior, with no
worker, throughput, latency, resource-isolation, or deployment guarantee.
C04/C05 work and any whole-plan completion claim remain future scope.

## Requirement and verification mapping

The scoped source supports V1 (independent transaction evidence), the
byte-binding portion of V2 (BEEF-derived TXID versus any hint), and V5
(certificate success and trust policy). T04, T07, T09, T10, and T13 remain the
relevant characterization cases for false hints, graph and anchor checks,
envelope/certificate validity, permissions/cache/contacts, and Promise/
pagination compatibility. The synthetic shared-ancestor fixture is 556 BEEF
bytes with three reachable transactions, three inputs, and 314 serialized
script bytes; two child graphs produce three actual script executions. Current
tests are evidence for these slices only; validation is not final until the
required package and consumer checks pass.

## Historical C01 bundle measurements

The following measurements are retained as historical C01 evidence for the
2.11.1 artifacts. They are measurements only, not passing platform gates and
not a release decision. C02/C03 source changes require fresh package and
consumer validation.

Measurements used Node 24.15.0 and pnpm 10.33.2 on the same macOS host, with
base commit `2bc799a8d8e535242e6de2d305f426ce3975ea7b` extracted into a temporary
source tree and the same SDK/dependency graph. A temporary copy of the
platform checker printed each size instead of evaluating budgets. The original
checker was not modified.

Each cell lists raw / gzip / Brotli bytes:

| Consumer |                              Base |                               C01 |                  Reviewed maximum |
| -------- | --------------------------------: | --------------------------------: | --------------------------------: |
| Vite     |     1,692,309 / 399,380 / 312,207 |     1,694,805 / 400,062 / 312,426 |     1,696,000 / 401,000 / 314,000 |
| esbuild  |     1,320,184 / 363,792 / 291,500 |     1,322,211 / 364,400 / 291,926 |     1,324,000 / 365,000 / 293,000 |
| Metro    |     1,747,262 / 443,100 / 343,780 |     1,749,640 / 443,811 / 343,927 |     1,751,000 / 455,000 / 360,000 |
| Hermes   | 3,544,570 / 1,440,174 / 1,117,759 | 3,550,004 / 1,442,134 / 1,120,813 | 3,553,000 / 1,443,000 / 1,123,000 |

The historical C01 result measured raw growth of 2,496 / 2,027 / 2,378 /
5,434 bytes for Vite, esbuild, Metro, and Hermes respectively. The C01
composition retained the same dependencies and did not add a platform-only
import. The original `test:browser` and `test:mobile` commands remain the
executable gates for any current release evidence.
