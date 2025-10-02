export default `# KVStore Lookup Service

The KVStore Lookup Service enables efficient querying of on-chain key-value pairs stored using the KVStore protocol. This service indexes KVStore tokens and provides flexible lookups by key, controller, protocolID, or any combination.

## Protocol Overview

KVStore tokens use PushDrop locking scripts with the following field structure:
- Field 0: protocolID (JSON-stringified WalletProtocol, e.g., "[1,\\"kvstore\\"]")
- Field 1: key (UTF-8 string)
- Field 2: value (UTF-8 string) 
- Field 3: controller (hex-encoded public key)
- Field 4: signature (PushDrop signature over fields 0-3)

## Supported Query Parameters

### key (string, optional)
The key to search for. Returns entries with this exact key across all controllers.

### controller (string, optional)
Hex-encoded public key of the controller. Returns all entries controlled by this public key.

### protocolID (WalletProtocol, optional)
Protocol identifier tuple, e.g., \`[1, "kvstore"]\`. Returns entries under this protocol.

### limit (number, default: 50)
Maximum number of results to return.

### skip (number, default: 0)
Number of results to skip for pagination.

### sortOrder ('asc' | 'desc', default: 'desc')
Sort direction based on creation time. 'desc' returns newest first.

### history (boolean, optional)
Whether to include historical chain of spends for each token returned in the results.

## Query Behavior

- **Single Parameters**: \`key\`, \`controller\`, or \`protocolID\` alone return arrays of all matching entries
- **Combined Parameters**: Multiple filters narrow results (AND logic)
- **Key + Controller**: Returns single result (most specific query)
- **No Parameters**: Returns all records (with pagination)

## Example Queries

### Find All Entries for a Key
\`\`\`json
{
  "key": "user-profile"
}
\`\`\`

### Find All Entries by Controller
\`\`\`json
{
  "controller": "0350fa50d7c23f63d949c9532f41a7ea0c01112ffb1404cfb8a9f732b11a54a1ce"
}
\`\`\`

### Find All Entries Under Protocol
\`\`\`json
{
  "protocolID": [1, "kvstore"]
}
\`\`\`

### Specific Key-Controller Lookup
\`\`\`json
{
  "key": "user-profile",
  "controller": "0350fa50d7c23f63d949c9532f41a7ea0c01112ffb1404cfb8a9f732b11a54a1ce"
}
\`\`\`

### Paginated Results with History
\`\`\`json
{
  "key": "user-settings",
  "limit": 10,
  "skip": 20,
  "sortOrder": "asc",
  "history": true
}
\`\`\`

### List All Records
\`\`\`json
{
  "limit": 100,
  "skip": 0
}
\`\`\`

## Response Format

The service returns a LookupFormula containing UTXO references with optional history functions:

\`\`\`json
[
  {
    "txid": "a1b2c3d4e5f6...",
    "outputIndex": 0,
    "history": "function() { ... }"
  },
  {
    "txid": "f6e5d4c3b2a1...",
    "outputIndex": 1,
    "history": "function() { ... }"
  }
]
\`\`\`

When history is enabled, each result includes a history function that filters the token evolution chain to include only outputs matching the same key and protocolID.

## Error Messages

- \`"A valid query must be provided"\`: Query is null, undefined, or missing
- \`"Lookup service not supported"\`: Service ID doesn't match \`ls_kvstore\`
- \`"KVStore token must have exactly X PushDrop fields..."\`: Token doesn't have expected field count
- \`"KVStore tokens must have a non-empty key"\`: Key field is missing or empty
- \`"KVStore tokens must have a non-empty value"\`: Value field is missing or empty  
- \`"Invalid KVStore token: signature verification failed"\`: PushDrop signature validation failed

## Service Information

- **Service ID**: \`ls_kvstore\`
- **Topic**: \`tm_kvstore\`
- **Admission Mode**: \`locking-script\`
- **Spend Notification Mode**: \`output-spent\`
`
