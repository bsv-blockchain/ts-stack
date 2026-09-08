# Identity overlay verification

This page records the bounded C01 source contract for identity results returned by the wallet toolbox. It is an inventory of the current implementation and its compatibility edges. It does not describe completion of the wider overlay reliability plan.

## Evidence boundary

An overlay lookup result is a host-supplied `LookupAnswer`. The resolver permits an output to carry a transaction id hint, but the hint is metadata rather than chain authority. C01 treats each output as untrusted evidence and verifies the BEEF bytes and selected output with the wallet's configured `ChainTracker` before decoding an identity certificate.

The shared transaction seam is [`verifyOverlayOutput`](../src/utility/verifyOverlayOutput.ts). It owns a copy of the BEEF bytes, derives the transaction id from those bytes, and rejects a supplied hint unless it matches that derived id. It checks the selected output and verifies the transaction graph through the caller's tracker. An unconfirmed branch must have ancestry; an input-free unconfirmed leaf cannot anchor an identity result. The preflight also rejects duplicate inputs and conflicting spends across distinct unconfirmed ancestors, while allowing a shared transaction to be traversed once. This is consistency of the supplied graph, not an external unspentness check. The generic helper has no network default, certificate policy, verdict cache, or identity-specific locking-key rule.

The wallet obtains the tracker through [`WalletServicesOptions.chainTracker`](../src/sdk/WalletServices.interfaces.ts) and [`Services.getChainTracker`](../src/services/Services.ts). A configured tracker is the wallet's chain authority. The utility functions [`queryOverlay`](../src/utility/identityUtils.ts), [`parseResults`](../src/utility/identityUtils.ts), and [`parseResults$`](../src/utility/identityUtils.ts) accept an explicit optional tracker; when it is missing they fail closed with an empty result. This keeps a caller from accidentally treating an overlay response as verified.

The identity parser then decodes the selected output as PushDrop, requires the subject-signed field payload to verify, requires `VerifiableCertificate.verify()` to return `true`, decrypts the public keyring, and requires nonempty decrypted fields. A cryptographic signature failure is already surfaced as an exception by [`ProtoWallet.verifySignature`](../../../sdk/src/wallet/ProtoWallet.ts), which the parser drops with the candidate. The earlier ignored boolean from certificate verification is therefore not an invalid-certificate bypass; C01 makes the success condition explicit while adding the missing transaction evidence checks. Candidate errors are not logged because parser/decryption exceptions may contain identity data.

## Standard identity envelope

The interoperable envelope is the one emitted by the default [`IdentityClientOptions`](../../../sdk/src/identity/types/index.ts): protocol ID `[1, 'identity']`, key ID `'1'`, token amount `1`, and output index `0`. [`IdentityClient.publiclyRevealAttributes`](../../../sdk/src/identity/IdentityClient.ts) creates the PushDrop output and broadcasts it to `tm_identity`.

The current [`IdentityTopicManager`](../../../../packages/overlays/topics/src/identity/IdentityTopicManager.ts) verifies the same subject-signed PushDrop fields with protocol `[1, 'identity']` and key ID `'1'`, then checks certificate validity and nonempty decrypted attributes. C01 matches that actual server contract. `IdentityClientOptions` exposes custom protocol and key values, but the current topic manager does not accept arbitrary values: a non-default protocol ID or key ID is a compatibility hazard and can cause the topic to reject the output. C01 does not widen topic acceptance.

There is no existing topic contract for comparing an identity certificate to an arbitrary `lockingPublicKey`, so C01 adds no such equality rule. The subject-signed envelope, certificate signature, successful decryption, and trusted-certifier policy remain the relevant checks.

## Cache and contact boundaries

The wallet's overlay evidence cache is a two-minute response cache in [`Wallet.ts`](../src/Wallet.ts). Cached BEEF is revalidated on every use with the current tracker and certificate checks. If any candidate is rejected, the query entry is evicted so a later call can fetch fresh evidence. The cache is not a chain verdict and does not change local contact behavior.

Local contacts are a separate wallet-owned source. [`Wallet.ts`](../src/Wallet.ts) synthesizes contact results with the local contact's subject/certifier relationship and local trust data. A contact hit may short-circuit the overlay path as before; it must retain local-contact provenance and must not be presented as an overlay SPV result. Contact lookup failures fall through to the network path.

## Compatibility inventory and limits

The public identity path spans the SDK wallet interfaces and clients, JSON and binary wallet transports, toolbox wallet managers, and [`IdentityClient`](../../../sdk/src/identity/IdentityClient.ts). C01 preserves those Promise method shapes and the `parseResults$` async-iterable shape. It does not change permission negotiation or pagination. The interface documentation says `seekPermission` defaults true, while the validator currently applies a false default; see [`Wallet.interfaces.ts`](../../../sdk/src/wallet/Wallet.interfaces.ts) and [`validationHelpers.ts`](../../../sdk/src/wallet/validationHelpers.ts). The wallet's current overlay calls also do not forward validated `limit` and `offset`, although the identity lookup service accepts them. These are compatibility characterization items for W00/W02, outside this C01 document.

