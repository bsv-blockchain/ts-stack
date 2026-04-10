export default `
# TokenDemo Lookup Service Documentation

## Overview
The **TokenDemo Lookup Service** (service ID: \`ls_TokenDemo\`) enables clients to query and discover fungible tokens that are indexed by the **TokenDemo Topic Manager**. Each record represents a Pay-to-Push-Drop token output containing a tokenId, amount, and optional custom metadata fields.

This service allows applications to:
- Query tokens by specific UTXO outpoint
- Search for all instances of a particular tokenId
- Filter tokens by date ranges
- Paginate through large token sets
- Sort results chronologically

## Query Interface

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| \`outpoint\` | string | Specific UTXO to query (\`txid:outputIndex\` or \`txid.outputIndex\`) |
| \`tokenId\` | string | Filter by token identifier (e.g., "Store Credits" or "abc123.0") |
| \`limit\` | number | Maximum number of results to return (default: 100) |
| \`skip\` | number | Number of results to skip for pagination |
| \`sortOrder\` | 'asc' \| 'desc' | Sort by creation date (default: 'desc') |
| \`startDate\` | Date | Filter tokens created after this date |
| \`endDate\` | Date | Filter tokens created before this date |

### Response Format

Each token record contains:

\`\`\`typescript
{
  txid: string           // Transaction ID
  outputIndex: number    // Output index in transaction
  tokenId: string        // Token identifier
  amount: string         // Token quantity (as string to preserve precision)
  customFields?: Object  // Optional JSON metadata
  createdAt: Date        // Timestamp of token creation
}
\`\`\`

## Examples

### Query a Specific Token UTXO
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

const response = await overlay.query({
  service: 'ls_tokendemo',
  query: {
    outpoint: 'abc123def456...789:0'
  }
}, 10000)

// Response:
// {
//   txid: 'abc123def456...789',
//   outputIndex: 0,
//   tokenId: 'Store Credits',
//   amount: '1000',
//   customFields: { issuer: 'Main Street Cafe' },
//   createdAt: '2025-01-07T...'
// }
\`\`\`

### Find All Tokens of a Specific Type
\`\`\`typescript
const response = await overlay.query({
  service: 'ls_tokendemo',
  query: {
    tokenId: 'Store Credits',
    limit: 50,
    sortOrder: 'desc'
  }
}, 10000)

// Returns up to 50 most recent "Store Credits" tokens
\`\`\`

### Paginated Query with Date Filtering
\`\`\`typescript
const response = await overlay.query({
  service: 'ls_tokendemo',
  query: {
    tokenId: 'Loyalty Points',
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-12-31'),
    limit: 100,
    skip: 0
  }
}, 10000)

// Returns first 100 Loyalty Points tokens created in 2025
\`\`\`

### Track Token Lineage
\`\`\`typescript
// Query a minted token's original output
const mintQuery = await overlay.query({
  service: 'ls_tokendemo',
  query: {
    tokenId: 'abc123.0',  // Token ID derived from mint txid.outputIndex
    limit: 1
  }
}, 10000)

// Query all current UTXOs for this token type
const currentTokens = await overlay.query({
  service: 'ls_tokendemo',
  query: {
    tokenId: 'abc123.0'
  }
}, 10000)
\`\`\`

## Use Cases

- **Wallet Applications**: Query user's token balances
- **Token Explorers**: Browse all tokens of a specific type
- **Audit Systems**: Verify token supply and distribution
- **Analytics**: Track token creation and transfer patterns
- **Merchant Integration**: Verify customer token holdings
- **Portfolio Management**: Monitor multiple token types

## Error Handling

The lookup service may return errors for:
- Invalid outpoint format
- Non-existent tokens
- Malformed query parameters
- Timeout on large result sets

Always implement proper error handling and retry logic in production applications.
`
