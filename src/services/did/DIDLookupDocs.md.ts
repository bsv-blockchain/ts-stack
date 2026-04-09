export default `# DID Lookup Service Documentation

The DID Lookup Service is responsible for managing the rules of admissibility for DID tokens and handling queries related to them.

## Example
\`\`\`typescript
const didService = new DIDLookupService()
const answer = await didService.lookup({
  query: { outpoint: 'txid.vout' },
  service: 'ls_did'
})
console.log(answer)
\`\`\`
`
