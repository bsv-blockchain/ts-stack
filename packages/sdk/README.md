# BSV SDK

[![codecov](https://codecov.io/gh/bsv-blockchain/ts-stack/branch/main/graph/badge.svg?flag=sdk)](https://codecov.io/gh/bsv-blockchain/ts-stack)
[![npm version](https://badge.fury.io/js/@bsv%2Fsdk.svg)](https://badge.fury.io/js/@bsv%2Fsdk)
[![Build Status](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)

BSV BLOCKCHAIN | Software Development Kit for JavaScript and TypeScript

Welcome to the BSV Blockchain Libraries Project, the comprehensive TypeScript SDK designed to provide an updated and unified layer for developing scalable applications on the BSV Blockchain. This SDK addresses the limitations of previous tools by offering a fresh, peer-to-peer approach, adhering to SPV, and ensuring privacy and scalability.

For application-to-wallet integrations, the SDK exposes the BRC-100 `WalletClient` interface. BSV Desktop and BSV Browser are the BSV Association reference implementations for this interface; vendor distributions such as Babbage's Metanet Desktop / Metanet Explorer and Hudos Browser can implement the same interface with their own branding and service defaults.

The BRC-100 `CreateActionResult` permits AtomicBEEF as either `number[]` or
`Uint8Array`. SDK BRC-29 remittance accepts both wallet representations and
emits a portable `number[]` settlement artifact so HTTP, WebSocket, Message Box,
and JSON transports preserve identical transaction bytes. The same boundary
protects overlay lookup queries and JSON BEEF responses.

Version 2.8.0 verifies bodyless authenticated HTTP responses
using the BRC-104 `-1` body-length sentinel. Conforming 204 and empty error
responses now verify; non-empty response encoding is unchanged. Servers that
sign a zero body length for an empty response must adopt the specified sentinel.

AuthFetch stops pending certificate dispatch and session recovery after its
request deadline. An already dispatched request may still complete on the
server; callers must resolve its outcome before retrying a non-idempotent write.

AuthFetch's automatic BRC-105 payment path delegates spending authorization to
the configured wallet's `createAction` policy. Use a wallet that requires the
intended user or policy approval. Payment logs and terminal errors omit URL
credentials/path/query, header values other than `Content-Type`, transaction
bytes, and derivation material. Buffered received certificates are capped at
the most recent 1,000 entries. Simplified authenticated HTTP frames, bodies,
headers, signatures, request IDs, and certificate-request headers have fixed
size/count limits and redirects are rejected.

For signature payloads of at least 64 KiB, `ProtoWallet` uses asynchronous
platform SHA-256 when Web Crypto is available, avoiding long synchronous
hashing on browser UI threads. Unsupported or failed native hashing falls back
to the existing implementation using the same input snapshot. Short payloads,
explicit digests, signature bytes, and verification rules remain compatible.
No host registration or API migration is required. The additional portable
path measures 742,126 raw bytes in the SDK Vite fixture and 555,548 raw bytes
in UMD; their reviewed ceilings are 742,500 and 556,000 bytes respectively.
The combined sync and security candidate measures 560,560 raw bytes with esbuild;
its reviewed raw ceiling is 561,000 bytes. Compression ceilings are unchanged.

SDK 2.8.1 fixes portable AES-GCM decryption of authenticated empty plaintext.
Encryption bytes and full 16-byte tag verification are unchanged; invalid tags,
keys and IVs remain rejected.

SDK 2.8.2 separates wallet discovery timeouts from normal operations.
Automatic React Native and XDM discovery remains bounded, while subsequent
calls can wait for user approval without inheriting the one-second/200-millisecond
probe deadline. Explicit substrate `responseTimeout` values remain enforced.

The 2.8.3 candidate preserves the configured BRC100 originator in automatic
HTTP WalletWire discovery and binds the browser's default JSON `fetch` receiver.
It also restores negative `listActions` net amounts using their historical signed
int64 wire bytes, matching existing JSON validation. Counts, lengths and individual
output values remain unsigned and bounded.
Applications affected by these client defects can update their bundled SDK
without changing calls. Wallet upgrades continue to support the existing BRC100
contract; an ecosystem-wide application migration is not required. No API, wire
or account-data migration is required. Source 2.8.3 is not published until the
protected npm release workflow completes.

## Table of Contents

1. [Objective](#objective)
2. [Getting Started](#getting-started)
3. [Features & Deliverables](#features--deliverables)
4. [Documentation](#documentation)
5. [Development and Distribution](#development-and-distribution)
6. [Contribution Guidelines](#contribution-guidelines)
7. [Support & Contacts](#support--contacts)

## Objective

The BSV Blockchain Libraries Project aims to structure and maintain a middleware layer of the BSV Blockchain technology stack. By facilitating the development and maintenance of core libraries, it serves as an essential toolkit for developers looking to build on the BSV Blockchain.

## Getting Started

### Installation

To install the SDK, run:

```bash
npm install @bsv/sdk
```

### Basic Usage

Here's a simple example of using the SDK to create and sign a transaction:

```javascript
import { PrivateKey, P2PKH, Transaction, ARC } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')

const sourceTransaction = Transaction.fromHex(
  '0200000001849c6419aec8b65d747cb72282cc02f3fc26dd018b46962f5de48957fac50528020000006a473044022008a60c611f3b48eaf0d07b5425d75f6ce65c3730bd43e6208560648081f9661b0220278fa51877100054d0d08e38e069b0afdb4f0f9d38844c68ee2233ace8e0de2141210360cd30f72e805be1f00d53f9ccd47dfd249cbb65b0d4aee5cfaf005a5258be37ffffffff03d0070000000000001976a914acc4d7c37bc9d0be0a4987483058a2d842f2265d88ac75330100000000001976a914db5b7964eecb19fcab929bf6bd29297ec005d52988ac809f7c09000000001976a914c0b0a42e92f062bdbc6a881b1777eed1213c19eb88ac00000000'
)

const version = 1
const input = {
  sourceTransaction,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(privKey)
}
const output = {
  lockingScript: new P2PKH().lock(privKey.toAddress()),
  change: true
}

const tx = new Transaction(version, [input], [output])
await tx.fee()
await tx.sign()

await tx.broadcast()
```

For a more detailed tutorial and advanced examples, check our [Documentation](#documentation).

## Features & Deliverables

- **Sound Cryptographic Primitives**: Secure key management, signature computations, and encryption protocols.

- **Script Level Constructs**: Network-compliant script interpreter with support for custom scripts and serialization formats.

- **Transaction Construction and Signing**: Comprehensive transaction builder API, ensuring versatile and secure transaction creation.

- **Transaction Broadcast Management**: Mechanisms to send transactions to both miners and overlays, ensuring extensibility and future-proofing.

  `ARC` snapshots its URL, credentials, callback settings, deployment ID, and
  own custom headers when it is constructed. Reconstruct the broadcaster to
  rotate those values; later mutation of the supplied configuration has no
  effect. Custom headers must have valid HTTP token names and bounded,
  control-free string values. An injected `HttpClient` is application-trusted
  code and can select different transport behavior than the SDK defaults.
  Provider responses remain untrusted: single and batch acknowledgements must
  name the exact submitted transaction and a recognized ARC state before the
  SDK returns success.

  The Block Headers Service and What's On Chain trackers likewise accept only
  canonical roots, bounded heights, own-data provider records, and an exact
  confirmation for the requested root and height. Their configuration and API
  credentials are snapshotted at construction. A caller-supplied Block Headers
  Service URL and any injected `HttpClient` are explicit application trust
  decisions. Teranode's submission protocol supplies status rather than a
  returned transaction ID, so a successful HTTP status is authoritative only
  to the extent that the caller trusts the selected Teranode endpoint.

- **Merkle Proof Verification**: Tools for representing and verifying merkle proofs, adhering to various serialization standards.

  BUMP transaction offsets retain their exact nonnegative safe-integer domain,
  including positions above 32 bits. Root calculation, proof extraction,
  combination, and trimming use the same full-width arithmetic. Offsets outside
  that domain are rejected; no new wire format or application migration is needed.

- **Serializable SPV Structures**: Structures and interfaces for full SPV verification.

- **Secure Encryption and Signed Messages**: Enhanced mechanisms for encryption and digital signatures, replacing outdated methods.

- **P2P Authentication**: Robust peer-to-peer authentication mechanisms to ensure secure connections between parties.

  Authenticated HTTP handshakes register their response waiter before sending,
  and each authenticated request has a bounded 30-second response window. A
  client retains at most 1,000 pending authenticated requests. Invalid or
  rejected peer responses reject and clean up the owning request; they do not
  become unhandled process errors or leave listeners behind.

  Authenticated HTTP responses are streamed into a bounded buffer before they
  enter the signed-message parser. Application bodies default to 16 MiB and
  handshake bodies to 1 MiB; pass `maxResponseBytes` or
  `maxHandshakeResponseBytes` in `SimplifiedFetchTransportOptions` when a
  deployment needs a different ceiling. The parser also bounds header count
  and bytes and rejects truncated, overlong, or trailing wire data.

  For BRC-105 payments, a recipient may include the optional
  `x-bsv-payment-known-txids` response header on its 402 challenge. The value is
  a comma-separated list of 64-character hexadecimal transaction IDs the
  recipient already possesses and has validated. `AuthFetch` passes at most
  256 unique lowercase IDs to the wallet's `createAction` options, including
  when payment requirements change and a new transaction is created. This
  lets compatible wallets omit known ancestors from payment BEEF. Whitespace,
  duplicates, and malformed entries are ignored; an absent or invalid-only
  header preserves existing payment behavior. Browser services must expose
  the optional response header through their existing CORS policy.
  The header is an optional SDK extension, not a standardized BRC-105 header.

- **Identity**: Comprehensive identity management system supporting identity verification and certificate management.

- **Key Value Store**: Distributed key-value store for decentralized data storage and retrieval.

Identity publication rejects a certificate unless its certifier signature
verifies affirmatively. `GlobalKVStore` treats overlay responses as untrusted:
it requires a canonical, bounded controller-signed token whose locking key is
derived from the claimed controller, binds the exact BEEF output to the lookup
selector, and rejects ambiguous unique lookups or failed overlay acknowledgments.
Optional history follows only the selected controller's exact spent-output
lineage, excluding sibling outputs and unrelated funding ancestry. The configured
lookup resolver remains authoritative for which signed outpoints are current:
transaction inclusion and a field signature do not prove that an outpoint remains
unspent. Do not use a remotely resolved current value as the sole basis for an
authorization decision without independently verifying fresh active-state evidence.
`LocalKVStore` likewise authenticates the exact wallet-listed BEEF output,
wallet-derived locking key, and field signature before reading or spending it.

- **Distributed Storage**: Scalable and secure distributed data storage solutions to support blockchain applications.

  `StorageDownloader` treats overlay advertisements as untrusted. It requires
  the canonical six-field UHRP PushDrop token, host signature and derived
  locking-key linkage, exact requested hash, non-expired metadata, bounded
  ordinary or Atomic BEEF tied to the advertised output/transaction, and a
  credential-free public HTTPS location. Ordinary BEEF remains supported for
  existing lookup services; an additive transaction-ID hint, when supplied, is
  required to select the exact transaction in that bundle. The reusable
  `decodeAndVerifyUHRPAdvertisement()` export applies the same public-token
  validation for overlay and service implementations.

  Node.js public-network fetch helpers resolve, reject private/special-use
  addresses, and pin the approved address into the connection. Browser runtimes
  do not expose DNS resolution or connection pinning to JavaScript, so their
  fallback can validate URL syntax and literal IPs only. Browser applications
  must enforce private-network egress at a trusted proxy or service boundary;
  URL validation alone is not DNS-rebinding protection.

- **Wallet Interface**: Standardized interface for wallet operations, supporting multiple cryptocurrencies and protocols.

  A BRC-100 originator is permission-scoped by its lowercase DNS hostname.
  Callers may include a numeric port (including local-development ports), but
  the wallet deliberately treats every port on that hostname as the same
  originator. Schemes, credentials, paths, queries, fragments, IP literals,
  and malformed ports are not originator values.

- **Overlay Tools**: Advanced tools for overlay network management and optimization.

- **Distributed Protocol and Certificate Registration**: Efficient systems for registering and managing distributed protocols and certificates.

## Documentation

Comprehensive documentation is available in several formats:

- **[📚 Online Documentation](https://bsv-blockchain.github.io/ts-stack/packages/sdk/)**: Our complete documentation:
  - **[🚀 Get Started](https://bsv-blockchain.github.io/ts-stack/get-started/)**: Step-by-step lessons to learn by doing
  - **[🔧 How-To Guides](https://bsv-blockchain.github.io/ts-stack/guides/)**: Practical solutions to specific problems
  - **[📚 Reference](https://bsv-blockchain.github.io/ts-stack/reference/)**: Complete technical specifications and API documentation
  - **[🏗️ Architecture](https://bsv-blockchain.github.io/ts-stack/architecture/)**: Architecture and design explanations
- **[⚡ Examples](https://docs.bsvblockchain.org/guides/sdks/ts/examples)**: Practical code examples
- **Code Annotations**: The SDK is richly documented with code-level annotations that show up in editors like VSCode

## Development and Distribution

The workspace requires Node.js 24.11 or newer and pnpm 10. Install from the
repository root, then run the SDK's complete contract:

```bash
pnpm install
pnpm --filter @bsv/sdk format:check
pnpm --filter @bsv/sdk lint
pnpm --filter @bsv/sdk typecheck
pnpm --filter @bsv/sdk test:coverage
pnpm --filter @bsv/sdk pack:check
pnpm --filter @bsv/sdk test:browser
pnpm --filter @bsv/sdk test:resource
```

`test:resource` is not part of the PR suite: it allocates more than 500 MiB to
verify the AES-GCM 2^32-bit length boundary. Run it only on a suitable isolated
machine and record release evidence when AES-GCM length handling changes.

`pack:check` installs the exact generated tarball into ESM and CommonJS
consumer projects and verifies public exports and conditional type resolution.
`test:browser` independently bundles that tarball with Vite and esbuild,
rejects Node/server dependencies, validates source maps, and enforces measured
raw, gzip, and Brotli budgets. The package publishes ESM, CommonJS, and a
classic UMD bundle; TypeScript declarations are selected through matching
conditional exports.

Publishing is performed only by the repository release workflow after these
checks pass. Local development and validation must not rewrite versions or
publish artifacts.

## Contribution Guidelines

We're always looking for contributors to help us improve the SDK. Whether it's bug reports, feature requests, or pull requests - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `pnpm install` at the `ts-stack` repository root.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Run the package checks listed in
   [Development and Distribution](#development-and-distribution).
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.
   For more details, check the
   [repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md).

For information on past releases, check out the [changelog](./CHANGELOG.md). For future plans, check the [roadmap](./ROADMAP.md)!

## Support & Contacts

Project Owners: Thomas Giacomo and Darren Kellenschwiler

Development Team Lead: Ty Everett

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

TS Stack first-party material is under the [Open BSV License Version 6](./LICENSE.txt).
Incorporated material remains under the separate terms identified in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), with complete texts in
[LICENSES/](./LICENSES/). Keep all three payloads with source and binary distributions.

Thank you for being a part of the BSV Blockchain Libraries Project. Let's build the future of BSV Blockchain together!

## Certificate policy and observer callbacks

SDK 3.0 records the locally requested certificate policy for each BRC-103
session. Standalone responses must fit one complete locally recorded dynamic
request allowlist or the session's handshake allowlist. Policies are copied
before sending, so a later edit of the caller's object does not change
validation. Responses never select their own validation policy. A different
dynamic request cannot satisfy an unmet handshake requirement.

The legacy v0.1 `RequestedCertificateSet` has no all-of, any-of, threshold, or
optional-field expression. Compatibility validation therefore proves only that
each supplied certificate and each non-empty disclosed-field subset is allowed
by one locally recorded set. It does **not** prove that every listed certificate
type or every requested field was supplied. Each party chooses what to request,
what to provide, and how much to disclose. Before granting access, inspect the
actual certificate types, certifiers, and decrypted fields and enforce the
application's complete authorization policy. Terminate or constrain the
session or operation when those actual disclosures are insufficient; peer
authentication never declares the claims sufficient for the application.

The v0.1 AuthMessage fields, signatures and encodings are unchanged. Because a
certificateResponse does not echo the request nonce, concurrent responses are
matched against complete local requested sets, not individual request IDs. A
successful dynamic response consumes one matching request; failed validation
keeps it available for retry. Request the intended set explicitly instead of
relying on unrequested certificates.

An `initialRequest` is unsigned, and the v0.1 `initialResponse` signature binds
the nonce pair and identity but not its `requestedCertificates` or
`certificates` members. Built-in wallet proving encrypts revealed field keys to
the requested identity, but a `listenForCertificatesRequested` callback can
observe only a claimed identity during the initial exchange. Do not disclose
plaintext or authorize side effects from that callback. Because the requested
set is mutable, make every decision from the certificates and fields actually
disclosed and validated, never from the request alone. Prefer wallet-backed
proof creation, and use a signed post-authentication certificate request or an
application-layer integrity check when request integrity itself matters.

`listenForCertificatesReceived` is an observer. The SDK commits certificate
validation and releases its waiters before invoking listeners. A throwing or
rejecting listener stops later listeners and rejects message handling, but does
not roll back validation. The callback's third argument is the local session
nonce and its optional fourth argument is the peer nonce, allowing adapters to
bind application approval to the exact validated exchange; existing two-argument
callbacks remain compatible. Apply the requested certificate policy and
explicit application authorization before performing protected work.

Custom `AsyncSessionManager` implementations must retain the complete
`PeerSession`, including the optional local `certificatePolicy` and
`pendingCertificateRequests` fields. They are never serialized into AuthMessage.
Peer serializes its own certificate read-modify-write operations; shared stores
must also coordinate writers across instances. Older stored sessions without
these fields use the configured handshake policy.

BRC-103 message nonces are one-time values. The in-process `SessionManager`
atomically consumes each verified signed nonce, retains at most 10,000 sessions
for 30 minutes of idle time by default, and caps replay claims per session. At
capacity it evicts only unauthenticated sessions; if every slot is
authenticated, new handshakes fail until a session expires or is removed.
Session reads validate only the addressed session or identity bucket, avoiding
a global scan on every authenticated message. The unsigned initial-request
replay cache is also bounded; at capacity it evicts its oldest claim instead of
letting unauthenticated traffic globally disable new handshakes. Replay
protection for those unsigned requests is therefore bounded by both the
configured idle lifetime and cache cardinality. Signed per-session message
nonces continue to fail closed at their configured cap.
Shared `AsyncSessionManager` implementations must provide an atomic
`claimMessageNonce` and `claimInitialRequestNonce` backed by uniqueness
constraints or compare-and-set; Peer fails closed when an asynchronous store
omits either operation. Their unsigned initial-request cache should likewise
apply global and identity-scoped bounds, evicting the oldest claim at capacity
instead of failing all new handshakes. An incoming `initialRequest` only claims
an identity and creates a partial session. The requester becomes authenticated
only after a valid signed follow-up proves control of that key. Exact
initial-request replay is rejected before session, wallet, or callback work.

When `Peer` is allowed to remember a destination, only a successful locally
initiated handshake updates that implicit destination. Inbound messages cannot
retarget a later call that omits `identityKey`.

These controls authenticate peers and protect message integrity and freshness;
they do not encrypt the transport. Applications must use a confidential
transport such as correctly verified TLS and must separately authorize the
authenticated identity for every protected operation.
