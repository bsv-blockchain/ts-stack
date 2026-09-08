# LCH reference deployment

## Roles and data flow

```mermaid
flowchart LR
  C[Creator wizard] -->|plaintext + rights interests| I[Issuer service]
  I -->|ciphertext| H[CHIRP / UHRP / HTTP content hosts]
  I -->|detached LCH + signed Offer| P[Player]
  P -->|signed License Request| I
  I -->|signed Quote + Demands| P
  P -->|createAction: one Atomic BEEF| BW[Buyer BRC-100 wallet]
  BW -->|BRC-29 output A| WA[Recording-controller wallet]
  BW -->|BRC-29 output B| WB[Composition-controller wallet]
  P -->|signed Payment Delivery| DA[Drummer delivery service]
  P -->|signed Payment Delivery| DB[Composer delivery service]
  P -->|authorized Delivery| DS[Durable Delivery provider]
  P -->|exact Atomic BEEF| TE[Transaction evidence provider]
  DA -->|internalizeAction| WA
  DB -->|internalizeAction| WB
  DS -->|authenticated late retrieval| DA
  TE -->|signed accepted evidence| P
  DA -->|signed Receipt| P
  DB -->|signed Receipt| P
  P -->|Atomic BEEF + one proof per Demand| I
  I -->|signed License + BRC-78 grants| P
  P -->|authenticated range reads| H
```

Money is received by the Payee wallets named in the signed Payment Demands. `WalletPaymentReceiver` derives the expected receiving key with BRC-29, validates the exact finalized output, and calls that Payee wallet's BRC-100 `internalizeAction`. The issuer only receives value when it is explicitly one of the Payees. The reference split is 7 satoshis to the recording controller and 5 satoshis to the composition controller. Under authorized-output settlement, License issuance can precede the Payee wallet call, but the value is still locked to the exact Payee-derived script; the durable provider retains the Delivery so that wallet can internalize the same output later.

The issuer endpoint is `${PUBLIC_BASE_URL}/api/lch`. The two reference Payees deliberately publish different delivery paths, `${PUBLIC_BASE_URL}/api/lch/payees/recording` and `${PUBLIC_BASE_URL}/api/lch/payees/composition`. The authorized-output fixture also exposes `${PUBLIC_BASE_URL}/api/lch/evidence`, `${PUBLIC_BASE_URL}/api/lch/delivery-store`, and `${PUBLIC_BASE_URL}/api/lch/delivery-retrieval`. They share a process and fixture issuer identity only to keep every role runnable and inspectable. A deployed Demand can name `https://payments.drummer.example/lch`, authorize `https://availability.drummer.example/lch`, and use `https://processor.example/evidence`, while the downstream work uses `https://licenses.publisher.example/lch`. None of those origins receives or controls another role's wallet merely because the evidence appears in one completion.

`receipt-complete-v1` keeps the narrowest trust boundary: no License until the Payee wallet validates, internalizes, and signs. `authorized-output-v1` improves post-payment availability by letting the Payee pre-authorize an exact destination plus independent evidence and storage providers. It exposes more linkable metadata, depends on those providers, accepts processor policy before mining, and can release keys before wallet internalization. An offline Payee without that explicit Authorization remains pending. Production UIs should present that choice to the Payee when configuring its Demand service, not silently select fallback for buyers.

## HTTP surface

The executable Node server exposes:

| Method | Path                          | Purpose                                                                                       |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                 | Wallet mode and acquisition endpoint                                                          |
| `POST` | `/api/assets`                 | Creator publication input (`name`, `mediaType`, base64 bytes); returns IDs and `lchBase64url` |
| `POST` | `/api/lch`                    | Issuer preflight, Quote, completion, and recovery                                             |
| `POST` | `/api/lch/payees/{interest}`  | Independently routed Payee preflight and Payment Delivery                                     |
| `POST` | `/api/lch/evidence`           | Exact-transaction evaluation and signed accepted evidence                                     |
| `POST` | `/api/lch/delivery-store`     | Durable signed Delivery storage and retention acknowledgement                                 |
| `POST` | `/api/lch/delivery-retrieval` | Payee-signed authenticated retrieval of its stored Delivery                                   |
| `GET`  | `/content/{sha256}`           | Detached ciphertext, including one HTTP byte range                                            |
| `GET`  | `/*`                          | Reference workbench and third-party notices                                                   |

The endpoints accept only their role-appropriate exact media types implemented by `LCHHttpServer`. Bodies are bounded and error responses use stable LCH error codes. Sending a drummer Demand to the composition endpoint, a Delivery to the evidence endpoint, or a retrieval request signed by another identity fails even in the collapsed fixture topology.

Publication example:

```sh
curl -H 'content-type: application/json' \
  --data '{"name":"clip.wav","mediaType":"audio/wav","bytesBase64":"..."}' \
  https://lch.example/api/assets
```

## Wallet module

Without `LCH_WALLET_MODULE`, the server reports `walletMode: "fixture"`. A connected deployment sets it to a self-contained ESM module exporting:

