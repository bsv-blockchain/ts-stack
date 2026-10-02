# Authenticated private acquisition and recovery

BRC-195 acquisition exchanges a retained right to private application material
for one explicitly selected payment. Catalogue browsing remains a separate,
uncharged lookup. A seller first retains the exact acquisition request, verified
listing, capability, price, release policy and material. It can then return an
authenticated BRC-105 challenge. Receiving a candidate payment does not itself
prove acceptance, wallet credit or entitlement to disclose the material.

Use the Node-only `@bsv/output-knowledge/private/node` entry for durable custody,
coordination and recovery. Use `@bsv/overlay-express/private-acquisition` for a
standalone router, or configure acquisition on an existing `OverlayExpress`.
These profiles require the SDK output-protocol implementation. Ordinary Overlay
Express imports and unconfigured legacy routes retain their supported SDK floor.
All installation is explicit; importing these helpers starts no listener, worker,
wallet operation or network broadcast.

## Responsibilities and original obligations

`PrivateServiceDomain` owns a seller/chain storage domain, its opaque indexes,
protected payloads and atomic ledger. All acquisition services for the same
seller and chain must use the same funding fence. Separating them into unrelated
stores would lose the cross-service single-output ownership guarantee. Keep the
index and payload custody keys, durable database and installed application scope
available across restarts. The protected-storage guide describes restoration,
capacity and custody requirements.

`PrivateAcquisitionContracts` verifies and retains the original selection and
signed challenge. `SQLitePrivateAcquisitionStore` reserves the whole original,
material, future progress and result allowance atomically before a challenge can
be offered. Permanent derivation-prefix and funding-output ownership survive
completion. A full store refuses a new quote before payment. The optional large
local ledger batch accommodates encrypted local records; it does not enlarge a
network packet. The complete eventual response, including encoded evidence and
context, must fit its selected wire limit.

The installed `PrivateAcquisitionDomain` supplies four operations. `prepare`
selects terms, listing evidence, verification context, schema, byte allowances
and private material. `validate` checks the asset, terms and material binding
after SDK Script and SPV verification of the listing. `isCurrent` decides whether
the installation remains authorized to fulfill an already retained obligation.
`issue` produces the result from that retained material and accepted right. It
must be pure or idempotent and must not charge again. Withdrawal from the current
catalogue and a new price do not rewrite an existing obligation.

`PrivateAcquisitionAccess` checks current buyer authorization within the native
storage guard. Remote identity, installed domain policy, release policy, actual
wallet ownership and permission to disclose are distinct decisions. A service
must not treat authentication alone as authorization for every stored asset.
A wrong buyer receives the same fixed missing-record result as an absent record.

`SDKPrivateAcquisitionFunding` verifies the submitted payment against the original
challenge, actual locking Script, output and selected chain context.
`SDKPrivateReleaseEvidence` checks the selected local acceptance, processor
attestation or mined acceptance policy. Mined acceptance requires a current,
independently installed immutable chain view and actual Script/Merkle proof
verification. Local acceptance time comes from a durable owner or is committed
atomically with its transition. A caller-provided timestamp or claimed block
height is not an acceptance verdict. The application installs these checks in
its `PrivateAcquisitionRelease.assess` port; an unresolved policy returns
`undefined` and leaves the original obligation pending.

`WalletToolboxAcquisitionFunding` adapts an actual durable Wallet Toolbox
`RecoverableFundingController`. It binds the installed wallet identity, storage
identity, original operation, transaction output and amount. The coordinator
records the pending operation and global output reservation before wallet work,
queries status first and retries only the same operation after definite absence.
An exception or lost reply means uncertainty, never permission to invent another
payment. After an exact accepted receipt, result bytes and delivered state commit
together. The production interface is structural; applications provide their
wallet controller explicitly.

## Install on an existing host

Construct custody, contracts, store, current access, immutable verification
context and domain/release/wallet ports first. The following composition accepts
those already installed dependencies; it intentionally does not substitute a
permissive domain policy or an in-memory payment receipt for them.

```typescript
import OverlayExpress from '@bsv/overlay-express'
import {
  PrivateAcquisitionCoordinator,
  PrivateAcquisitionDisclosure,
  type PrivateAcquisitionCoordinatorOptions,
  type PrivateServiceDomain
} from '@bsv/output-knowledge/private/node'

export function installAcquisition(
  host: OverlayExpress,
  custody: PrivateServiceDomain,
  options: PrivateAcquisitionCoordinatorOptions,
  authorizeControl: (buyer: string) => boolean
) {
  const coordinator = new PrivateAcquisitionCoordinator(options)
  const disclosure = new PrivateAcquisitionDisclosure(
    custody,
    options.store,
    options.contracts,
    options.access,
    options.clock,
    authorizeControl
  )
  const installed = options.contracts.configuration()
  host.configurePrivateAcquisition({
    identity: installed.seller,
    baseURL: installed.baseURL,
    service: coordinator,
    disclosure
  })
  return coordinator
}
```

Configure the host's server authentication wallet before `start()`. Its identity
must match the installed seller; an absent or mismatched wallet refuses startup
before routes are mounted. Acquisition, publication, live lookup, proposals,
root coordination and administration share the host authentication/session
instance when configured. Acquisition routes precede publication's private
namespace fallback and all ordinary JSON parsers. The two private profiles can
also be enabled separately. Changing private configuration after listening is
rejected.

