---
release:
  "@bsv/sdk": patch
---
Initial-response certificate validation accepts a zero-field proof when the initiating Peer's retained
session request lists the certificate's type with an empty field array: the signed core, subject and
requested certifier and type are checked, the keyring must be empty, null or omitted, and nothing is
decrypted. validateCertificates gains an optional allowZeroFields argument, default false. An initial
response on a responder session or after the handshake keeps the nonempty path, standalone zero-field
responses stay refused, and a lost session snapshot is no longer backfilled from the mutable
certificatesToRequest.

## Migration

Zero-field certificate proofs: existing validateCertificates callers keep the nonempty path unless they pass
allowZeroFields true, which they should do only for a request they retained locally and bound to an
authenticated message. A zero-field proof carries no keyring for the verifier and the initial-response
signature does not cover certificates, so it shows that a valid certificate names the authenticated identity
as subject, not that the holder presented it; do not call decryptFields on such a certificate. Behaviour
change on the nonempty path: a session whose store lost its request snapshot no longer freezes a policy at
authentication time, so later standalone certificate responses on that session are checked against the Peer's
current certificatesToRequest. No API break, wire or stored-data change.
