export default `
# MessageBox Lookup Service

The **MessageBox Lookup Service** is a SHIP-compatible overlay service that maps identity keys to MessageBox hosts. It enables identity-based message routing in the MessageBox ecosystem by resolving which hosts have been anointed to receive messages for a given identity.

---

## Overview

This service listens for advertisements broadcast to the \`tm_messagebox\` topic. Each advertisement contains a digitally signed payload that proves an identity key has anointed a particular host to receive its messages.

When queried, this service can return the list of hosts associated with an identity key, enabling clients to route messages dynamically based on the overlay network.

---

## Behavior

### On Output Addition

When an advertisement output is added, the following steps occur:

1. The output is decoded using [PushDrop] format.
2. The fields extracted include:
   - Identity Key
   - Host URL
   - ISO Timestamp
   - Nonce
   - Signature
3. The signature is validated to ensure the advertisement was authorized by the identity key.
4. The advertisement is saved to the internal database.

### On Output Spend or Deletion

When a matching output is spent or deleted, the associated advertisement is removed from the database.

---

## Lookup Support

### Service Name

\`ls_messagebox\`

### Query Format

\`\`\`json
{
  "service": "ls_messagebox",
  "query": {
    "identityKey": "<identity key string>"
  }
}
\`\`\`

### Response Format

\`\`\`json
{
  "type": "freeform",
  "result": {
    "hosts": ["https://host1.example.com", "https://host2.example.com"]
  }
}
\`\`\`

---

## Example Use

This lookup service can be queried by any SHIP-compatible client or directly from a frontend using the 'LookupResolver' class provided by \`@bsv/sdk\`.

---

## Configuration

No additional configuration is required beyond database connectivity. The service automatically listens for advertisements and maintains a list of known hosts.

---
`
