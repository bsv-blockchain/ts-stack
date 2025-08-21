export default `# KVStore Lookup Service

The KVStore Lookup Service enables efficient querying of on-chain key-value pairs stored using the KVStore protocol. This service indexes KVStore tokens and provides fast lookups by protected key.

## Protocol Overview

KVStore tokens follow this field structure:
- Field 0: Public Key (32 bytes)
- Field 1: OP_CHECKSIG
- Field 2: Protected Key (32 bytes)
- Field 3: Value (variable length)
- Field 4: Signature from Field 0 over Fields 2-3
- Above 9: OP_DROP / OP_2DROP operations

## Supported Query Parameters

### protectedKey (string)
Base64-encoded protected key to search for. Returns all UTXOs containing data for this key.

### limit (number, default: 50)
Maximum number of results to return.

### skip (number, default: 0)
Number of results to skip for pagination.

### sortOrder ('asc' | 'desc', default: 'desc')
Sort direction based on creation time. 'desc' returns newest first.

### history (boolean, optional)
Whether to include historical chain tracking for the results.

## Example Queries

### Basic Protected Key Lookup
\`\`\`json
{
  "protectedKey": "dGVzdC1wcm90ZWN0ZWQta2V5LWV4YW1wbGU="
}
\`\`\`

### Paginated Results
\`\`\`json
{
  "protectedKey": "dGVzdC1wcm90ZWN0ZWQta2V5LWV4YW1wbGU=",
  "limit": 10,
  "skip": 20,
  "sortOrder": "asc"
}
\`\`\`

### With History Tracking
\`\`\`json
{
  "protectedKey": "dGVzdC1wcm90ZWN0ZWQta2V5LWV4YW1wbGU=",
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

The service returns a LookupFormula containing UTXO references:

\`\`\`json
[
  {
    "txid": "a1b2c3d4e5f6...",
    "outputIndex": 0
  },
  {
    "txid": "f6e5d4c3b2a1...",
    "outputIndex": 1
  }
]
\`\`\`

## Error Codes

- \`ERR_INVALID_QUERY\`: Query parameters are invalid or missing
- \`ERR_INSUFFICIENT_QUERY_PARAMS\`: Required query parameters not provided
- \`ERR_WRONG_NUMBER_OF_FIELDS\`: Token doesn't have the expected field count
- \`ERR_INVALID_KEY_LENGTH\`: Protected key is not 32 bytes

## Service Information

- **Service ID**: \`ls_kvstore\`
- **Topic**: \`kvstore\`
- **Admission Mode**: \`locking-script\`
- **Spend Notification Mode**: \`none\`
`
