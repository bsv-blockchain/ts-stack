export default `
# TokenDemo Topic Manager Documentation

## Overview
The **TokenDemo Topic Manager** is an overlay protocol for creating, transferring, and managing fungible tokens on the BSV blockchain using BRC-48 Pay-to-Push-Drop outputs. Each eligible transaction output represents a token with a unique identifier, an amount, and optional custom metadata fields.

This protocol enables:
- **Token Minting**: Creating new tokens with custom properties
- **Token Transfers**: Moving tokens between parties with balance validation
- **Fungible Tokens**: Supporting any token type (store credits, loyalty points, etc.)
- **Custom Metadata**: Attaching arbitrary JSON metadata to tokens

## Protocol Specification

| Requirement | Description |
|-------------|-------------|
| **Protocol ID** | "TokenDemo" |
| **Fields** | Three fields: tokenId, amount, customFields |
| **Token ID** | UTF-8 string identifying the token type (or \`___mint___\` for new tokens) |
| **Amount** | Uint64LE representing the token quantity |
| **Custom Fields** | JSON object with arbitrary metadata |
| **Locking Script** | PushDrop output with OP_CHECKSIG for key ownership |
| **Balance Rule** | Sum of inputs must equal sum of outputs for each tokenId |

## Token Fields

### Field 0: Token ID (UTF-8 String)
Identifies the type of token being transferred. Two special cases:
- **Regular tokens**: A human-readable identifier (e.g., "Store Credits", "Loyalty Points")
- **Minting**: Use \`___mint___\` as the tokenId when creating new tokens. The actual tokenId becomes \`<txid>.<outputIndex>\` of the mint transaction

### Field 1: Amount (Uint64LE)
The quantity of tokens in this output, encoded as an unsigned 64-bit little-endian integer.

### Field 2: Custom Fields (JSON)
A JSON object containing arbitrary metadata about the token. Examples:
\`\`\`json
{
  "description": "Local Coffee Shop Credits",
  "issuer": "Main Street Cafe",
  "expiryDate": "2025-12-31"
}
\`\`\`

## Transaction Validation

The topic manager validates transactions by ensuring:

1. **PushDrop Format**: All outputs must be valid PushDrop structures with OP_CHECKSIG
2. **Balance Conservation**: For non-mint tokens, the sum of input amounts must equal the sum of output amounts for each tokenId
3. **Mint Transactions**: Outputs with tokenId \`___mint___\` create new tokens and are exempt from balance checks
4. **Token Lineage**: Regular tokens must reference valid token inputs or be newly minted

### Minting Example
To mint 1000 units of a new token:
\`\`\`
Inputs: [] (no token inputs required)
Outputs:
  - tokenId: "___mint___"
    amount: 1000
    customFields: {"name": "Store Credits"}
\`\`\`
Result: Token ID becomes \`<txid>.<outputIndex>\`

### Transfer Example
To transfer 100 tokens to another party:
\`\`\`
Inputs:
  - tokenId: "abc123.0"
    amount: 1000
Outputs:
  - tokenId: "abc123.0"
    amount: 100 (to recipient)
  - tokenId: "abc123.0"
    amount: 900 (change back to sender)
\`\`\`

## Error Handling

The topic manager will reject transactions that:
- Have unbalanced token amounts (inputs ≠ outputs for a given tokenId)
- Contain malformed PushDrop outputs
- Reference non-existent token inputs
- Have invalid field encodings

## Use Cases

- **Store Credits**: Businesses can issue redeemable credits
- **Loyalty Points**: Track customer rewards on-chain
- **Event Tickets**: Create transferable ticket tokens
- **Gift Cards**: Issue and transfer prepaid value
- **Internal Currency**: Company scrip or community tokens
`
