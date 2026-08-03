import { UORA_ANCHOR_PREFIX } from './anchorFormat.js'

/**
 * What `tm_uora_dpp` serves to a consumer asking what it admits.
 *
 * Kept out of the class for the reason `message-box` keeps its own out: a page
 * of prose inside a method body is read as incidental, and this text is the
 * only description of the format most consumers will ever see.
 */
export default `UORA DPP Topic Manager: attestation anchors in the ${UORA_ANCHOR_PREFIX} format.

A 1-satoshi PushDrop output carrying, in order: the version prefix, the
SHA-256 digest of the attestation in lower-case hex, the attestation id,
the issuer's did:key, the subject passport id, the UORA attestation type,
and the anchoring service's identity key. An eighth field is a signature
by the key that locks the output, over those seven fields with each one
preceded by its length as a varint. The length prefixes are what commit
the signature to where every field ends, and not merely to the bytes they
run to when concatenated.

Admitted when all seven parse, the issuer resolves to a compressed
secp256k1 key, the signature checks out, and the locking key is the
BRC-42 child of field 6 at protocol [1, 'uora anchor v3'], key id the
attestation id, counterparty 'anyone'. That derivation is reproducible by
anyone holding the output, so it identifies the named service but proves
nothing on its own; the signature is the step needing that service's
private key, and so the step that makes an admitted anchor name its author.

uora-anchor-v2 is not admitted. Its signature covered the fields run
together, so the boundary between the subject and the type could be moved
by any holder while the signature still verified.

The issuer in field 3 is carried, not proved: whether that party made the
claim is settled by the attestation's own signature, which is off chain.

Anchors are leaves: never spent, nothing retained. Every valid anchor in a
transaction is admitted, so anchors may be batched.`
