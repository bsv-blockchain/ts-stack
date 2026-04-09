export default `
# SupplyChain Lookup Service Documentation

The **SupplyChain Lookup Service** (service ID: \`ls_supplychain\`) lets clients search the on-chain *SupplyChain* messages that are indexed by the **SupplyChain Topic Manager**. Each record represents a Pay-to-Push-Drop output whose single field is a UTF-8 message of at least two characters.

## Example
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

// find all
const response2 = await overlay.query({ 
    service: 'ls_supplychain', 
    query: {} 
}, 10000)

// find all transactions that are part of some chainId
const response = await overlay.query({ 
    service: 'ls_supplychain', 
    query: {
        chainId: 'some chainId'
    } 
}, 10000)

// find 1 specific transaction by txid
const response3 = await overlay.query({ 
    service: 'ls_supplychain', 
    query: {
        txid: 'some txid'
    } 
}, 10000)
\`\`\`
`
