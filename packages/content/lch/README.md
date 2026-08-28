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

## Acquisition and wallets

The typed client-side builders are `LCHBuyer`, `LCHMultipayBuyer`, `LCHHttpAcquisitionClient`, `validateQuote`, `createMultipayTransaction`, and `WalletBRC78KeyDelivery`. A player first builds and signs a License Request, preflights it, validates the signed Quote and each embedded Demand, and shows the exact total and split. After an explicit confirmation it creates one multilateral wallet transaction, obtains one profile-valid settlement proof per Demand, completes issuance, and verifies recovery of the resulting License.

`LCHMultipayBuyer` splits the irreversible and retryable stages deliberately. Quote preparation obtains a short-lived signed Payment Readiness from every Payee, and `refreshReadiness` renews those leases before an explicit wallet confirmation. `createPayment` refuses missing or expired readiness and returns the finalized Atomic BEEF and every signed Delivery immediately after `createAction`; persist that value before network delivery. “Finalized” means signed transaction bytes exist—it does not by itself claim broadcast, processor acceptance, or mining. Call `settleDelivery` for each Payee, retain the returned Receipt or authorized-output evidence, then call `complete` with both proof arrays. After an ambiguous failure, expose the transaction as pending settlement and retry those methods with the same funded payment—never call `createPayment` again for that Quote.

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

Application-specific catalogue, streaming index, royalty weighting, waveform, timeline, and social metadata belong in non-critical application data or separately registered profiles. The v1 whole-placement resolver supports repeats and arbitrary editorial transforms conservatively: any nonempty derivative selection activates the ingredient's complete declared source selection. Edit metadata does not alter permission or settlement semantics. A future mapping profile is needed only for deterministic selective mapping; an unknown mapping fails closed.

Server-side HTTPS resolution must provide an endpoint policy with a
public-address DNS resolver and an address-pinning connector. Browser
applications should use an equivalently constrained authenticated gateway
rather than treating a preflight DNS lookup as protection against rebinding.

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