For a standalone Express application, call `createPrivateAcquisitionRouter`
with the same service/disclosure, selected base URL and one shared
`createAuthMiddleware` instance. Mount it before generic body parsing or payload
logging. Only one companion should own `/.well-known/auth`; pass
`handleHandshake: false` on the others. Applications own the durable stores and
worker shutdown. Neither the host nor router manufactures domain permissions or
payment receipts.

## HTTP conversation

With a selected base URL ending in `/api`, the endpoints are
`POST /api/overlay/v1/private/acquire` and
`POST /api/overlay/v1/private/recover`. Requests use JSON, `Cache-Control:
no-store`, the exact selected `X-BSV-Overlay-Capability` digest and
`X-BSV-Overlay-Profile: https://bsv.brc.dev/overlays/0195#paid-lookup-v1` profile. Use the SDK's
`OUTPUT_PROFILES.acquisition` constant rather than copying a profile string.
BRC-103 authenticates both parties; pin the expected seller identity.

An unpaid acquire request contains the stable BRC-195 request ID, recipient,
service, listing, asset and terms selection. Persist the original request and
returned challenge before constructing a payment. Only an unpinned quote before
its construction deadline receives HTTP 402 with matching BRC-105 version,
satoshis and derivation-prefix headers. The transport supplies the signed seller
identity. The native final-send guard checks the buyer, seller, body, status,
selector and payment headers again after response signing.

Retry the same acquire request with the exact BRC-195 payment JSON in
`X-BSV-Payment`. The profile caps its Atomic BEEF at 65,536 decoded bytes and its
payment JSON header at 98,304 UTF-8 bytes. The acquisition-configured host selects
a 131,072-byte Node HTTP header allowance; the router also bounds aggregate header
names and values. Configure any reverse proxy consistently. Other hosts retain
their existing header allowance. Requests and responses remain bounded by both
the profile's four-MiB ceiling and the host's lower configured limits.

Use an authenticated client with automatic generic BRC-105 payments disabled
(`allowPayments: false` in `AuthFetch`). This profile owns the durable original
payment operation; a generic automatic retry must not create a second payment.
Keep mutual authentication required, pin the seller, omit browser credentials,
refuse redirects and preserve the raw signed body. SDK protocol parsers validate
responses; applications additionally enforce their original request/quote and
asset/terms binding before using returned private context. The dedicated durable
client composition is a separate integration layer.

Recovery sends only `{ "version": 1, "acquisitionId": "<original id>" }`.
It never accepts a payment header and never returns a new paid challenge. HTTP
200 can describe pending progress; only a `delivered` result carries the retained
material. A timely received payment pins an obligation even if verification or
wallet recovery finishes after the original recovery deadline. Funded undelivered
work cannot expire merely because issuance is temporarily unavailable.

Responses use `Cache-Control: private, no-store`. If permission or state changes
while a response is signed, the final native gate withholds it and permits only
one freshly authorized fixed error replacement. If control disclosure is also
no longer permitted, the connection closes without a body. Errors never serialize
private validator messages. Credential-free wildcard CORS remains the default;
origin allowlists are explicit deployment policy, not authorization.

## Recovery workers and shutdown

Install `PrivateAcquisitionWork` explicitly in the coordinator's `recovery`
option. Its local worker authority is distinct from buyer access and the domain's
authority to fulfill each original obligation. It enumerates bounded native pages
without sending payment or material bytes to a scheduler. Unsupported records are
reported as blocked; a cursor wrap discovers insertions behind the previous page.

`PrivateAcquisitionReconciler.runOnce()` advances one bounded page. Its opt-in
`start(intervalMs, observer)` returns an observable `done` promise and an async
`stop()` operation. Observe failures, keep diagnostic output private and bounded,
and stop new HTTP requests before stopping the worker. Await worker stop and
`coordinator.stop()` before closing custody or the wallet. Caller cancellation
and a request deadline do not prove physical wallet work has stopped; shutdown
waits for that work to settle. The worker recovers existing payments and expires
eligible unpaid quotes. It never constructs a fresh payment.

## Reproducible evidence and scope

The acquisition integration suite uses actual BRC-103 HTTP authentication,
protected SQLite custody and a real Wallet Toolbox SQLite credit/recovery
controller with synthetic transaction evidence and a trapped broadcast port. It
checks repeated recovery produces one wallet output/transaction. Host tests
exercise acquisition/publication composition, legacy lookup, origin ownership
and host byte ceilings. A seeded 300-case suite changes disclosure permissions
while signing; separate tests cover physical cancellation, crash/reopen, response
identity and retained obligations.

Build the same-head dependencies, then run the acquisition/private-host and
publication compatibility suites:

```sh
pnpm --filter @bsv/wallet-toolbox build
pnpm --filter @bsv/output-knowledge build
pnpm --filter @bsv/overlay-express build
pnpm --filter @bsv/overlay-express exec node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --watchman=false --testPathPatterns 'Private(Acquisition|Publication|OverlayHost)'
pnpm --filter @bsv/overlay-express pack:check
pnpm test:mutation --target private-acquisition-http
```

The governed `private-acquisition-http` target keeps
all acquisition/host and private-publication compatibility tests for every
whole-file mutation part. Local tests do not replace its full aggregate gate or
exact-head hosted CI. Concrete asset/LCH domain adapters, the durable buyer client,
on-chain purchase/POTATOES composition and complete program demonstrations remain
separate layers of the checkpoint-two implementation.