```js
export async function createLCHWallets() {
  return {
    issuerWallet: await openBRC100Wallet('issuer'),
    recordingWallet: await openBRC100Wallet('recording-controller'),
    compositionWallet: await openBRC100Wallet('composition-controller')
  }
}
```

Every value must implement the BRC-100 `WalletInterface`. The issuer wallet signs Offers, Quotes, Licenses, and BRC-78 key envelopes. The two Payee wallets sign their Demands and Receipts and receive funds through `internalizeAction`. A player supplies its own `WalletClient` or other `WalletInterface` to `ReferenceLCHClient`; its `createAction` is the only transaction-creation boundary.

The module belongs in the operator's secret-bearing runtime, not in the public image. It may open local wallet-toolbox instances, connect to separately isolated BRC-100 wallet services, or wrap another conforming wallet substrate. Run each financial role with an independently controlled identity in deployments that require separate accounting or authority. A federated deployment normally runs a separate wallet module and Payment Ledger beside each Payee endpoint rather than loading every wallet into the issuer process.

## Content storage

`ReferenceContentStore` keeps ciphertext in process so the complete protocol can run with no external dependency. A deployed issuer replaces it at the `ContentSink`/`ContentSource` boundary:

- `CHIRPContentSink` publishes chunked, merklized ciphertext and returns a `chirp://` locator.
- `UHRPContentSink` preserves the existing UHRP publication path.
- `UniversalContentSource` resolves CHIRP, UHRP, and bounded HTTPS locators and verifies the exact ciphertext digest and length declared by the LCH Asset Body.

The LCH header, Offer, Quote, License, and content locator remain independent of which conforming host retains the ciphertext. Multiple complete-host locators can provide redundancy. A current BRC-167 UHRP root advertisement always means complete closure hosting; partial CHIRP coverage requires a future coverage profile and must not be represented as an ordinary complete-host advertisement.

## Reference boundaries to replace

The server's protocol handlers are reusable, but its default state is deliberately
visible and process-local. `/api/health` reports both `walletMode` and
`contentAdapter` so an operator can reject fixture configuration during rollout.

| Boundary                             | Reference behavior                                                | Durable deployment                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Wallets                              | Deterministic fixture wallets unless `LCH_WALLET_MODULE` is set   | Independent production BRC-100 wallet per financial role                                                           |
| Ciphertext                           | `ReferenceContentStore` and `/content/{sha256}` in process memory | `CHIRPContentSink`, `UHRPContentSink`, or an application `ContentSink`; bounded `UniversalContentSource` for reads |
| Assets and Offers                    | In-process maps                                                   | Transactional asset, Offer, policy, wrapped-CEK, and locator records                                               |
| Requests, Quotes, Licenses, recovery | In-process maps                                                   | Transactional issuer store indexed by Request ID through `recoveryUntil`                                           |
| Payment Ledger                       | Receiver default is process-local                                 | Atomic durable Demand-to-transaction claim shared by Payee replicas                                                |
| Authorizations and evidence          | In-process claims                                                 | Atomic Authorization-to-transaction claims with signed policy results                                              |
| Delivery retention                   | In-process Delivery map                                           | Durable exact bytes, authenticated retrieval, expiry enforcement, backup, and restore                              |
| Browser license store                | Workbench state                                                   | `IndexedDBLicenseStore` or an application store with protected key material                                        |

Do not expose `/api/assets` until its publication input is authenticated,
authorized, rate-limited, and connected to durable content and issuer stores.
The route accepts base64 input for interoperability convenience; a large-media
service should stream or stage plaintext through a bounded creator workflow and
send only ciphertext to storage providers.

## Deployment shapes

The single-process server is the smallest executable topology. It contains the static workbench, issuer handlers, independently routed Payee handlers, and reference content store. It is appropriate for protocol development and interoperability testing.

A durable topology separates five concerns:

1. Stateless issuer/API replicas terminate the Offer endpoint and persist Requests, Quotes, completion state, Licenses, and wrapped content-encryption keys.
2. Every Payee operates its signed Demand endpoint, atomic Payment Ledger, Demand and Authorization state, and BRC-100 receiving wallet independently.
3. Authorized Delivery providers atomically store exact signed Deliveries through their promised recovery deadlines; evidence providers atomically bind each Authorization to one accepted transaction under the named policy.
4. The buyer persists the funded Atomic BEEF, signed Deliveries, Receipts, Authorizations, and fallback evidence before fan-out and until License recovery completes or `recoveryUntil` passes.
5. CHIRP/UHRP providers retain ciphertext; the issuer retains only locators and verified metadata.

The Payment Ledger and Authorization-to-transaction claims must be atomic across replicas. The same Demand and transaction must return the same Receipt or evidence; a second transaction for that Demand or Authorization must fail. Stored Deliveries must survive process and zone loss through `availableUntil`. Content-encryption keys and wallet credentials require encryption at rest, access separation, backup, rotation, and audit controls appropriate to the deployment.

