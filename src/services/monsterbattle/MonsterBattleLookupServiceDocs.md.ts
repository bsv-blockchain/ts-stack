export default `
# MonsterBattle Lookup Service Documentation

The **MonsterBattle Lookup Service** (service ID: \`ls_monsterbattle\`) lets clients search the on-chain *MonsterBattle* transactions that are indexed by the **MonsterBattle Topic Manager**. Each record represents either a bsv-21 (1sat) token or an orderlock transaction.

## Example
\`\`\`typescript
import { LookupResolver } from '@bsv/sdk'

const overlay = new LookupResolver()

// find all
const response2 = await overlay.query({ 
    service: 'ls_monsterbattle', 
    query: {} 
}, 10000)

// find by txid
const response3 = await overlay.query({ 
    service: 'ls_monsterbattle', 
    query: {
        txid: 'some txid'
    } 
}, 10000)
\`\`\`
`
