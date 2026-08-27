# @bsv/lch

Reference implementation of the draft BRC-170 Licensed Content Header protocol. It provides deterministic CBOR and object identifiers, `.lch` framing, segmented AES-256-GCM, BRC-77 signatures, BRC-78 key delivery, UHRP/CHIRP-aware content adapters, policy/profile checks, multilateral output matching, authority revocation validation, license storage, and whole-placement composition.

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

The typed client-side builders are `LCHBuyer`, `LCHMultipayBuyer`, `LCHHttpAcquisitionClient`, `validateQuote`, `createMultipayTransaction`, and `WalletBRC78KeyDelivery`. A player first builds and signs a License Request, preflights it, validates the signed Quote and each embedded Demand, and shows the exact total and split. After an explicit confirmation it creates one multilateral wallet transaction, delivers the Atomic BEEF and remittance coordinates to every Payee, collects signed Receipts, completes issuance, and verifies recovery of the resulting License.

`LCHMultipayBuyer` splits the irreversible and retryable stages deliberately. `createPayment` returns the Atomic BEEF and every signed Delivery immediately after `createAction`; persist that value before network delivery. Call `deliver` for each Payee and retain each Receipt, then call `complete`. After an ambiguous failure, retry those methods with the same funded payment—never call `createPayment` again for that Quote.

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

`LCHHttpServer` is a standard Fetch `Request`/`Response` handler, so it can be mounted in Node, edge, serverless, or test transports without framework coupling. Its deterministic-CBOR message types cover License Request preflight, quote, Payment Demand preflight, Payment Delivery, Payment Completion, and license recovery.

The executable creator/server/player example, connected-wallet module contract, CHIRP/UHRP storage substitutions, container build, and durable deployment topology are in [`apps/lch-reference`](../../../apps/lch-reference/README.md).

Application-specific catalogue, streaming index, royalty weighting, waveform, timeline, and social metadata belong in non-critical application data or separately registered profiles. The v1 whole-placement resolver supports repeats and arbitrary editorial transforms conservatively: any nonempty derivative selection activates the ingredient's complete declared source selection. Edit metadata does not alter permission or settlement semantics. A future mapping profile is needed only for deterministic selective mapping; an unknown mapping fails closed.

Server-side HTTPS resolution must provide an endpoint policy with a
public-address DNS resolver and an address-pinning connector. Browser
applications should use an equivalently constrained authenticated gateway
rather than treating a preflight DNS lookup as protection against rebinding.

See BRC-170 for the normative protocol. If this implementation and the BRC differ, the BRC is authoritative.

## License

This package is licensed under the [Open BSV License Version 6](./LICENSE.txt).
The npm artifact also carries a scoped [third-party notice](./THIRD_PARTY_NOTICES.md). The package incorporates no third-party source; its SDK and optional CHIRP peers retain their own license payloads.
