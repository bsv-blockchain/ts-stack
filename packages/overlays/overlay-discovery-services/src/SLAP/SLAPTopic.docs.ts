export default `# SLAP Topic Manager

**Protocol Name**: SLAP (Service Lookup Availability Protocol)  
**Manager Name**: \`SLAPTopicManager\`  

---

## Overview

The SLAP Topic Manager is responsible for identifying valid SLAP outputs in transactions. These outputs advertise the availability of a **lookup service** that can be accessed within an overlay network. By publishing a SLAP token, a node declares it is providing a specific service, prefixed \`ls_\`.

---

## Purpose

- **Announce**: Declare that the identity key provides a certain lookup service, such as \`ls_example\` or other overlay lookups.
- **Availability**: Indicate that the node or service is currently active and can be queried via the provided URI.

---

## Requirements for a Valid SLAP Output

Similar to SHIP, SLAP tokens must follow a specific 5-field structure in a [PushDrop](https://www.npmjs.com/package/@bsv/sdk#pushdrop) script:

1. \`"SLAP"\` — The literal string indicating SLAP protocol.
2. \`identityKey\` — The public key that claims ownership of this advertisement.
3. \`advertisedURI\` — A valid URI, aligning with what is contemplated in BRC-101.
4. \`service\` — The name of the service. Must:
   - Pass the BRC-87 checks.
   - Start with \`ls_\`.
5. \`signature\` — The ECDSA signature from \`identityKey\` covering the above 4 fields.

---

## Signature and Locking Key

The final field is a signature that **must** link back to the identity key. The \`SLAPTopicManager\` uses the \`isTokenSignatureCorrectlyLinked\` code to confirm:

- The signature is valid for the data in the first four fields.
- The \`lockingPublicKey\` of the UTXO matches the derived key from the identity key used to sign.

If any step fails, the SLAP output is rejected.

---

## Data Format and Validation

1. **Exact 5 PushDrop Fields**:
   - If fewer or more than 5 fields are found, the SLAP manager will skip the output.
2. **Valid \`service\`**:
   - Must begin with \`ls_\`.
   - Only letters (lowercase) and underscores are allowed, per \`isValidTopicOrServiceName\` (BRC-87).
3. **Advertised URI**:
   - Must not be \`localhost\`.
   - Must use a recognized scheme (\`https://\`, \`wss://\`, or specialized custom \`https+bsvauth...\` forms).
4. **Signature**:
   - Must be in DER format.
   - Must match the identity key.

---

## Further Reading

- **SLAPLookupService**: For how to query these records afterward.
- **SHIP**: The complementary protocol for advertising "host-based" topics (\`tm_\`).
`
