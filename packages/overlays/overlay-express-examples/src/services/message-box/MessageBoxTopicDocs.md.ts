export default `
# MessageBox Topic Manager

The **MessageBox Topic Manager** defines SHIP overlay admittance rules for the \`tm_messagebox\` topic. It ensures that only properly signed and structured advertisements from identity keys are admitted into the overlay network.

---

## Overview

This Topic Manager is responsible for filtering and validating outputs that represent host advertisements. Each advertisement is a [PushDrop]-encoded output containing an identityKey, host URL, and a digital signature. The Topic Manager ensures that only valid advertisements signed by the advertising identity key are admitted.

---

## Output Admittance Criteria

To be admitted into the \`tm_messagebox\` topic, an output must:

1. Contain a valid PushDrop script with 3 fields:
   - Identity Key (UTF-8)
   - Host (UTF-8)
   - Signature (binary)
2. Have a valid signature that matches the concatenated data fields:
   \`\`\`
   data = identityKey + host
   \`\`\`
3. Be signed using protocol ID \`[0, "MBSERVEAD"]\` and key ID \`"1"\`.

If the signature is valid for the identity key, the output is added to the list of admissible outputs.

---

## Function: identifyAdmissibleOutputs

The core method of this manager, \`identifyAdmissibleOutputs(beef, previousCoins)\`, performs the following:

- Decodes each output in the given transaction.
- Validates each advertisement’s signature using \`ProtoWallet.verifySignature\`.
- Returns the list of output indexes that are valid for admittance.

---

## Example

This Topic Manager is used by overlay nodes during transaction processing to determine which outputs should be broadcast to participants or stored in lookup services.

---

## Metadata

- **Name**: MessageBox Topic Manager
- **Topic**: \`tm_messagebox\`
- **Short Description**: Advertises and validates hosts for message routing.

---

## Configuration

This topic manager requires no configuration beyond being registered for the \`tm_messagebox\` topic and having access to a functional ProtoWallet.

`
