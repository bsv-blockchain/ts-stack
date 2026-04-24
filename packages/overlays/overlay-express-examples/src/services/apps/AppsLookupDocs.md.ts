export default `# Apps Lookup Service Documentation

The **Apps Lookup Service** resolves on-chain PushDrop tokens that
represent published Metanet applications and answers catalog queries.

## Supported Query Parameters

| Parameter   | Type               | Description                                      |
|-------------|--------------------|--------------------------------------------------|
| \`name\`       | \`string\`          | Fuzzy-matched app name |
| \`domain\`     | \`string\`          | Exact match on the apps primary domain           |
| \`publisher\`  | \`string\`          | Identity key of the publisher that signed the token           |
| \`outpoint\`   | \`string\` (\`"txid.outputIndex"\`) | Direct UTXO reference                                    |
| \`limit\`      | \`number\` _(opt.)_ | Max documents to return for fuzzy name search           |

Queries may include **one** of the parameters above.  
The service identifier is **\`ls_apps\`**.
`
