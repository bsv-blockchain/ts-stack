export default `# BTMS Lookup Service

The BTMS Lookup Service enables efficient querying of on-chain BTMS (Basic Token Management System) tokens. This service indexes token outputs and provides flexible lookups by asset ID, owner key, or any combination.

## Protocol Overview

BTMS tokens use PushDrop locking scripts with the following field structure:
- Field 0: assetId ("ISSUE" for new tokens, or "txid.outputIndex" for existing assets)
- Field 1: amount (numeric string representing token quantity)
- Field 2: metadata (optional, UTF-8 string for token metadata)
- Field 3: signature (optional PushDrop signature when script was created with signing enabled)

The locking public key in the PushDrop script represents the token owner.

## Token Lifecycle

### Issuance
New tokens are created with assetId = "ISSUE". The lookup service converts this to the canonical format "txid.outputIndex" based on the transaction containing the issuance.

### Transfer
Existing tokens reference their asset by the canonical assetId format. The amount can be split across multiple outputs as long as the total doesn't exceed the input amounts.

### Burning
Tokens are burned when spent without creating corresponding outputs for that asset.

## Supported Query Parameters

### assetId (string, optional)
The asset identifier in "txid.outputIndex" format. Returns all UTXOs for this asset.

### ownerKey (string, optional)
Hex-encoded public key of the token owner. Returns all tokens owned by this key.

### limit (number, default: 50)
Maximum number of results to return.

### skip (number, default: 0)
Number of results to skip for pagination.

### sortOrder ('asc' | 'desc', default: 'desc')
Sort direction based on creation time. 'desc' returns newest first.

### history (boolean, optional)
Whether to include historical chain of spends for each token returned in the results.

## Query Behavior

- **Single Parameters**: \`assetId\` or \`ownerKey\` alone return arrays of all matching entries
- **Combined Parameters**: Multiple filters narrow results (AND logic)
- **No Parameters**: Returns all records (with pagination)

## Example Queries

### Find All Tokens for an Asset
\`\`\`json
{
  "assetId": "a1b2c3d4e5f6789...abc.0"
}
\`\`\`

### Find All Tokens by Owner
\`\`\`json
{
  "ownerKey": "02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c"
}
\`\`\`

### Paginated Results with History
\`\`\`json
{
  "assetId": "a1b2c3d4e5f6789...abc.0",
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
    "outputIndex": 0
  },
  {
    "txid": "f6e5d4c3b2a1...",
    "outputIndex": 1
  }
]
\`\`\`

When history is enabled, each result includes a history function that filters the token evolution chain to include only outputs matching the same assetId.

## Error Messages

- \`"A valid query must be provided"\`: Query is null, undefined, or missing
- \`"Lookup service not supported"\`: Service ID doesn't match \`ls_btms\`
- \`"BTMS token must have 2-4 fields..."\`: Token doesn't have expected field count
- \`"Invalid payload mode"\`: Admission mode doesn't match expected value

## Service Information

- **Service ID**: \`ls_btms\`
- **Topic**: \`tm_btms\`
- **Admission Mode**: \`locking-script\`
- **Spend Notification Mode**: \`none\`
`