The reference client records the wallet result as **finalized** only. The initial authorized-output evidence provider can separately sign **accepted** under `signed-processor-acceptance-v1`; it does not claim broadcast or mined state. A mined profile needs explicit SPV evidence. If direct and authorized fallback delivery fail after finalization, the application retains the transaction and all partial proofs and presents a pending settlement through `recoveryUntil`; it does not offer a second purchase action.

`LCHAcquisitionTransport` lets a buyer route those same operations through an application-owned asynchronous inbox or message-box adapter. The BRC-170 v1 portable wire binding remains deterministic-CBOR HTTP. A gateway can enqueue internally while preserving the exact acknowledgement, identity, retention, and recovery contract. A native message-box protocol needs a separately registered profile defining addressing, authentication, correlation, reply polling, expiry, retention, and replay behavior; the adapter cannot silently replace signed Deliveries, Receipts, Authorizations, or provider evidence.

## Runtime configuration

| Variable                   | Default                    | Production meaning                                         |
| -------------------------- | -------------------------- | ---------------------------------------------------------- |
| `PORT`                     | `4173`                     | Container listener port                                    |
| `LCH_PUBLIC_BASE_URL`      | `http://127.0.0.1:${PORT}` | Exact public HTTPS origin used in every generated endpoint |
| `LCH_STATIC_DIR`           | Built `dist/` directory    | Workbench and notice files served by the Node adapter      |
| `LCH_WALLET_MODULE`        | Unset, fixture mode        | Secret-mounted ESM wallet factory described above          |
| `LCH_RECORDING_SATOSHIS`   | `7`                        | Demonstration recording-controller amount                  |
| `LCH_COMPOSITION_SATOSHIS` | `5`                        | Demonstration composition-controller amount                |

The two amount variables configure the fixed demonstration policy, not a
catalogue pricing system. Production applications should derive signed duties
and Demands from their durable rights and Offer records. If the public origin
changes, issue new objects that name the new endpoints; a proxy rewrite cannot
change already signed endpoint values.

Terminate TLS at a trusted ingress, preserve request bodies byte-for-byte,
bound request and response time, and route each financial role to the process
that owns its identity and ledger. CORS headers allow browser transport but do
not authenticate creators, buyers, Payees, providers, or operators.

## Container reference

Build from the TS Stack repository root:

```sh
docker build -f apps/lch-reference/Dockerfile -t lch-reference .
docker run --read-only --tmpfs /tmp -p 4173:4173 \
  -e LCH_PUBLIC_BASE_URL=https://lch.example \
  -e LCH_WALLET_MODULE=/run/lch-wallets/operator-wallets.mjs \
  -v /operator/lch-wallets:/run/lch-wallets:ro \
  lch-reference
```

Terminate TLS at the ingress, set `LCH_PUBLIC_BASE_URL` to the public HTTPS origin, and restrict publication to authenticated creator/admin traffic before exposing `/api/assets`. The reference route deliberately contains no account system because creator authentication is an application policy, not an LCH wire object.

The image does not include a durable database or CHIRP server. Mounting a real
wallet module changes `walletMode` but does not replace the memory stores. An
operator can use the container unchanged for conformance and interoperability,
or use the Fetch-compatible handlers and storage interfaces in an
application-specific service that supplies the durable boundaries above.

## Rollout and rollback

1. Build and test the exact source commit and retain `dist/licenses/` with the
   browser and server artifacts.
2. Provision durable stores, CHIRP/UHRP retention, independent wallet modules,
   role credentials, endpoint DNS, TLS, backups, and expiry/renewal monitors.
3. Deploy without public publication traffic. The stock workbench's `/api/health`
   must report `contentAdapter: "reference-memory"`; it cannot satisfy a durable
   production readiness gate. A production service built from these handlers must
   expose its own health contract and verify connected wallets, durable issuer and
   settlement stores, and its configured CHIRP/UHRP content sink and source before
   accepting publication or purchase traffic.
4. Publish and retrieve a small detached LCH, verify the CHIRP closure, and run
   one acquisition through every enabled settlement profile.
5. Simulate a lost completion response and recover by Request ID. Restart the
   issuer, each Payee, and providers; then retrieve and internalize a retained
   Delivery exactly once.
6. Enable creator traffic, then buyer traffic, while watching pending
   settlement, conflicting-claim, content-hash, wallet, retention, and recovery
   signals.

For rollback, stop new Quotes and creator publication first. Keep the old
issuer, Payee, evidence, Delivery, and content endpoints available through the
latest outstanding `recoveryUntil` and storage retention deadlines. Never roll
back by discarding funded buyer state or by pointing signed objects at a new
origin. Restore the exact compatible service and durable data, complete or
recover existing Requests, then change catalogue traffic to newly issued
Offers.

The repository-wide [production CHIRP and LCH guide](../../docs/guides/chirp-lch-production.md)
adds consumer code, persistence ownership, failure handling, security,
observability, conformance, and agent integration checklists.
