# Legacy certificate compatibility profile v1

This is an additive SDK wallet-wire extension for existing certificates, not a
new BRC-100 JavaScript method or a change to BRC-52 issuance. New signing and
both `acquireCertificate` protocols require canonical Base64 encoding of exactly
32 type bytes. Existing-certificate operations accept canonical Base64 encoding
of 1–128 bytes. The bound is an explicit compatibility/resource policy, not a
claim that historical SDKs imposed it or that signatures prove an issuance date.

## Application and storage boundaries

Public method names, argument/result shapes, permissions, originator handling,
serial-number lengths, keyring semantics and stored signatures are unchanged.
Apps and storage RPCs exchange original type strings and genuine signed fields.
Only binary substrate adapters construct and remove the transport metadata.
Historical verification reproduces the issuer's unpadded type bytes, field text
and stable locale-dependent ordering, with the original type/serial key ID.
Verification does not establish current revocation status.

Storage listing and proof require no new RPC, filter, column, or database
migration. Existing `relinquishCertificate` reference validation must accept the
same bounded historical types at the wallet manager and storage provider. Both
already delegate to the SDK reference validator; upgrading that SDK in each
runtime supplies the change. An old server still enforcing 32 bytes cannot
relinquish a legacy record, even when the app/wallet binary extension succeeds.

## Explicit per-request opt-in

The existing frame prefix remains `callCode:u8, originatorLength:u8,
originator:utf8, params`. IDs 1–28 retain their existing meaning.

Internal wire call **29** has two forms after the originator:

| Mode   | Bytes                       | Successful response including status byte |
| ------ | --------------------------- | ----------------------------------------- |
| Probe  | `00 01`                     | `00 01`                                   |
| Invoke | `01 01 operation:u8 params` | Existing operation response               |

The second byte is the profile version. Invoke permits only operations 18
(list), 19 (prove), 20 (relinquish), 21 and 22 (discovery). Reject unknown modes,
versions, nested envelopes, acquisition, non-certificate operations and trailing
probe bytes before invoking any wallet method. Probe invokes no wallet method.
Originator validation and all request/frame budgets apply normally.

The transceiver probes before unfiltered listing, discovery, or an operation
using a non-32-byte type, and caches the result per wire instance. It uses the
invoke envelope only when supported. A 32-byte filtered list, proof, or
relinquishment uses the original frame without probing. No connection-global
parser flag exists: profile selection is local to each request. Request data
is owned before awaiting negotiation, preventing caller mutation during a probe.

Only an explicit unsupported-action error or the historical unknown-call-29
error establishes an old endpoint. Malformed capability replies, authentication
failures and network errors propagate. Never retry a mutation or silently
switch transports. Recreate the client after upgrading an endpoint cached as
unsupported.

Canonical traffic remains interoperable with old endpoints. Legacy binary
operations require upgraded adapters at both ends. Old readers never receive
escaped records: if a plain response contains a legacy record, serialization
fails explicitly instead of hiding it, inventing pagination counts, or sending
metadata the reader cannot interpret. Existing all-canonical responses retain
their bytes. JSON substrates use original logical objects directly.

## Binary HTTP adapters

`HTTPWalletWire` maps internal call 29 to `POST /certificateCompatibility`,
with the usual `Origin` header and only the mode/version/operation/params in
the body. Wallet HTTP routers must register this internal transport endpoint
and reconstruct call code 29 plus the validated originator before passing the
frame to `WalletWireProcessor`. It is not a `WalletInterface` method. Registering
only the existing method-name routes is insufficient to enable this profile.

A 404 or 405 on the exact version-1 probe means the old router has no extension
endpoint; canonical operations continue on their original routes. Other HTTP
errors, malformed capability replies and transport failures propagate. A failed
invoke is never downgraded or retried. Legacy binary traffic requires both the
SDK processor and the wallet HTTP router update; installing only an app SDK
cannot add that server route. JSON listing continues to use its existing route
and original certificate objects.

## Constants

The marker is SHA-256 of UTF-8 `BSV wallet wire legacy certificate type v1`:

`JiQBZT2zOAmBpxBObV9OZN8xfnQVUchmRkCh6FcEV1M=`

The metadata field name is Base64(SHA-256(UTF-8
`BSV wallet wire legacy certificate metadata v1`)):

`4Oe/4ZEhACaZke7QFsgoLaJytNQ8Cg8165Yw6ybtLvg=`

The field name is 44 UTF-8 bytes, within the existing 50-byte limit. These are
public protocol constants, not secrets, keys, registry entries or type aliases.

## Request type slots

In the profile, ordinary type slots remain exactly 32 bytes. A non-32-byte type
is `marker:32, originalLength:VarInt, originalBytes`. The length is the decoded
byte count, 1–128, using the existing minimal unsigned VarInt encoding. Apply
this to every list filter type, the proof type slot, and the relinquishment type.
It does not require proof fields to be supplied.

An actual 32-byte type equal to the marker is escaped too, with length 32 and
those same marker bytes. Reject other length-32 escapes as non-canonical. On
the plain protocol the marker remains an ordinary literal 32-byte type.

## Complete certificate responses

For ordinary 32-byte types other than the marker, emit the existing
`CertificateBinary` unchanged. Otherwise replace only the transport copy's
type with the marker and set the metadata field to:

`Base64(UTF-8(JSON.stringify([1, originalTypeBase64, displacedFieldValue])))`

`displacedFieldValue` is null when the genuine certificate did not have that
field, or its exact original string when it did. This preserves a real signed
field instead of globally reserving its name. Existing field-count, field-value,
certificate and frame budgets include this transport overhead. Reject an
encoding exceeding those budgets; never truncate or discard genuine fields.

Read the ordinary certificate framing first. Within this profile only, a marker
type requires one valid metadata field and a supported original type. Restore
the original type, remove the metadata or restore the displaced field in the
same parsed position, then validate and return the logical certificate.
Maintaining that position matters for stable collation ties. Do not recursively
unwrap. Duplicate names and malformed UTF-8/DER remain errors in the core parser.

The phantom value is plaintext transport metadata. It is never encrypted, signed,
revealed, entered into a keyring, stored, or exposed to application logic.
The original type remains authenticated by the historical certificate signature
and its exact type/serial-derived signing key. Unsigned transport bytes must
never become a substitute signature preimage.

## Interoperability evidence

`fixtures/legacy-certificates.json` contains independently signed SDK 2.7.1
objects, unsigned preimage hex and expected v1 certificate/type-slot bytes.
The SDK codec suite consumes these portable vectors and tests tampering,
reserved-value collisions, malformed envelopes, resource bounds, downgrade
handling, concurrent calls and real BRC-103 certificate exchange. Wallet tests
exercise actual SQLite listing, proof/keyring decryption and relinquishment
through WalletClient and both binary adapters.
