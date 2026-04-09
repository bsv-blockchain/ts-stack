export default `
# WalletConfig Lookup Service Documentation

The WalletConfig Lookup Service is responsible for managing wallet configuration registrations and handling queries related to them.

## Query Capabilities

Users can query wallet configurations by:
- **configID**: Unique configuration identifier
- **name**: Configuration name (supports fuzzy search)
- **wab**: Wallet Authentication Backend URL
- **storage**: Wallet storage URL
- **messagebox**: Messagebox URL
- **registryOperators**: List all configurations from specific operators (required for all queries)

## Example Queries

### Query by configID
\`\`\`typescript
const answer = await lookupService.lookup({
  service: 'ls_walletconfig',
  query: {
    configID: 'my-wallet-config',
    registryOperators: ['operator1', 'operator2']
  }
})
\`\`\`

### Query by name
\`\`\`typescript
const answer = await lookupService.lookup({
  service: 'ls_walletconfig',
  query: {
    name: 'MyWallet',
    registryOperators: ['operator1']
  }
})
\`\`\`

### Query by WAB URL
\`\`\`typescript
const answer = await lookupService.lookup({
  service: 'ls_walletconfig',
  query: {
    wab: 'https://wab.example.com',
    registryOperators: ['operator1']
  }
})
\`\`\`

### List all configurations
\`\`\`typescript
const answer = await lookupService.lookup({
  service: 'ls_walletconfig',
  query: {
    registryOperators: ['operator1', 'operator2']
  }
})
\`\`\`

## Duplicate Prevention

The storage manager automatically prevents storing duplicate entries with identical field values, ensuring only unique configurations are maintained.
`