The resolver currently validates only the shape of a txid hint in [`LookupResolver.ts`](../../../sdk/src/overlay-tools/LookupResolver.ts). Its aggregation deduplicates by the hinted or derived txid and output index, keeping the first answer, and its fast path trusts a nonempty hint ([`LookupResolver.ts`](../../../sdk/src/overlay-tools/LookupResolver.ts), [`LookupResolver.ts`](../../../sdk/src/overlay-tools/LookupResolver.ts)). C02 owns the first-wins raw resolver suppression and pending full txid sharing work. C01 verifies the evidence that reaches the wallet; it cannot recover an alternate candidate discarded before parsing.

The existing `ChaintracksChainTracker` still has its height-keyed root-cache and reorganization lifecycle. C01 makes no reorganization-safety claim; C03 covers that Chaintracks cache limitation and lifecycle work. C01 adds no workers, shared transaction jobs, response/graph budgets, or whole-attempt deadline. Large proofs still incur parsing and verification work on the calling runtime. These limits and canonical-context fencing require the later coordinator/runtime slices; no latency, reorganization safety, or deployment claim is made here.

## Requirement and verification mapping

The scoped source work supports requirement V1 (independent transaction evidence), the byte-binding portion of V2 (BEEF-derived txid must match any hint), and V5 (certificate success and trust policy). The planned characterization cases are T04 (false txid hint), T07 (confirmed/unconfirmed ancestry, scripts, values, and graph-internal conflicts), T09 (output/envelope/certificate validity), T10 (permission, cache, and local contacts), and T13 (Promise and pagination compatibility). This mapping is evidence for the C01 slice only; it is not a claim that the full verification plan has passed.

## Configuration and migration

This is a patch security correction in the 2.11.1 full, browser, and mobile
packages; the aggregate release-note candidate remains minor relative to the
recorded 2.10.4 published baseline. Wallet RPC and stored data need no migration.
Wallet builders keep their existing `Services` chain configuration. Its
`getChainTracker()` selects `options.chainTracker`, or wraps the configured
`options.chaintracks`; a configuration/availability error never becomes an
acceptance verdict. Use a chain source maintained independently of overlay hosts.

Direct utility callers previously supplied only an answer. They must now pass
their canonical chain source:

```ts
const tracker = await wallet.getServices().getChainTracker()
const certificates = await parseResults(answer, tracker)
```

Omitting the optional argument remains source-compatible but fails closed.
There is no bypass toggle. Failed candidate evidence evicts a wallet response
cache entry; failures never establish a permanent negative verdict for a txid.
Untrusted cached bytes may be shared within this wallet, but decrypted result
objects are rebuilt on each call and then passed through the existing trust
settings. The existing two-minute trust-settings snapshot policy is unchanged.

## Package size review

On 8 September 2026, the originating review task
`01a081b5-26d4-7ad1-8d85-243fe238d595` explicitly approved these measured C01
budget adjustments under
[`governance/browser-artifact-policy.json`](../../../../governance/browser-artifact-policy.json).
The policy requires a versioned source change, composition evidence, and explicit
review. All three published artifacts advance from 2.11.0 to 2.11.1. Mandatory
transaction, graph, and identity checks remain in the portable bundles.

Measurements used Node 24.15.0 and pnpm 10.33.2 on the same macOS host, with
base commit `2bc799a8d8e535242e6de2d305f426ce3975ea7b` extracted into a temporary
source tree and built against the same unchanged SDK and dependency graph.
`pnpm build` ran in each base/current client and mobile package. A temporary
copy of the platform checker printed every size instead of evaluating budgets:
`node /tmp/c01-measure-baseline.mjs browser`,
`node /tmp/c01-measure-baseline.mjs mobile`,
`node /tmp/c01-measure-platform.mjs browser`, and
`node /tmp/c01-measure-platform.mjs mobile`.
These were **measurements only, not passing platform gates**. The original
platform checker was not modified.

Each cell lists raw / gzip / Brotli bytes:

| Consumer | Base                              | C01                               | Reviewed maximum                  |
| -------- | --------------------------------- | --------------------------------- | --------------------------------- |
| Vite     | 1,692,309 / 399,380 / 312,207     | 1,694,805 / 400,062 / 312,426     | 1,696,000 / 401,000 / 314,000     |
| esbuild  | 1,320,184 / 363,792 / 291,500     | 1,322,211 / 364,400 / 291,926     | 1,324,000 / 365,000 / 293,000     |
| Metro    | 1,747,262 / 443,100 / 343,780     | 1,749,640 / 443,811 / 343,927     | 1,751,000 / 455,000 / 360,000     |
| Hermes   | 3,544,570 / 1,440,174 / 1,117,759 | 3,550,004 / 1,442,134 / 1,120,813 | 3,553,000 / 1,443,000 / 1,123,000 |

Raw growth is 2,496 / 2,027 / 2,378 / 5,434 bytes respectively (about
0.14–0.15%). Vite composition retains 106 modules and the same packages:
`@bsv/sdk`, `@bsv/wallet-toolbox-client`, `@noble/hashes`, `hash-wasm`, and `idb`.
The esbuild module count remains 173. No new dependency or platform-only import
was added. Shared wallet cache/fetch logic removes duplication; independent
verification and subject-envelope checks account for the added code. Only
exceeded dimensions changed, rounded to preserve comparable existing margins;
all other limits stay fixed. This is a reviewed security-feature payload change,
not an analysis exception. Original `test:browser` and `test:mobile` commands
remain the executable gates and are recorded separately in the delivery ledger.
