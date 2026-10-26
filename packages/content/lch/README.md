# @bsv/lch

Reference implementation of [BRC-170](https://bsv.brc.dev/apps/0170), the Licensed Content Header protocol. It provides deterministic CBOR and object identifiers, `.lch` framing, segmented AES-256-GCM, BRC-77 signatures, BRC-78 key delivery, UHRP/CHIRP-aware content adapters, policy/profile checks, multilateral output matching, authority revocation validation, license storage, and whole-placement composition.

The package keeps acquisition explicit. Inspecting or opening a header never spends money. Applications call preflight, quote, wallet payment, Payee delivery, completion, and recovery as separate steps. `LCHMultipayBuyer.createPayment` is the explicit transaction boundary; it delegates to `createMultipayTransaction`, which invokes the buyer wallet's `createAction`.

## Install

```bash
npm install @bsv/lch @bsv/sdk
# Optional for chirp: ciphertext locators:
npm install @bsv/chirp
```

## Getting started

```ts
import { LCHPublisher, LCHReader, MemoryContentSink, WalletBRC77Signer } from '@bsv/lch'

const signer = await WalletBRC77Signer.create({ wallet })
const storage = new MemoryContentSink()
const publisher = new LCHPublisher(signer)
const protectedAsset = await publisher.protect(bytes, {
  mediaType: 'audio/wav',
  name: 'loop.wav',
  rights: [
    { interest: 'sound-recording', holder: { name: 'Creator' }, controller: signer.identityKey }
  ],
  sink: storage
})

// An Offer is created after the Asset ID is known, then included in acquisition.
const published = await publisher.publish(protectedAsset, [{ mode: 'inline', offer }], false)
const reader = new LCHReader(storage)
const inspected = await reader.inspect(published.bytes)
const plaintext = await reader.decrypt(inspected, protectedAsset.keys)
```

Keep a publisher instance for its publication lifetime. It retains bounded
Encryption-ID and Key-ID duplicate detectors and fails closed if a broken or
injected random source repeats AES-GCM material across Assets; creating a fresh
publisher for every Asset discards that defense-in-depth history.
`publish()` also recomputes the Asset ID and revalidates the ciphertext and
complete Key-ID/CEK set immediately before signing, so a mutable protected
artifact cannot silently diverge between review and publication.

Offer validation requires an absolute HTTPS payment endpoint and rejects
literal private or loopback destinations. Local development can opt into one
exact loopback origin with `allowInsecureLocalPaymentEndpoint` when creating an
Offer and `allowInsecureLocalOrigins` when validating it; never derive that
allowance from a remotely supplied Offer.

## Acquisition and wallets

The typed client-side builders are `LCHBuyer`, `LCHMultipayBuyer`, `LCHHttpAcquisitionClient`, `validateQuote`, `createMultipayTransaction`, and `WalletBRC78KeyDelivery`. A player first builds and signs a License Request, preflights it, validates the signed Quote and each embedded Demand, and shows the exact total and split. After an explicit confirmation it creates one multilateral wallet transaction, obtains one profile-valid settlement proof per Demand, and completes issuance.

Version 0.2 removes the endpoint-only `quote` overload because an endpoint and
issuer key cannot bind the buyer to the advertised Asset, Policy, Agreement, or
key-delivery terms. Migrate from the 0.1 call:

```ts
await buyer.quote(endpoint, request, issuer, keyGrants)
```

to a verified signed Offer and the expected seller identity:

```ts
await buyer.quote(verifiedSignedOffer, request, expectedSeller, keyGrants)
```

The signed Offer supplies the payment endpoint after its signature, Asset ID,
Policy, Agreement, seller identity, and critical extensions are validated.
JavaScript callers that still pass a string fail before transport I/O. Persist
the returned plan and configure a profile-aware `agreementEvaluator` before
completion or recovery; neither an issuer signature nor the legacy endpoint
argument is authorization for substituted license terms.

Every versioned signed-object validator requires version 1 and rejects a
top-level `critical` extension by default. An application that fully implements
an extension must pass its exact identifier through
`supportedCriticalIdentifiers`; merely recognizing the identifier or retaining
unknown fields is not implementation. Thread the same set through buyer,
issuer, Payee, settlement, and recovery validation so no role silently assigns
different meaning to the signed bytes. `LCHReader` applies the same fail-closed
rule to Header and Asset critical identifiers; configure its option explicitly
when the reader implements an extension.

`LCHMultipayBuyer` splits the irreversible and retryable stages deliberately. Quote preparation obtains a short-lived signed Payment Readiness from every Payee, and `refreshReadiness` renews those leases before an explicit wallet confirmation. Its required key-grant expectation comes from the verified Asset encryption descriptor and the selected Offer key-delivery mechanism; use `{ type: 'none' }` only for a profile that returns no keys. `createPayment` refuses missing or expired readiness and returns the finalized Atomic BEEF and every signed Delivery immediately after `createAction`; persist that value before network delivery. “Finalized” means signed transaction bytes exist—it does not by itself claim broadcast, processor acceptance, or mining. Call `settleDelivery` for each Payee, retain the returned Receipt or authorized-output evidence, then call `complete` with both proof arrays. `settleDelivery` enters authorized-output fallback only when the Payee transport fails; a returned but invalid Receipt is a protocol failure and never triggers fallback. `complete` binds the License to the request, Quote, exact settlement evidence, and expected key periods before returning it. After an ambiguous failure, expose the transaction as pending settlement and retry those methods with the same funded payment—never call `createPayment` again for that Quote.

`LCHMultipayBuyer` requires an application-supplied `agreementEvaluator` before
it accepts any completed or recovered License. Legacy callers may still
construct a buyer without one, but License validation fails closed. The
buyer retains the verified signed Offer in its plan and invokes that evaluator
before either completion or recovery can return a License. The callback receives
the Offer, License Request, Quote, License, pinned Offer Policy reference, and
pinned Agreement reference. It must return `true` only after a profile-aware
ODRL comparison establishes that the Agreement grants the requested action and
Selection while preserving every accepted constraint, Prohibition, and Duty.
An issuer signature alone is not consent to substituted terms. The reference
application contains a deliberately strict evaluator for its supported policy
profile; other applications must implement the policy vocabulary they accept.
Quote segment ranges and the Asset encryption descriptor are validated before
the wallet boundary, and intrinsically ambiguous duplicate destinations are
rejected before `createAction`.

The Offer endpoint coordinates Quote, completion, and License recovery. Each Payment Demand carries its own Payee-selected endpoint and explicit settlement profile. `#receipt-complete-v1` is the baseline: the Payee must internalize its output and sign a Receipt before License issuance. `#authorized-output-v1` is an opt-in availability profile. Before payment, the Payee signs the exact BRC-29 suffix and locking script plus a transaction-evidence provider and durable Delivery provider. The buyer independently derives and compares that script before `createAction`. `settleDelivery` attempts ordinary Payee delivery first and, only for an authorized-output Demand, obtains signed processor acceptance and a signed retention acknowledgement when direct delivery fails. `collectAuthorizedOutputEvidence` exposes that fallback step separately for recovery orchestration. The issuer can release the License only after the complete bundle verifies. The Payee can later retrieve that exact signed Delivery and internalize it idempotently.

Those endpoints can be different origins, processes, operators, and wallet substrates; the issuer never becomes a payment proxy merely because it assembled the Quote. Silence, finalized Atomic BEEF, broadcast submission, or an unsigned storage response never satisfies either profile. Authorized-output settlement deliberately delegates availability and acceptance judgment to the identities named by the Payee, makes the exact destination more linkable, and may release keys before Payee-wallet internalization or mining. Use receipt-complete when those tradeoffs are unacceptable. An unavailable fallback provider leaves the existing transaction pending rather than enabling a weaker proof or a second payment.

`LCHAcquisitionTransport` is the injectable client boundary. Its default is `LCHHttpAcquisitionClient`; a message-box adapter can implement the same methods while preserving the signed objects, per-Demand routing, response authentication, persistence-before-fan-out rule, and idempotent recovery. Native asynchronous wire semantics remain profile work rather than hidden behavior in the core objects.

The receiving side uses `LCHPayee`, `WalletPaymentReceiver`, and `LCHHttpServer`. `WalletPaymentReceiver` verifies the buyer signature, Demand binding, recovery deadline, exact amount, and BRC-29-derived locking script. It then invokes the receiving Payee wallet directly:

```ts
const receiver = new WalletPaymentReceiver({
  wallet: payeeWallet,
  signer: payeeSigner,
  ledger: durablePaymentLedger
})

const receipt = await receiver.receive(signedDemand, signedDelivery)
```

The wallet call uses BRC-100 `internalizeAction` with the `wallet payment` protocol and exact BRC-29 remittance. The issuer has no implicit custody role: value goes to each identity named in the Payment Demands. The `PaymentLedger` interface makes redelivery idempotent and rejects a conflicting transaction for an already claimed Demand; horizontally scaled servers must back it with an atomic durable store.

Durable stores are untrusted persistence boundaries. Existing Receipts and
Payment Authorizations are reverified and rebound to the current signed Demand,
transaction, output, amount, identities, and validity window on every retry;
implementations must preserve those atomic claim/put semantics rather than
returning a cached object as authorization by itself.

`LCHMultipayBuyer.recover(payment, receipts, authorizedOutputs)` is the safe
recovery API. It requires the complete persisted funded acquisition and exact
settlement proofs, then applies the same issuer, Asset, Offer, subject,
Selection, Agreement-policy, fulfillment, and key-grant checks as `complete`.
The lower-level `recoverUnverified(endpoint, requestId)` methods deliberately
return an `UnverifiedLicenseResponse`; they are transport adapters only. A
Request ID cannot supply the missing trust context, so never unwrap or use that
response directly for key storage, content access, or authorization.

`LCHHttpServer` is a standard Fetch `Request`/`Response` handler, so issuer, Payee, evidence-provider, and Delivery-provider handlers can be mounted independently in Node, edge, serverless, message-box gateways, or tests without framework coupling. Its deterministic-CBOR message types cover License Request preflight, quote, Payment Demand readiness and authorization, direct Payment Delivery, transaction evidence, durable store and authenticated Payee retrieval, Payment Completion, and License recovery. `WalletAuthorizedOutputPayee`, `LCHSettlementService`, and the validation functions expose the same boundaries without HTTP coupling.

The executable creator/server/player example, connected-wallet module contract, CHIRP/UHRP storage substitutions, container build, and durable deployment topology are in [`apps/lch-reference`](../../../apps/lch-reference/README.md). The [production CHIRP and LCH guide](https://github.com/bsv-blockchain/ts-stack/blob/main/docs/guides/chirp-lch-production.md) adds end-to-end integration code, role ownership, persistence, recovery, security, observability, rollout, and an agent implementation contract.

The 0.1 publisher and reader accept bounded `Uint8Array` representations.
`UniversalContentSource` defaults to a 512 MiB maximum, and the complete
`resolve()`/`decrypt()` path assembles ciphertext in memory. CHIRP itself can
stream verified ranges, but exposing LCH plaintext progressively requires a
segment-aware adapter that authenticates complete encryption records and
enforces the licensed selection; that adapter is outside the 0.1 API. Configure
an explicit application limit and do not treat raw CHIRP ciphertext chunks as
authenticated plaintext.

Ranged CHIRP reads must return exactly the requested number of bytes. Ranged
HTTPS reads additionally require an exact `206 Content-Range` and body length;
a host that ignores or shifts the range fails closed before segment
authentication. Deterministic CBOR applies its 100,000-item and 16 MiB limits
cumulatively at the primitive boundary, not only after HTTP or framing.

For `uhrp:` locators, `UniversalContentSource` tries each unique resolved host
until one returns a valid bounded response. Every candidate still passes the
endpoint policy independently; an unavailable or rejected host does not weaken
SSRF, redirect, or address-pinning checks for the next candidate.

Application-specific catalogue, streaming index, royalty weighting, waveform, timeline, and social metadata belong in non-critical application data or separately registered profiles. The v1 whole-placement resolver supports repeats and arbitrary editorial transforms conservatively: any nonempty derivative selection activates the ingredient's complete declared source selection. Edit metadata does not alter permission or settlement semantics. A future mapping profile is needed only for deterministic selective mapping; an unknown mapping fails closed.

`walkComposition` retains each direct placement, expands the same Asset and
normalized Selection once in a shared provenance DAG, and applies cycle, depth,
and total traversal bounds. Duty fulfillment and aggregation still follow each
ODRL Duty UID and policy rule; provenance-node or Payee equality alone never
deduplicates payment obligations.

`validateC2PAComposition` requires exact bidirectional ingredient coverage:
every Composition Record ingredient must exist in C2PA and every C2PA
ingredient returned by the adapter must exist in the record. A composition
loader must return the exact requested Asset ID and normalized Selection.
Treat adapter/loader output as untrusted evidence, not permission to omit a
source work.

The exported `permits()` helper intentionally recognizes only an exact,
unconditional ODRL permission containing `action` and `target`. It returns
`false` for constraints, Duties, identity scoping, and extended rule fields;
those require a profile-aware evaluator that verifies all operands and Duty
settlement. Never use `permits()` to bypass a rule it does not implement.

Server-side HTTPS resolution must provide an endpoint policy with a
public-address DNS resolver and an address-pinning connector. Browser
applications should use an equivalently constrained authenticated gateway
rather than treating a preflight DNS lookup as protection against rebinding.
Endpoint DNS, connection, and response work has a finite 30-second default
deadline; deployments may choose a shorter value and may not configure more
than two minutes. Custom resolvers and connectors receive or are raced against
that same deadline and should honor the supplied abort signal directly.
Literal-address checks operate on the URL parser's canonical hostname,
including hexadecimal IPv4-mapped and transition IPv6 forms, and fail closed
for non-global IANA special-purpose ranges. A public redirect may not enter an
allowlisted local-development origin; local origins are explicit starting
trust decisions, not redirect targets selected by public content.

## Production integration gate

Before enabling real purchases, replace fixture wallets, memory content and
license stores, in-process issuer state, Payee ledgers, evidence claims, and
Delivery retention with durable role-scoped implementations. Persist the
funded transaction before fan-out, test recovery by Request ID, keep every
Payee independently routable, pin server connections against DNS rebinding,
and retain signed state through `recoveryUntil`. The complete checklist and
failure matrix are in the [production guide](https://github.com/bsv-blockchain/ts-stack/blob/main/docs/guides/chirp-lch-production.md).

See [BRC-170](https://bsv.brc.dev/apps/0170) for the normative protocol. If this implementation and the BRC differ, the BRC is authoritative.

## License

This package is licensed under the [Open BSV License Version 6](./LICENSE.txt).
The npm artifact also carries a scoped [third-party notice](./THIRD_PARTY_NOTICES.md). The package incorporates no third-party source; its SDK and optional CHIRP peers retain their own license payloads.
