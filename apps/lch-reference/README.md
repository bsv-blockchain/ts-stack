# BRC-170 LCH reference workbench

This open-source reference application exercises `@bsv/lch` and published [BRC-170](https://bsv.brc.dev/apps/0170) as a complete creator-to-player path.

The creator wizard encrypts a local asset into authenticated segments, stores detached ciphertext through a `ContentSink`, signs an inline Offer, and declares a two-wallet compensation split. The player performs a non-spending preflight, obtains a signed Quote, Payment Demands, short-lived Payment Readiness leases, and any Payee-authorized destinations, then stops at an explicit confirmation boundary. Confirmation refreshes readiness and asks a BRC-100 `WalletInterface` to create one BRC-105/BRC-29 transaction.

The two Payees intentionally exercise different settlement profiles. The composition controller uses `receipt-complete-v1`: its wallet must internalize the output and sign a Receipt. The recording controller uses `authorized-output-v1`: before payment it signs the exact BRC-29 output, accepted-transaction provider, and durable Delivery route. The default edge-case toggle takes that controller offline immediately after refreshed signed readiness. The issuer releases keys only after independently verifying the exact output, signed processor acceptance, and retention of the buyer-signed Delivery through recovery. The workbench can then bring the controller online, authenticate retrieval, internalize the same transaction once, and display the late Receipt. A provider outage or a strict offline Payee leaves one visible pending transaction; neither path creates a replacement payment.

The default browser workbench uses deterministic fixture wallets. They execute the same wallet methods and cryptographic derivations as the connected flow while constructing an input-free Atomic BEEF fixture. The collapsed server still routes issuer, recording-controller, composition-controller, evidence-provider, Delivery-store, and retrieval messages through distinct endpoints and verifies each signed role. Tests cover offline and late Payee recovery, provider outage and retry, strict-profile refusal, wrong output, insufficient evidence and retention, duplicate recovery, and conflicting accepted transactions. The Node reference server accepts an operator-provided wallet module, where each returned `WalletInterface` can be backed by a real BRC-100 wallet service. See [DEPLOYMENT.md](./DEPLOYMENT.md).

The profile runner covers all six initial usage profiles plus the authorized-output settlement profile. Its deterministic PCM fixture renders repeated placements, half- and double-speed time warps, reversal, and distortion. Every placement has a distinct C2PA ingredient binding under `whole-placement-v1`. The edit description is non-critical application metadata; ordinary editorial transforms do not change the License permission model or settlement semantics. A future mapping profile is needed only when a resolver needs deterministic selective mapping from a derivative part back to a source part.

## Run

```sh
pnpm --filter lch-reference-app dev
```

Build and run the HTTP reference server:

```sh
pnpm --filter lch-reference-app build
PORT=4173 LCH_PUBLIC_BASE_URL=http://127.0.0.1:4173 pnpm --filter lch-reference-app serve
```

The browser and server bundles incorporate `@bsv/sdk` and `@bsv/lch`. The new profile adds no dependency. The build copies the scoped `THIRD_PARTY_NOTICES.md` and exact `LICENSES/` archive into `dist/licenses/`; those files must remain alongside deployed copies.

Use [DEPLOYMENT.md](./DEPLOYMENT.md) to replace every fixture and in-memory
boundary, connect production wallets and content storage, separate financial
roles, add persistence and recovery, and validate a rollout. The broader
[production CHIRP and LCH guide](../../docs/guides/chirp-lch-production.md)
explains when to combine the protocols, provides copyable consumer flows, and
includes failure, security, observability, and agent checklists.
