export default `# KVStore Lookup Service

The KVStore Lookup Service enables efficient querying of on-chain key-value pairs stored using the KVStore protocol. This service indexes KVStore tokens and provides flexible lookups by key, controller, protocolID, tags, or any combination of those selectors.

## Protocol Overview

KVStore tokens use PushDrop locking scripts with the following field structure:
- Field 0: protocolID (JSON-stringified WalletProtocol, e.g., "[1,\\"kvstore\\"]")
- Field 1: key (UTF-8 string)
- Field 2: value (UTF-8 string) 
- Field 3: controller (hex-encoded public key)
- Field 4: optional tags (JSON string array)
- Field 5: signature (PushDrop signature over the preceding fields)

## Supported Query Parameters

Every query must include at least one selector: \`key\`, \`controller\`, \`protocolID\`, or a non-empty \`tags\` array. Pagination, ordering, and history options refine selector-based lookups and are not valid selectors by themselves.

### key (string, optional)
The key to search for. Returns entries with this exact key across all controllers.

### controller (string, optional)
Hex-encoded public key of the controller. Returns all entries controlled by this public key.

### protocolID (WalletProtocol, optional)
Protocol identifier tuple, e.g., \`[1, "kvstore"]\`. Returns entries under this protocol.

### tags (string[], optional)
Tags to search for. Empty tag arrays are not valid selectors.

### tagQueryMode ('all' | 'any', default: 'all')
Controls tag matching behavior when \`tags\` is supplied. \`all\` requires every supplied tag, while \`any\` requires at least one supplied tag.

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
- **Tags**: \`tags\` can be used alone or with other selectors; \`tagQueryMode\` controls whether all or any tags must match
- **Combined Parameters**: Multiple filters narrow results (AND logic)
- **Key + Controller**: Returns single result (most specific query)
- **Selector Required**: Empty, pagination-only, ordering-only, and empty-tag queries are rejected

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
  "controller": "02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c"
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
  "controller": "02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c"
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

### Find by Tags
\`\`\`json
{
  "tags": ["music", "rock"],
  "tagQueryMode": "all",
  "limit": 100
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
- \`"Must specify at least one selector: key, controller, protocolID, or tags"\`: Query lacks a valid selector
- \`"Lookup service not supported"\`: Service ID doesn't match \`ls_kvstore\`
- \`"KVStore token must have 5 fields (old format) or 6 fields (with tags)..."\`: Token doesn't have expected field count
- \`"KVStore tokens must have a non-empty key"\`: Key field is missing or empty
- \`"KVStore tokens must have a non-empty value"\`: Value field is missing or empty  
- \`"Invalid KVStore token: signature verification failed"\`: PushDrop signature validation failed

## Service Information

- **Service ID**: \`ls_kvstore\`
- **Topic**: \`tm_kvstore\`
- **Admission Mode**: \`locking-script\`
- **Spend Notification Mode**: \`output-spent\`
`
